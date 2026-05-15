import * as vscode from 'vscode';
import { getDebugSessionsForApp } from './debugSessionRegistry';
import { logInfo, logWarn } from './logger';
import { findAppForOpenedPath } from './packageSourceBrowser';

// Background:
//
// When the Package browser opens a `.ts` source served by vscode-js-debug, the URI is
// produced by `vscode.debug.asDebugSourceUri(source, session)`. For sources with a
// non-zero `sourceReference` (the common case for source-mapped files served from
// `sourcesContent`), the URI shape is `debug:<encoded-path>?session=<id>&ref=<n>`.
// Both the session id and the source reference are session-scoped — the SAME logical
// `.ts` file loaded in parent + child + worker sessions has different references in
// each session.
//
// VS Code only sends `setBreakpoints` to the session embedded in the URI's query when
// the user clicks the margin of a `debug:` URI editor. Children of that session do
// inherit breakpoints through vscode-js-debug's internal session manager, but the
// inheritance is best-effort and does not guarantee that every sibling worker thread
// receives a precisely-targeted binding. With CAP topologies that spawn many worker
// threads (Remote Process + N WorkerThreads), the breakpoint frequently fails to
// fire in the worker that actually executes the code — even though the runtime
// physically loaded the same source under a different reference.
//
// This module closes that gap. Whenever the user adds, removes, or edits a breakpoint
// on a URI opened via the Package browser, we query every app session's `loadedSources`
// to find that session's OWN `sourceReference` for the same file path, then issue a
// targeted `setBreakpoints` request to each session with its own descriptor and the
// current breakpoint set. Result: the breakpoint is bound everywhere the source lives,
// regardless of which worker the runtime ultimately picks.

interface DapSourceListResponse {
  sources?: { path?: unknown; sourceReference?: unknown }[];
}

interface DapSourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

const MIRROR_REQUEST_TIMEOUT_MS = 1_500;

let listener: vscode.Disposable | undefined;
const inFlightByKey = new Map<string, Promise<void>>();

export function initializePackageBreakpointMirror(): void {
  if (listener !== undefined) return;
  listener = vscode.debug.onDidChangeBreakpoints((event) => {
    void handleBreakpointChange(event);
  });
}

export function disposePackageBreakpointMirror(): void {
  listener?.dispose();
  listener = undefined;
  inFlightByKey.clear();
}

async function handleBreakpointChange(event: vscode.BreakpointsChangeEvent): Promise<void> {
  const affected = collectAffectedPathsByApp(event);
  if (affected.size === 0) return;

  const tasks: Promise<void>[] = [];
  for (const [appName, paths] of affected) {
    for (const path of paths) {
      const key = `${appName}::${path}`;
      // Serialize mirror operations per (app, path) — a fast add+remove burst would
      // otherwise race and leave the adapter with a stale breakpoint set.
      const previous = inFlightByKey.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => mirrorBreakpointsForPath(appName, path));
      inFlightByKey.set(key, next);
      tasks.push(next.finally(() => {
        if (inFlightByKey.get(key) === next) inFlightByKey.delete(key);
      }));
    }
  }
  await Promise.allSettled(tasks);
}

function collectAffectedPathsByApp(event: vscode.BreakpointsChangeEvent): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const consider = (bp: vscode.Breakpoint): void => {
    if (!(bp instanceof vscode.SourceBreakpoint)) return;
    const uri = bp.location.uri;
    // `file:` URIs are propagated by VS Code's native debug service via path matching
    // — no need to mirror them ourselves. Mirror only when the URI is one we minted
    // through the Package browser (typically `debug:` scheme).
    if (uri.scheme === 'file') return;
    const appName = findAppForOpenedPath(uri.path);
    if (appName === undefined) return;
    let set = result.get(appName);
    if (set === undefined) {
      set = new Set();
      result.set(appName, set);
    }
    set.add(uri.path);
  };
  event.added.forEach(consider);
  event.removed.forEach(consider);
  event.changed.forEach(consider);
  return result;
}

async function mirrorBreakpointsForPath(appName: string, path: string): Promise<void> {
  const sessions = getDebugSessionsForApp(appName);
  if (sessions.length === 0) return;

  const desired = collectDesiredBreakpoints(path);

  await Promise.allSettled(sessions.map(async (session) => {
    const sourceRef = await lookupSourceReferenceForPath(session, path);
    if (sourceRef === null) {
      // Adapter for this session has not loaded the source — nothing to bind here.
      return;
    }
    const descriptor: { path: string; sourceReference?: number } = { path };
    if (sourceRef > 0) descriptor.sourceReference = sourceRef;
    try {
      await session.customRequest('setBreakpoints', {
        source: descriptor,
        breakpoints: desired,
        sourceModified: false,
      });
      logInfo(`[BPMirror ${appName}] session=${session.id} setBreakpoints count=${desired.length.toString()} ref=${sourceRef.toString()} path=${path}`);
    } catch (err: unknown) {
      logWarn(`[BPMirror ${appName}] session=${session.id} setBreakpoints failed for ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));
}

function collectDesiredBreakpoints(path: string): DapSourceBreakpoint[] {
  const result: DapSourceBreakpoint[] = [];
  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!breakpoint.enabled) continue;
    if (breakpoint.location.uri.path !== path) continue;
    const descriptor: DapSourceBreakpoint = {
      line: breakpoint.location.range.start.line + 1,
      column: breakpoint.location.range.start.character + 1,
    };
    if (breakpoint.condition !== undefined && breakpoint.condition.length > 0) {
      descriptor.condition = breakpoint.condition;
    }
    if (breakpoint.hitCondition !== undefined && breakpoint.hitCondition.length > 0) {
      descriptor.hitCondition = breakpoint.hitCondition;
    }
    if (breakpoint.logMessage !== undefined && breakpoint.logMessage.length > 0) {
      descriptor.logMessage = breakpoint.logMessage;
    }
    result.push(descriptor);
  }
  return result;
}

async function lookupSourceReferenceForPath(
  session: vscode.DebugSession,
  path: string,
): Promise<number | null> {
  try {
    const response = await withTimeout(
      Promise.resolve(session.customRequest('loadedSources', {})) as Promise<DapSourceListResponse | undefined>,
      MIRROR_REQUEST_TIMEOUT_MS,
      undefined,
    );
    const sources = response?.sources;
    if (!Array.isArray(sources)) return null;
    for (const source of sources) {
      if (typeof source.path !== 'string' || source.path !== path) continue;
      const ref = typeof source.sourceReference === 'number' ? source.sourceReference : 0;
      // Return 0 explicitly when the source exists but is path-only — the caller still
      // wants to send the clear with `path` alone.
      return ref;
    }
    return null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(fallback);
    });
  });
}
