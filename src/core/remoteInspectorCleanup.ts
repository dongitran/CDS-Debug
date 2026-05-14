import * as vscode from 'vscode';
import { relative } from 'node:path';
import { cfRestartApp } from './cfClient';
import { scanForDebuggerLiterals, type DebuggerLiteralMatch } from './debuggerLiteralScanner';
import { getDebugSessionsForApp } from './debugSessionRegistry';
import { logError, logInfo, logWarn, showLogChannel } from './logger';
import { incrementLocalTelemetryCounter } from './localTelemetry';
import { getRemoteInspectorCleanupSettings } from './remoteInspectorSettings';

const RESTART_ACTION = 'Restart App';
const DISABLE_ACTION = "Don't show again";
const OPEN_FIRST_MATCH_ACTION = 'Open First Match';
const SHOW_ALL_ACTION = 'Show All';
const IGNORE_SESSION_ACTION = 'Ignore for Session';
const REMOTE_INSPECTOR_REMINDER_DEBOUNCE_MS = 60_000;
const CLEAR_BREAKPOINT_REQUEST_TIMEOUT_MS = 500;
const CLEAR_BREAKPOINT_TOTAL_TIMEOUT_MS = 2_000;
const MAX_LOGGED_DEBUGGER_MATCHES = 20;

const lastReminderByApp = new Map<string, number>();
const debuggerWarningsByLifecycle = new Set<string>();

export async function handleRemoteInspectorAfterStop(appName: string): Promise<void> {
  const settings = getRemoteInspectorCleanupSettings();
  // Node cannot close an inspector listener from outside the process.
  if (settings.autoRestartAppAfterStop) {
    await restartAppAfterStop(appName);
    return;
  }
  await notifyRemoteInspectorStillOpen(appName);
}

export async function notifyRemoteInspectorStillOpen(appName: string): Promise<void> {
  const settings = getRemoteInspectorCleanupSettings();
  if (!settings.warnRemoteInspectorAfterStop) return;
  if (isReminderDebounced(appName)) return;

  lastReminderByApp.set(appName, Date.now());
  const choice = await vscode.window.showInformationMessage(
    `CDS Debug: Node inspector for ${appName} may remain open in Cloud Foundry until the app restarts.`,
    RESTART_ACTION,
    DISABLE_ACTION,
  );
  void incrementLocalTelemetryCounter('remoteInspectorReminderShown');
  logInfo(`[${appName}] Remote inspector reminder shown. Action: ${choice ?? 'dismissed'}.`);

  if (choice === RESTART_ACTION) {
    void incrementLocalTelemetryCounter('remoteInspectorRestartClicked');
    await restartAppAfterStop(appName);
    return;
  }
  if (choice === DISABLE_ACTION) {
    await vscode.workspace
      .getConfiguration('cdsDebug')
      .update('warnRemoteInspectorAfterStop', false, vscode.ConfigurationTarget.Global);
  }
}

export async function restartAppAfterStop(appName: string): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CDS Debug: restarting ${appName} to close the Node inspector...`,
      },
      async () => {
        await cfRestartApp(appName);
      },
    );
    logInfo(`[${appName}] App restarted after debug stop to close the remote inspector.`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${appName}] Failed to restart app after debug stop: ${message}`);
    await vscode.window.showWarningMessage(`CDS Debug: failed to restart ${appName}. Check the output channel for details.`);
  }
}

