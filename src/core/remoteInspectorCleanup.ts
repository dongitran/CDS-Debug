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

  // Three breakpoint categories require different clear strategies:
  //
  // 1. Workspace `file://` paths — the user set the breakpoint on a local file. vscode-js-debug
  //    matches by path; sending `setBreakpoints({source:{path}, breakpoints:[]})` to the root
  //    session clears across the whole adapter (children share the source registry).
  //
  // 2. `debug:` URIs from `vscode.debug.asDebugSourceUri` — opened via Package browser when the
  //    `.ts` file does not exist locally. The URI carries both `?session=<id>` and `?ref=<n>`.
  //    VS Code sent the original `setBreakpoints` with **both** `source.path` AND
  //    `source.sourceReference`; per DAP spec the adapter binds by `sourceReference` when it
  //    is non-zero, so a path-only clear DOES NOT MATCH and the breakpoint persists in the
  //    Node inspector — exactly the bug the user reported requiring `cf restart`.
  //    We must mirror the original descriptor: `{path, sourceReference}` for the tagged
  //    session, and a path-only fallback for sibling sessions where the same source may
  //    have been propagated by `autoAttachChildProcesses`.
  //
  // 3. Anything else (rare) — best-effort clear by URI path.
  const sessions = collectAppSessions(appName, session);
  const appSessionIds = new Set(sessions.map((s) => s.id));
  const workspacePaths = new Set<string>();
  const debugBreakpoints: DebugUriBreakpointRecord[] = [];

  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!breakpoint.enabled) continue;
    const uri = breakpoint.location.uri;

    if (uri.scheme === 'file') {
      if (isInsideWorkspace(uri.fsPath)) workspacePaths.add(uri.fsPath);
      continue;
    }

    const taggedSessionId = extractDebugUriSessionId(uri);
    // Ignore breakpoints tagged with sessions we do not own — clearing third-party state as a
    // side effect of stopping a CDS Debug session would surprise users.
    if (taggedSessionId !== null && !appSessionIds.has(taggedSessionId)) continue;

    debugBreakpoints.push({
      breakpoint,
      // For non-file URIs `uri.path` is the canonical URL path (forward-slash). `fsPath` may
      // mangle separators on Windows, so prefer `path` when available.
      remotePath: uri.path && uri.path.length > 0 ? uri.path : uri.fsPath,
      sourceReference: extractDebugUriSourceReference(uri),
      taggedSessionId,
      scheme: uri.scheme,
    });
  }

  logBreakpointCleanupSummary(appName, sessions, workspacePaths, debugBreakpoints);

  const requests: Promise<boolean>[] = [];

  for (const path of [...workspacePaths].sort()) {
    requests.push(clearBreakpointsForSourceDescriptor(session, { path }));
  }

  for (const record of debugBreakpoints) {
    for (const target of sessions) {
      const isTaggedSession = record.taggedSessionId !== null && record.taggedSessionId === target.id;
      // `sourceReference` is only valid in the session that minted it; sending it to a
      // sibling would silently match the wrong (or no) source. Restrict the
      // path+sourceReference variant to the tagged session.
      if (isTaggedSession && record.sourceReference !== null && record.remotePath) {
        requests.push(clearBreakpointsForSourceDescriptor(target, {
          path: record.remotePath,
          sourceReference: record.sourceReference,
        }));
      }
      if (record.remotePath) {
        requests.push(clearBreakpointsForSourceDescriptor(target, { path: record.remotePath }));
      }
    }
  }

  if (requests.length > 0) {
    const results = await withTimeout(Promise.all(requests), CLEAR_BREAKPOINT_TOTAL_TIMEOUT_MS, []);
    const cleared = results.filter((result) => result).length;
    logInfo(`[${appName}] Pre-stop cleared breakpoints: ${cleared.toString()}/${requests.length.toString()} setBreakpoints request(s) succeeded across ${sessions.length.toString()} session(s).`);
  }

  // Drop the orphan debug-URI breakpoints from VS Code's own state. After Stop the URI's
  // `sourceReference` becomes unresolvable, the editor tab cannot load content, and the
  // user often cannot remove the breakpoint via the editor margin. Removing here keeps
  // VS Code's breakpoint list clean for the next session.
  if (debugBreakpoints.length > 0) {
    vscode.debug.removeBreakpoints(debugBreakpoints.map((record) => record.breakpoint));
    logInfo(`[${appName}] Removed ${debugBreakpoints.length.toString()} orphan debug-URI breakpoint(s) from VS Code state.`);
  }
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

interface DebugUriBreakpointRecord {
  breakpoint: vscode.SourceBreakpoint;
  remotePath: string;
  sourceReference: number | null;
  taggedSessionId: string | null;
  scheme: string;
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

function extractDebugUriSourceReference(uri: vscode.Uri): number | null {
  if (!uri.query) return null;
  try {
    const params = new URLSearchParams(uri.query);
    const raw = params.get('ref');
    if (raw === null) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : null;
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
  // Registry has not yet seen the session (e.g. external retry path that bypassed
  // trackStartedDebugSession). Fall back to the explicitly passed root session so the
  // clear is still attempted somewhere.
  return [fallback];
}

function logBreakpointCleanupSummary(
  appName: string,
  sessions: readonly vscode.DebugSession[],
  workspacePaths: ReadonlySet<string>,
  debugBreakpoints: readonly DebugUriBreakpointRecord[],
): void {
  logInfo(`[BreakpointCleanup ${appName}] sessions=${sessions.length.toString()} workspaceBp=${workspacePaths.size.toString()} debugUriBp=${debugBreakpoints.length.toString()}`);
  for (const record of debugBreakpoints) {
    const ref = record.sourceReference === null ? 'none' : record.sourceReference.toString();
    const tagged = record.taggedSessionId ?? 'untagged';
    logInfo(`[BreakpointCleanup ${appName}] scheme=${record.scheme} path=${record.remotePath} ref=${ref} taggedSession=${tagged}`);
  }
}

function isInsideWorkspace(sourcePath: string): boolean {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders === undefined || workspaceFolders.length === 0) return true;
  return workspaceFolders.some((folder) => {
    const rel = relative(folder.uri.fsPath, sourcePath);
    return rel.length === 0 || (!rel.startsWith('..') && !rel.startsWith('/'));
  });
}

interface DapSourceDescriptor {
  path?: string;
  sourceReference?: number;
}

async function clearBreakpointsForSourceDescriptor(
  session: vscode.DebugSession,
  source: DapSourceDescriptor,
): Promise<boolean> {
  // vscode-js-debug matches a setBreakpoints request to its source registry by
  // `sourceReference` first (when non-zero) and falls back to `path`. To clear a breakpoint
  // that was originally set with `sourceReference > 0`, the empty-breakpoints request must
  // mirror that descriptor — a path-only clear silently misses, leaving the inspector with
  // a stale breakpoint that survives the debug session.
  return withTimeout(
    Promise.resolve(session.customRequest('setBreakpoints', {
      source,
      breakpoints: [],
      sourceModified: false,
    })).then(
      () => true,
      (err: unknown) => {
        const descriptor = source.sourceReference !== undefined
          ? `ref=${source.sourceReference.toString()}${source.path ? ` path=${source.path}` : ''}`
          : `path=${source.path ?? '<none>'}`;
        logWarn(`[BreakpointCleanup] setBreakpoints([]) failed for ${descriptor}: ${err instanceof Error ? err.message : String(err)}`);
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
