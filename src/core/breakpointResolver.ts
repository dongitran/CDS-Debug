import * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';
import { DEBUG_SESSION_PREFIX } from './processManager';

// Debounce window after a `loadedSource` event before we re-send setBreakpoints.
// 100ms is short enough that the user does not perceive a delay but long enough
// to coalesce bursts when multiple scripts load at once (CAP serve init pattern).
const RE_RESOLVE_DEBOUNCE_MS = 100;

interface PendingReresolve {
  timer: ReturnType<typeof setTimeout>;
  paths: Set<string>;
}

const pendingBySession = new Map<string, PendingReresolve>();
let trackerRegistration: vscode.Disposable | undefined;

/**
 * Re-sends `setBreakpoints` for any user breakpoint whose source matches a
 * script that just loaded inside the running debug session.
 *
 * Workaround for microsoft/vscode-js-debug#1510 — vscode-js-debug occasionally
 * leaves breakpoints unbound when their target script is eagerly loaded before
 * `setBreakpoints` is processed. Re-issuing the request after `loadedSource`
 * with reason `new` reliably forces the adapter to re-evaluate placement.
 *
 * This is a layer-on-top workaround, not a fix for the underlying race in
 * vscode-js-debug. It is intentionally scoped to CDS Debug-managed sessions
 * (those whose name starts with the `Debug:` prefix).
 */
export function initializeBreakpointResolver(): void {
  if (trackerRegistration !== undefined) return;

  trackerRegistration = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
      if (!isCdsDebugSession(session)) return undefined;
      return {
        onDidSendMessage(message: unknown): void {
          const sourcePath = extractLoadedSourcePath(message);
          if (sourcePath === null) return;
          scheduleReresolve(session, sourcePath);
        },
      };
    },
  });
}

export function disposeBreakpointResolver(): void {
  trackerRegistration?.dispose();
  trackerRegistration = undefined;
  for (const pending of pendingBySession.values()) {
    clearTimeout(pending.timer);
  }
  pendingBySession.clear();
}

function isCdsDebugSession(session: vscode.DebugSession): boolean {
  if (session.name.startsWith(DEBUG_SESSION_PREFIX)) return true;
  let parent = session.parentSession;
  while (parent) {
    if (parent.name.startsWith(DEBUG_SESSION_PREFIX)) return true;
    parent = parent.parentSession;
  }
  return false;
}

function extractLoadedSourcePath(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  if (record.type !== 'event' || record.event !== 'loadedSource') return null;
  const body = record.body;
  if (typeof body !== 'object' || body === null) return null;
  const bodyRecord = body as Record<string, unknown>;
  if (bodyRecord.reason !== 'new') return null;
  const source = bodyRecord.source;
  if (typeof source !== 'object' || source === null) return null;
  const sourceRecord = source as Record<string, unknown>;
  return typeof sourceRecord.path === 'string' && sourceRecord.path.length > 0
    ? sourceRecord.path
    : null;
}

function scheduleReresolve(session: vscode.DebugSession, sourcePath: string): void {
  const existing = pendingBySession.get(session.id);
  if (existing !== undefined) {
    existing.paths.add(sourcePath);
    return;
  }
  const paths = new Set<string>([sourcePath]);
  const timer = setTimeout(() => {
    pendingBySession.delete(session.id);
    void runReresolve(session, paths);
  }, RE_RESOLVE_DEBOUNCE_MS);
  pendingBySession.set(session.id, { timer, paths });
}

async function runReresolve(session: vscode.DebugSession, paths: ReadonlySet<string>): Promise<void> {
  for (const sourcePath of paths) {
    const breakpoints = collectSourceBreakpoints(sourcePath);
    if (breakpoints.length === 0) continue;
    try {
      await session.customRequest('setBreakpoints', {
        source: { path: sourcePath },
        breakpoints,
        sourceModified: false,
      });
      logInfo(`[BreakpointResolver] re-resolved ${breakpoints.length.toString()} breakpoint(s) for ${sourcePath}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[BreakpointResolver] setBreakpoints failed for ${sourcePath}: ${message}`);
    }
  }
}

interface DapSourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

function collectSourceBreakpoints(sourcePath: string): DapSourceBreakpoint[] {
  const result: DapSourceBreakpoint[] = [];
  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!breakpoint.enabled) continue;
    if (breakpoint.location.uri.fsPath !== sourcePath) continue;
    const dap: DapSourceBreakpoint = {
      // DAP uses 1-based lines; vscode.Position is 0-based.
      line: breakpoint.location.range.start.line + 1,
      column: breakpoint.location.range.start.character + 1,
    };
    if (breakpoint.condition !== undefined && breakpoint.condition.length > 0) {
      dap.condition = breakpoint.condition;
    }
    if (breakpoint.hitCondition !== undefined && breakpoint.hitCondition.length > 0) {
      dap.hitCondition = breakpoint.hitCondition;
    }
    if (breakpoint.logMessage !== undefined && breakpoint.logMessage.length > 0) {
      dap.logMessage = breakpoint.logMessage;
    }
    result.push(dap);
  }
  return result;
}