export async function clearBreakpointsBeforeStop(
  appName: string,
  session: vscode.DebugSession | undefined,
): Promise<void> {
  if (!getRemoteInspectorCleanupSettings().clearRemoteBreakpointsBeforeStop) return;
  if (session === undefined) return;

  // Split breakpoints by URI scheme:
  //  - Workspace `file://` paths can be cleared via the root session alone — vscode-js-debug
  //    propagates path-based breakpoints to all child sessions through its source registry.
  //  - `debug:` URIs come from Package browser opens. The remote Node inspector tracked the
  //    breakpoint under the encoded remote path (e.g. `/home/vcap/app/.../server.ts`) and, with
  //    `autoAttachChildProcesses: true`, that path may have been bound in any of the app's
  //    sessions. We broadcast the empty `setBreakpoints` to every session so the inspector
  //    forgets the breakpoint regardless of which session originally registered it.
  const collected = collectBreakpointSourcePaths(appName);
  const sessions = collectAppSessions(appName, session);
  const requests: Promise<boolean>[] = [];

  for (const path of collected.workspacePaths) {
    requests.push(clearBreakpointsForSource(session, path));
  }
  for (const path of collected.remotePaths) {
    for (const target of sessions) {
      requests.push(clearBreakpointsForSource(target, path));
    }
  }

  if (requests.length > 0) {
    const results = await withTimeout(Promise.all(requests), CLEAR_BREAKPOINT_TOTAL_TIMEOUT_MS, []);
    const cleared = results.filter((result) => result).length;
    logInfo(`[${appName}] Pre-stop cleared breakpoints for ${cleared.toString()}/${requests.length.toString()} setBreakpoints request(s) across ${sessions.length.toString()} session(s).`);
  }

  // Breakpoints on `debug:` URIs are tied to a specific debug session and become orphaned
  // the moment the session ends — the URI's `sourceReference` becomes unresolvable, the
  // tab can no longer load content, and the user often cannot remove the breakpoint via
  // the editor margin because the document body is no longer reachable. Drop them from
  // VS Code's breakpoint state proactively to prevent stale entries from accumulating and
  // re-triggering on the next session.
  removeOrphanedDebugUriBreakpoints(appName, sessions);
}

