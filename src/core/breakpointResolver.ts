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

// Tracks which (session, file, line) breakpoints we have already nudged VS Code to
// re-verify, so the remove+add "poke" fires at most once per breakpoint per session —
// no repeated flicker. See `refreshBreakpointsForUiVerification`.
const uiVerifiedKeys = new Set<string>();

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
          logStackTraceSources(session, message);
          const sourcePath = extractLoadedSourcePath(message);
          if (sourcePath === null) return;
          scheduleReresolve(session, sourcePath);
        },
      };
    },
  });
}

// Diagnostic: when a session pauses on a breakpoint, VS Code requests `stackTrace` to
// populate the call-stack view. Each frame's `source` descriptor is what VS Code feeds
// into `asDebugSourceUri` to decide which editor URI to open. Logging it makes the
// "URI A vs URI B" mismatch debuggable from the extension log without instrumenting
// vscode-js-debug itself.
function logStackTraceSources(session: vscode.DebugSession, message: unknown): void {
  if (typeof message !== 'object' || message === null) return;
  const record = message as Record<string, unknown>;
  if (record.type !== 'response' || record.command !== 'stackTrace') return;
  const body = record.body;
  if (typeof body !== 'object' || body === null) return;
  const stackFrames = (body as { stackFrames?: unknown }).stackFrames;
  if (!Array.isArray(stackFrames)) return;
  for (const frame of stackFrames.slice(0, 5)) {
    if (typeof frame !== 'object' || frame === null) continue;
    const frameRecord = frame as { name?: unknown; line?: unknown; source?: unknown };
    const source = frameRecord.source;
    if (typeof source !== 'object' || source === null) continue;
    const sourceRecord = source as { path?: unknown; sourceReference?: unknown; name?: unknown };
    const path = typeof sourceRecord.path === 'string' ? sourceRecord.path : '<none>';
    const ref = typeof sourceRecord.sourceReference === 'number' ? sourceRecord.sourceReference : 0;
    const name = typeof sourceRecord.name === 'string' ? sourceRecord.name : '<none>';
    const frameName = typeof frameRecord.name === 'string' ? frameRecord.name : '<frame>';
    const line = typeof frameRecord.line === 'number' ? frameRecord.line : 0;
    logInfo(`[StackTrace] session=${session.id} frame="${frameName}" line=${line.toString()} source.name=${name} source.path=${path} source.ref=${ref.toString()}`);
  }
}

export function disposeBreakpointResolver(): void {
  trackerRegistration?.dispose();
  trackerRegistration = undefined;
  for (const pending of pendingBySession.values()) {
    clearTimeout(pending.timer);
  }
  pendingBySession.clear();
  uiVerifiedKeys.clear();
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
    // The `customRequest` above binds the breakpoint in the inspector (so execution
    // pauses), but VS Code only updates the gutter's verified state from its OWN
    // setBreakpoints round-trips — a customRequest never flips the dot from gray to red.
    // Now that the script has loaded (this runs on `loadedSource` reason=new), nudge VS
    // Code to re-send its own setBreakpoints by removing and re-adding the breakpoint.
    // Gated to once per (session, file, line) so it cannot flicker on repeated loads.
    refreshBreakpointsForUiVerification(session, sourcePath);
  }
}

// Force VS Code to re-issue its own `setBreakpoints` for matching `file:` breakpoints by
// removing and re-adding them. This is the only public API that updates the gutter's
// verified state; `customRequest` cannot. Scoped to `file:` URIs (debug: URIs are owned
// by the Package-browser breakpoint mirror) and to one poke per breakpoint per session.
function refreshBreakpointsForUiVerification(session: vscode.DebugSession, sourcePath: string): void {
  const toRefresh: vscode.SourceBreakpoint[] = [];
  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!breakpoint.enabled) continue;
    const uri = breakpoint.location.uri;
    if (uri.scheme !== 'file') continue;
    if (!filesystemPathsEqual(uri.fsPath, sourcePath)) continue;
    const key = uiVerificationKey(session.id, breakpoint);
    if (uiVerifiedKeys.has(key)) continue;
    uiVerifiedKeys.add(key);
    toRefresh.push(breakpoint);
  }
  if (toRefresh.length === 0) return;

  // Remove first, then add — adding an identical breakpoint while the original is still
  // present risks VS Code collapsing it by location, which would leave the old (unverified)
  // one in place. The package mirror uses the same ordering.
  const replacements = toRefresh.map((breakpoint) => new vscode.SourceBreakpoint(
    breakpoint.location,
    breakpoint.enabled,
    breakpoint.condition,
    breakpoint.hitCondition,
    breakpoint.logMessage,
  ));
  vscode.debug.removeBreakpoints(toRefresh);
  vscode.debug.addBreakpoints(replacements);
  logInfo(`[BreakpointResolver] UI re-verify: re-added ${toRefresh.length.toString()} file breakpoint(s) for ${sourcePath}`);
}

function uiVerificationKey(sessionId: string, breakpoint: vscode.SourceBreakpoint): string {
  const { start } = breakpoint.location.range;
  return `${sessionId}::${breakpoint.location.uri.fsPath}::${start.line.toString()}:${start.character.toString()}`;
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
    if (!filesystemPathsEqual(breakpoint.location.uri.fsPath, sourcePath)) continue;
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

/**
 * Compares two filesystem paths with platform-correct case sensitivity.
 *
 * VS Code's `Uri.fsPath` and the DAP `source.path` reported by vscode-js-debug
 * can differ in drive-letter casing on Windows (`C:\` vs `c:\`) even when they
 * resolve to the same file, so a strict `===` check would skip valid breakpoint
 * matches. macOS preserves casing in `fsPath`, and we keep the strict check on
 * Linux to avoid masking genuine path mismatches on a case-sensitive filesystem.
 */
function filesystemPathsEqual(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}
