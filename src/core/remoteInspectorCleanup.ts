import * as vscode from 'vscode';
import { relative } from 'node:path';
import { cfRestartApp } from './cfClient';
import { scanForDebuggerLiterals, type DebuggerLiteralMatch } from './debuggerLiteralScanner';
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

  const sourcePaths = collectWorkspaceSourceBreakpointPaths();
  if (sourcePaths.length === 0) return;

  const requests = sourcePaths.map((sourcePath) => clearBreakpointsForSource(session, sourcePath));
  const results = await withTimeout(Promise.all(requests), CLEAR_BREAKPOINT_TOTAL_TIMEOUT_MS, []);
  const cleared = results.filter((result) => result).length;
  logInfo(`[${appName}] Pre-stop cleared breakpoints for ${cleared.toString()}/${sourcePaths.length.toString()} source file(s).`);
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

function collectWorkspaceSourceBreakpointPaths(): string[] {
  const paths = new Set<string>();
  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!breakpoint.enabled) continue;
    const sourcePath = breakpoint.location.uri.fsPath;
    if (!isInsideWorkspace(sourcePath)) continue;
    paths.add(sourcePath);
  }
  return [...paths].sort();
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