export async function scanAndWarnForDebuggerLiterals(
  appName: string,
  localRoot: string,
  lifecycleVersion: number,
  channel?: vscode.OutputChannel,
): Promise<void> {
  const settings = getRemoteInspectorCleanupSettings();
  if (!settings.warnDebuggerLiteralOnAttach) return;

  const warningKey = `${appName}:${lifecycleVersion.toString()}`;
  if (debuggerWarningsByLifecycle.has(warningKey)) return;
  debuggerWarningsByLifecycle.add(warningKey);

  const startedAt = Date.now();
  try {
    const matches = await scanForDebuggerLiterals(localRoot);
    const elapsedMs = Date.now() - startedAt;
    logInfo(`[${appName}] debugger literal scan found ${matches.length.toString()} match(es) in ${elapsedMs.toString()}ms.`);
    if (matches.length === 0) return;
    await showDebuggerLiteralWarning(appName, matches, channel);
  } catch (err: unknown) {
    logWarn(`[${appName}] debugger literal scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function showDebuggerLiteralWarning(
  appName: string,
  matches: DebuggerLiteralMatch[],
  channel: vscode.OutputChannel | undefined,
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `CDS Debug: ${matches.length.toString()} local source file line(s) contain debugger; and may pause ${appName} when any inspector client is attached.`,
    OPEN_FIRST_MATCH_ACTION,
    SHOW_ALL_ACTION,
    IGNORE_SESSION_ACTION,
  );
  void incrementLocalTelemetryCounter('debuggerLiteralWarningShown');

  if (choice === OPEN_FIRST_MATCH_ACTION) {
    await openDebuggerLiteralMatch(matches[0]);
    return;
  }
  if (choice === SHOW_ALL_ACTION) {
    logDebuggerLiteralMatches(appName, matches, channel);
  }
}

async function openDebuggerLiteralMatch(match: DebuggerLiteralMatch | undefined): Promise<void> {
  if (match === undefined) return;
  const document = await vscode.workspace.openTextDocument(match.filePath);
  const editor = await vscode.window.showTextDocument(document);
  const line = Math.max(0, match.line - 1);
  const range = new vscode.Range(line, 0, line, 0);
  editor.selection = new vscode.Selection(line, 0, line, 0);
  editor.revealRange(range);
}

function logDebuggerLiteralMatches(
  appName: string,
  matches: DebuggerLiteralMatch[],
  channel: vscode.OutputChannel | undefined,
): void {
  const lines = matches.slice(0, MAX_LOGGED_DEBUGGER_MATCHES).map((match) =>
    `${match.filePath}:${match.line.toString()} ${match.preview}`,
  );
  channel?.appendLine(`[Extension] ${appName} debugger; literal matches:`);
  for (const line of lines) {
    channel?.appendLine(`[Extension] ${line}`);
    logWarn(`[${appName}] debugger; literal: ${line}`);
  }
  showLogChannel();
}

function isReminderDebounced(appName: string): boolean {
  const lastShownAt = lastReminderByApp.get(appName);
  return lastShownAt !== undefined && Date.now() - lastShownAt < REMOTE_INSPECTOR_REMINDER_DEBOUNCE_MS;
}

interface CollectedBreakpointPaths {
  workspacePaths: string[];
  remotePaths: string[];
}

function collectBreakpointSourcePaths(appName: string): CollectedBreakpointPaths {
  const workspacePaths = new Set<string>();
  const remotePaths = new Set<string>();
  const appSessionIds = new Set(getDebugSessionsForApp(appName).map((session) => session.id));

  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!breakpoint.enabled) continue;
    const uri = breakpoint.location.uri;

    if (uri.scheme === 'file') {
      // Without a workspace, fall back to the legacy behavior of accepting every file URI:
      // the worst case is one redundant setBreakpoints request, which the adapter ignores.
      if (isInsideWorkspace(uri.fsPath)) workspacePaths.add(uri.fsPath);
      continue;
    }

    // `debug:` URIs are emitted by `vscode.debug.asDebugSourceUri` for source-reference-backed
    // sources (the common case when Package browser opens a `.ts` whose file is not present
    // locally). The `fsPath` getter on a non-file URI returns the decoded URI path component,
    // which for these URIs is the remote source path the inspector binds breakpoints by.
    if (uri.scheme === 'debug') {
      const sessionId = extractDebugUriSessionId(uri);
      // If the URI is tagged with a session we do not own, skip — clearing someone else's
      // breakpoint as a side effect of stopping a CDS Debug session would surprise users.
      if (sessionId !== null && !appSessionIds.has(sessionId)) continue;
      const remotePath = uri.path && uri.path.length > 0 ? uri.path : uri.fsPath;
      if (remotePath) remotePaths.add(remotePath);
    }
  }

  return {
    workspacePaths: [...workspacePaths].sort(),
    remotePaths: [...remotePaths].sort(),
  };
}

function extractDebugUriSessionId(uri: vscode.Uri): string | null {
  if (!uri.query) return null;
  try {
    const params = new URLSearchParams(uri.query);
    return params.get('session');
  } catch {
    return null;
  }
}

function collectAppSessions(
  appName: string,
  fallback: vscode.DebugSession,
): vscode.DebugSession[] {
  const tracked = getDebugSessionsForApp(appName);
  if (tracked.length > 0) return tracked;
  // Registry has not seen the session yet (e.g. an external retry path bypassed
  // trackStartedDebugSession). Fall back to the explicitly passed root session.
  return [fallback];
}

function removeOrphanedDebugUriBreakpoints(
  appName: string,
  appSessions: readonly vscode.DebugSession[],
): void {
  const appSessionIds = new Set(appSessions.map((session) => session.id));
  const orphans: vscode.SourceBreakpoint[] = [];

  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    const uri = breakpoint.location.uri;
    if (uri.scheme !== 'debug') continue;
    const sessionId = extractDebugUriSessionId(uri);
    // No tagged session → cannot prove it belongs to this app → leave it alone.
    if (sessionId === null) continue;
    if (!appSessionIds.has(sessionId)) continue;
    orphans.push(breakpoint);
  }

  if (orphans.length === 0) return;
  vscode.debug.removeBreakpoints(orphans);
  logInfo(`[${appName}] Removed ${orphans.length.toString()} orphan debug-URI breakpoint(s) from VS Code state.`);
}

function isInsideWorkspace(sourcePath: string): boolean {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders === undefined || workspaceFolders.length === 0) return true;
  return workspaceFolders.some((folder) => {
    const rel = relative(folder.uri.fsPath, sourcePath);
    return rel.length === 0 || (!rel.startsWith('..') && !rel.startsWith('/'));
  });
}

async function clearBreakpointsForSource(session: vscode.DebugSession, sourcePath: string): Promise<boolean> {
  return withTimeout(
    Promise.resolve(session.customRequest('setBreakpoints', {
      source: { path: sourcePath },
      breakpoints: [],
      sourceModified: false,
    })).then(
      () => true,
      (err: unknown) => {
        logWarn(`[BreakpointCleanup] setBreakpoints([]) failed for ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      },
    ),
    CLEAR_BREAKPOINT_REQUEST_TIMEOUT_MS,
    false,
  );
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
