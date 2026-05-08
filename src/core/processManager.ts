import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logInfo, logWarn, logError } from './logger';
import { removeLaunchConfigs } from './launchConfigurator';
import { cfSshEnabled, cfEnableSsh, cfRestartApp } from './cfClient';
import { openChromeDevTools } from './chromeDevTools';
import { getDebugPreferences } from '../storage/cacheStore';
import { cleanupPort, DEFAULT_PORT_FREE_TIMEOUT_MS, waitPortListening } from './portCleanup';
import { CF_SSH_SIGNAL_TIMEOUT_MS, isSshDisabledError, runCfSshSignal } from './cfSshSignal';

export const debugProcessEvents = new EventEmitter();

const processes = new Map<string, ChildProcess>();
// Keep ports independent from child processes because cf ssh can outlive cds-debug.
const debugPorts = new Map<string, number>();
const channels = new Map<string, vscode.OutputChannel>();
const sessionStates = new Map<string, { status: string; message?: string }>();
const activeDebugSessions = new Map<string, vscode.DebugSession>();
const sessionParams = new Map<string, { folderPath: string; port: number; launchConfigName: string }>();
// Prevents duplicate EXITED emits from child close and debug-session termination.
const stoppedApps = new Set<string>();
let sessionListener: vscode.Disposable | null = null;
let startListener: vscode.Disposable | null = null;
export const DEBUG_SESSION_PREFIX = 'Debug: ';
const activeVsCodeSessions = new Set<string>();

// Apps scheduled for auto-reconnect after an unexpected tunnel drop.
const reconnecting = new Set<string>();
const reconnectAttempts = new Map<string, number>();
const MAX_RECONNECT_ATTEMPTS = 3;
const TERMINATE_RECONNECT_GRACE_MS = 350;
const DISPOSE_ALL_PROCESSES_TIMEOUT_MS = 5_000;
// Tracks the current VS Code DebugSession.id per app to ignore stale terminate events.
const currentSessionIds = new Map<string, string>();
// Monotonic per-app version for ignoring stale async callbacks.
const lifecycleVersions = new Map<string, number>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

// VS Code's debug API is not safe for simultaneous attach requests.
let debugAttachQueue = Promise.resolve();

export type BeforeReconnectHook = (
  appName: string,
  params: { folderPath: string; port: number; launchConfigName: string },
) => Promise<void>;

let beforeReconnectHook: BeforeReconnectHook | undefined;

/**
 * Registers a callback invoked before each auto-reconnect attempt re-spawns the
 * tunnel and re-attaches VS Code. Used by the webview layer to refresh
 * launch.json so any cap-debug-config.json edits made between the original
 * Start and the reconnect are picked up. Pass `undefined` to clear.
 */
export function setBeforeReconnectHook(hook: BeforeReconnectHook | undefined): void {
  beforeReconnectHook = hook;
}

function bumpLifecycleVersion(appName: string): number {
  const next = (lifecycleVersions.get(appName) ?? 0) + 1;
  lifecycleVersions.set(appName, next);
  return next;
}

function getLifecycleVersion(appName: string): number {
  return lifecycleVersions.get(appName) ?? 0;
}

function isCurrentLifecycle(appName: string, lifecycleVersion: number): boolean {
  return getLifecycleVersion(appName) === lifecycleVersion;
}

function clearReconnectTimer(appName: string): void {
  const timer = reconnectTimers.get(appName);
  if (timer !== undefined) {
    clearTimeout(timer);
    reconnectTimers.delete(appName);
  }
}

// Kills the child process group on Unix so nested cf ssh processes terminate too.
function killProcessGroup(child: ChildProcess): void {
  const isWindows = process.platform === 'win32';
  if (!isWindows && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch (err: unknown) {
      logWarn(`Process group kill failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  child.kill();
}

async function cleanupDebugPort(appName: string, port: number): Promise<boolean> {
  const isFree = await cleanupPort(port, DEFAULT_PORT_FREE_TIMEOUT_MS);
  if (!isFree) {
    logWarn(`[${appName}] Port ${port.toString()} still appears occupied after cleanup timeout; proceeding.`);
  }
  return isFree;
}

export function getActiveSessions(): Record<string, { status: string; message?: string }> {
  return Object.fromEntries(sessionStates);
}

export function getSessionParams(appName: string): { folderPath: string; port: number; launchConfigName: string } | undefined {
  return sessionParams.get(appName);
}

export function getActiveDebugSessionForApp(appName: string): vscode.DebugSession | undefined {
  return activeDebugSessions.get(`${DEBUG_SESSION_PREFIX}${appName}`);
}

function sessionBelongsToApp(session: vscode.DebugSession, appName: string): boolean {
  const rootSessionName = `${DEBUG_SESSION_PREFIX}${appName}`;
  if (session.name === rootSessionName) return true;
  let parent = session.parentSession;
  while (parent) {
    if (parent.name === rootSessionName) return true;
    parent = parent.parentSession;
  }
  return false;
}

function sessionDepthWithinApp(session: vscode.DebugSession, appName: string): number {
  const rootSessionName = `${DEBUG_SESSION_PREFIX}${appName}`;
  let depth = 0;
  let current: vscode.DebugSession | undefined = session;
  while (current) {
    if (current.name === rootSessionName) return depth;
    current = current.parentSession;
    depth += 1;
  }
  return Number.MAX_SAFE_INTEGER;
}

export function getDebugSessionsForApp(appName: string): vscode.DebugSession[] {
  return Array.from(activeDebugSessions.values())
    .filter((session) => sessionBelongsToApp(session, appName))
    .sort((left, right) => sessionDepthWithinApp(left, appName) - sessionDepthWithinApp(right, appName));
}

export function getDebugSessionById(sessionId: string): vscode.DebugSession | undefined {
  return Array.from(activeDebugSessions.values()).find((session) => session.id === sessionId);
}

export function getProcessOutputChannel(appName: string): vscode.OutputChannel | undefined {
  return channels.get(appName);
}

export function getActiveAppNames(): string[] {
  return Array.from(sessionStates.keys());
}

async function emitExitedAndCleanup(appName: string, sessionName: string): Promise<void> {
  const p = processes.get(appName);
  if (p) {
    logInfo(`Debug session ${sessionName} stopped. Cleaning up SSH tunnel process...`);
    killProcessGroup(p);
    processes.delete(appName);
    channels.get(appName)?.appendLine('[Extension] Debug session terminated. Process killed.');
  }

  const port = debugPorts.get(appName);
  if (port !== undefined) {
    debugPorts.delete(appName);
  }

  stoppedApps.add(appName);
  sessionStates.delete(appName);
  debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    void removeLaunchConfigs(workspaceRoot, [appName]).catch((err: unknown) => {
      logWarn(`Failed to clean launch config for ${appName}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  if (port !== undefined) {
    await cleanupDebugPort(appName, port);
  }
}

function scheduleReconnect(
  appName: string,
  lifecycleVersion: number,
  trigger: 'session terminate' | 'child close',
): boolean {
  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return false;

  const attempts = (reconnectAttempts.get(appName) ?? 0) + 1;
  if (attempts > MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts.delete(appName);
    const limitMsg = `Reconnect limit reached (${MAX_RECONNECT_ATTEMPTS.toString()} attempts). Stopping.`;
    channels.get(appName)?.appendLine(`[Extension] ${limitMsg}`);
    logWarn(`[${appName}] Auto-reconnect exhausted after ${MAX_RECONNECT_ATTEMPTS.toString()} attempts.`);
    return false;
  }

  reconnectAttempts.set(appName, attempts);
  reconnecting.add(appName);
  const delayMs = 1500 * attempts;
  const reconnectMsg = trigger === 'session terminate'
    ? `Tunnel dropped (detected via session terminate). Reconnecting (${attempts.toString()}/${MAX_RECONNECT_ATTEMPTS.toString()})…`
    : `Tunnel dropped unexpectedly. Reconnecting (${attempts.toString()}/${MAX_RECONNECT_ATTEMPTS.toString()})…`;
  channels.get(appName)?.appendLine(`[Extension] ${reconnectMsg}`);
  logInfo(`[${appName}] ${reconnectMsg}`);
  sessionStates.set(appName, { status: 'TUNNELING' });
  debugProcessEvents.emit('statusChanged', { appName, status: 'TUNNELING' });

  clearReconnectTimer(appName);
  const timer = setTimeout(() => {
    reconnectTimers.delete(appName);
    void runReconnectAttempt(appName, lifecycleVersion, trigger);
  }, delayMs);
  reconnectTimers.set(appName, timer);
  return true;
}

async function runReconnectAttempt(
  appName: string,
  lifecycleVersion: number,
  trigger: 'session terminate' | 'child close',
): Promise<void> {
  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) {
    reconnecting.delete(appName);
    return;
  }
  const params = sessionParams.get(appName);
  if (!params) {
    reconnecting.delete(appName);
    return;
  }
  if (beforeReconnectHook !== undefined) {
    try {
      await beforeReconnectHook(appName, params);
    } catch (err: unknown) {
      // The hook is best-effort — failure leaves the existing launch.json in place,
      // which still contains the configuration written at the original Start.
      logWarn(`[${appName}] beforeReconnect hook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) {
    reconnecting.delete(appName);
    return;
  }
  // reconnecting stays set until ATTACHED/ERROR in probeTunnelAndAttach.
  startTunnelAndAttach(appName, params.folderPath, params.port, params.launchConfigName)
    .catch((err: unknown) => {
      reconnecting.delete(appName);
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[${appName}] Auto-reconnect (${trigger}) failed unexpectedly: ${msg}`);
      sessionStates.set(appName, { status: 'ERROR', message: msg });
      debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: msg });
    });
}

export function initializeProcessManager(): void {
  startListener ??= vscode.debug.onDidStartDebugSession((session) => {
    activeVsCodeSessions.add(session.name);
    activeDebugSessions.set(session.name, session);
    if (session.name.startsWith(DEBUG_SESSION_PREFIX)) {
      const appName = session.name.slice(DEBUG_SESSION_PREFIX.length);
      currentSessionIds.set(appName, session.id);
    }
  });

  sessionListener ??= vscode.debug.onDidTerminateDebugSession((session) => {
    void handleTerminatedDebugSession(session);
  });
}

async function handleTerminatedDebugSession(session: vscode.DebugSession): Promise<void> {
  // Non-CDS sessions: always remove from tracking, nothing else to do.
  if (!session.name.startsWith(DEBUG_SESSION_PREFIX)) {
    activeVsCodeSessions.delete(session.name);
    activeDebugSessions.delete(session.name);
    return;
  }

  const appName = session.name.slice(DEBUG_SESSION_PREFIX.length);

  // Ignore old terminate events after reconnect creates a new session with the same name.
  const currentId = currentSessionIds.get(appName);
  if (currentId !== undefined && currentId !== session.id) {
    logInfo(`[${appName}] Ignoring stale terminate event for old session ${session.id} (current: ${currentId}).`);
    return;
  }
  currentSessionIds.delete(appName);
  activeVsCodeSessions.delete(session.name);
  activeDebugSessions.delete(session.name);

  if (stoppedApps.has(appName)) return;

  if (reconnecting.has(appName)) {
    return;
  }

  const prevStatus = sessionStates.get(appName)?.status;
  if (prevStatus === 'ATTACHED') {
    const lifecycleVersion = getLifecycleVersion(appName);
    // Give child.on('close') a short window to claim reconnect first.
    setTimeout(() => {
      void (async (): Promise<void> => {
        if (!isCurrentLifecycle(appName, lifecycleVersion)) return;
        if (stoppedApps.has(appName) || reconnecting.has(appName)) return;
        if (!processes.has(appName)) {
          if (scheduleReconnect(appName, lifecycleVersion, 'session terminate')) return;
        }
        await emitExitedAndCleanup(appName, session.name);
      })();
    }, TERMINATE_RECONNECT_GRACE_MS);
    return;
  }

  await emitExitedAndCleanup(appName, session.name);
}

export async function stopProcess(appName: string, skipConfigCleanup = false, silent = false): Promise<void> {
  // Invalidate all pending async callbacks/timers from the current lifecycle first.
  bumpLifecycleVersion(appName);
  clearReconnectTimer(appName);
  const p = processes.get(appName);
  if (p) {
    logInfo(`Killing process group for ${appName} explicitly.`);
    killProcessGroup(p);
    processes.delete(appName);
    const channel = channels.get(appName);
    if (channel) {
      channel.appendLine('[Extension] Process group killed by explicit Stop request.');
    }
  }
  sessionParams.delete(appName);
  reconnecting.delete(appName);
  reconnectAttempts.delete(appName);
  currentSessionIds.delete(appName);
  const port = debugPorts.get(appName);
  if (port !== undefined) {
    debugPorts.delete(appName);
  }
  // Mark as stopped so downstream close/terminate events skip duplicate EXITED emit
  stoppedApps.add(appName);
  // Stop only sessions tied to this app, never unrelated debug sessions.
  stopActiveDebugSessionForApp(appName, skipConfigCleanup);
  sessionStates.delete(appName);
  if (!silent) {
    debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });
  }

  if (port !== undefined) {
    await cleanupDebugPort(appName, port);
  }
}

function stopActiveDebugSessionForApp(appName: string, skipConfigCleanup = false): void {
  const sessionName = `${DEBUG_SESSION_PREFIX}${appName}`;
  const session = activeDebugSessions.get(sessionName);
  if (session) {
    void vscode.debug.stopDebugging(session);
  }
  // Also explicitly clean launch.json for this specific app when manually stopped.
  if (!skipConfigCleanup) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      void removeLaunchConfigs(workspaceRoot, [appName]).catch((err: unknown) => {
        logWarn(`Failed to clean launch config for ${appName}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
}

export async function startTunnelAndAttach(appName: string, folderPath: string, port: number, launchConfigName: string): Promise<void> {
  initializeProcessManager();
  const lifecycleVersion = bumpLifecycleVersion(appName);
  clearReconnectTimer(appName);

  // Leave reconnecting set until ATTACHED/ERROR so old terminate events cannot win a reconnect.
  stoppedApps.delete(appName);

  let channel = channels.get(appName);
  if (!channel) {
    channel = vscode.window.createOutputChannel(`CDS: ${appName}`);
    channels.set(appName, channel);
  }
  channel.clear();

  // Pre-flight: free the local port before binding the SSH tunnel
  channel.appendLine(`[Extension] Ensuring port ${port.toString()} is free...`);
  logInfo(`[${appName}] Pre-flight: ensuring port ${port.toString()} is free…`);
  const portIsFree = await cleanupDebugPort(appName, port);
  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;
  if (portIsFree) {
    logInfo(`[${appName}] Port ${port.toString()} is free.`);
  } else {
    const portWarning = `Port ${port.toString()} still appears occupied after ${DEFAULT_PORT_FREE_TIMEOUT_MS.toString()}ms; proceeding.`;
    channel.appendLine(`[Extension] ${portWarning}`);
    logWarn(`[${appName}] ${portWarning}`);
  }

  sessionParams.set(appName, { folderPath, port, launchConfigName });

  // Send USR1 to activate the remote Node inspector before opening the tunnel.
  const signalCmd = `kill -s USR1 $(pidof node)`;
  channel.appendLine(`[Extension] Activating Node inspector on ${appName}: cf ssh ${appName} -c "${signalCmd}"`);
  logInfo(`[${appName}] Step 1: activating Node inspector via cf ssh (timeout ${(CF_SSH_SIGNAL_TIMEOUT_MS / 1000).toString()}s)…`);
  const signalResult = await runCfSshSignal(appName, signalCmd, channel);
  logInfo(`[${appName}] USR1 signal done (exit code: ${signalResult.exitCode?.toString() ?? 'null'}).`);

  if (isSshDisabledError(signalResult.stderr)) {
    channel.appendLine(`[Extension] SSH is disabled for ${appName}. Attempting to enable...`);
    logInfo(`[${appName}] SSH disabled — starting enable/restart flow.`);
    const enabled = await ensureSshEnabled(appName, channel);
    if (!enabled) {
      // Terminal ERROR path — clear reconnect guard so any pending
      // onDidTerminateDebugSession can emit EXITED normally.
      reconnecting.delete(appName);
      return;
    }
    if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;

    channel.appendLine(`[Extension] Retrying Node inspector activation after SSH enable...`);
    logInfo(`[${appName}] Retrying USR1 signal after SSH enable/restart.`);
    await runCfSshSignal(appName, signalCmd, channel);
    if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;
  }

  // Node needs a brief moment to open the WebSocket after USR1.
  await new Promise(r => setTimeout(r, 300));
  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;

  logInfo(`[${appName}] Step 2: opening SSH tunnel on port ${port.toString()}…`);
  spawnSshTunnel(appName, folderPath, port, launchConfigName, channel, lifecycleVersion);
}

async function ensureSshEnabled(appName: string, channel: vscode.OutputChannel): Promise<boolean> {
  const alreadyEnabled = await cfSshEnabled(appName);
  if (alreadyEnabled) {
    channel.appendLine(`[Extension] SSH is already enabled for ${appName} — may need a restart.`);
  } else {
    sessionStates.set(appName, { status: 'SSH_ENABLING' });
    debugProcessEvents.emit('statusChanged', { appName, status: 'SSH_ENABLING' });
    try {
      await cfEnableSsh(appName);
      channel.appendLine(`[Extension] SSH enabled for ${appName}. App restart required.`);
      logInfo(`[${appName}] SSH enabled successfully.`);
    } catch (err: unknown) {
      const msg = `Failed to enable SSH: ${err instanceof Error ? err.message : String(err)}`;
      channel.appendLine(`[Extension] ${msg}`);
      logError(`[${appName}] ${msg}`);
      sessionStates.set(appName, { status: 'ERROR', message: msg });
      debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: msg });
      return false;
    }
  }

  sessionStates.set(appName, { status: 'SSH_RESTARTING' });
  debugProcessEvents.emit('statusChanged', { appName, status: 'SSH_RESTARTING' });
  channel.appendLine(`[Extension] Restarting ${appName}... This may take up to 2 minutes.`);
  logInfo(`[${appName}] Restarting app after enabling SSH...`);

  try {
    await cfRestartApp(appName);
    channel.appendLine(`[Extension] ${appName} restarted successfully.`);
    logInfo(`[${appName}] App restarted — SSH should now be available.`);
    return true;
  } catch (err: unknown) {
    const msg = `App restart failed: ${err instanceof Error ? err.message : String(err)}`;
    channel.appendLine(`[Extension] ${msg}`);
    logError(`[${appName}] ${msg}`);
    sessionStates.set(appName, { status: 'ERROR', message: msg });
    debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: msg });
    return false;
  }
}

function spawnSshTunnel(
  appName: string,
  folderPath: string,
  port: number,
  launchConfigName: string,
  channel: vscode.OutputChannel,
  lifecycleVersion: number,
): void {
  const tunnelArg = `${port.toString()}:localhost:9229`;
  channel.appendLine(`[Extension] Opening SSH tunnel: cf ssh ${appName} -L ${tunnelArg}`);
  logInfo(`[Background] cf ssh ${appName} -L ${tunnelArg}`);

  const isWindows = process.platform === 'win32';
  const child = spawn('cf', ['ssh', appName, '-L', tunnelArg], {
    cwd: folderPath,
    shell: false,
    detached: !isWindows,
  });

  processes.set(appName, child);
  debugPorts.set(appName, port);
  sessionStates.set(appName, { status: 'TUNNELING' });
  debugProcessEvents.emit('statusChanged', { appName, status: 'TUNNELING' });

  child.stdout.on('data', (data: Buffer | string) => {
    channels.get(appName)?.append(data.toString());
  });

  child.stderr.on('data', (data: Buffer | string) => {
    const text = data.toString();
    channels.get(appName)?.append(text);
    if (text.toLowerCase().includes('address already in use') || text.toLowerCase().includes('permission denied')) {
      const errMsg = `Port ${port.toString()} is already in use or access was denied.`;
      logError(`[${appName}] ${errMsg}`);
      sessionStates.set(appName, { status: 'ERROR', message: errMsg });
      debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: errMsg });
    }
  });

  // cf ssh -L has no readiness line, so probe before attaching.
  void probeTunnelAndAttach(appName, port, launchConfigName, channel, lifecycleVersion);

  child.on('close', (code) => {
    channels.get(appName)?.appendLine(`\n[Extension] Process exited with code ${code?.toString() ?? 'null'}`);
    if (!isCurrentLifecycle(appName, lifecycleVersion)) return;
    if (processes.get(appName) === child) {
      processes.delete(appName);
    }
    if (stoppedApps.has(appName)) return;

    if (reconnecting.has(appName)) return;

    // Reconnect active sessions on likely CF SSH timeout or network interruption.
    const prevStatus = sessionStates.get(appName)?.status;
    if (prevStatus === 'ATTACHED') {
      if (scheduleReconnect(appName, lifecycleVersion, 'child close')) return;
    }

    if (!activeVsCodeSessions.has(launchConfigName)) {
      void emitExitedAndCleanup(appName, launchConfigName);
    }
  });

  child.on('error', (err) => {
    if (!isCurrentLifecycle(appName, lifecycleVersion)) return;
    channels.get(appName)?.appendLine(`\n[Extension] Failed to spawn cf ssh: ${err.message}`);
    // Clear reconnect guard immediately instead of waiting for the readiness timeout.
    reconnecting.delete(appName);
    sessionStates.set(appName, { status: 'ERROR', message: err.message });
    debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: err.message });
  });
}

async function probeTunnelAndAttach(
  appName: string,
  port: number,
  launchConfigName: string,
  channel: vscode.OutputChannel,
  lifecycleVersion: number,
): Promise<void> {
  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;
  const PROBE_INTERVAL_MS = 250;
  const configuredSecs = vscode.workspace.getConfiguration('cdsDebug').get('tunnelReadyTimeoutSeconds', 30);
  const TIMEOUT_MS = Math.max(10, Math.min(120, configuredSecs)) * 1000;
  logInfo(`[${appName}] Probing port ${port.toString()} (timeout ${(TIMEOUT_MS / 1000).toString()}s)…`);

  const isReady = await waitPortListening(
    port,
    TIMEOUT_MS,
    PROBE_INTERVAL_MS,
    () => isCurrentLifecycle(appName, lifecycleVersion) && !stoppedApps.has(appName),
  );

  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;

  if (!isReady) {
    const errMsg = `Tunnel on port ${port.toString()} did not become ready within ${(TIMEOUT_MS / 1000).toString()}s. Try increasing cdsDebug.tunnelReadyTimeoutSeconds in VS Code settings.`;
    logError(`[${appName}] ${errMsg}`);
    reconnecting.delete(appName);
    sessionStates.set(appName, { status: 'ERROR', message: errMsg });
    debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: errMsg });
    return;
  }

  channel.appendLine(`\n[Extension] Tunnel ready on port ${port.toString()}. Attaching VS Code debugger '${launchConfigName}'...`);
  logInfo(`Tunnel ready for ${appName} on port ${port.toString()}, attaching VS Code debugger...`);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  const currentQueue = debugAttachQueue;
  debugAttachQueue = currentQueue
    .then(async () => {
      if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return null;
      return vscode.debug.startDebugging(workspaceFolder, launchConfigName, { suppressSaveBeforeStart: true });
    })
    .then((success) => {
      if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;
      if (success) {
        reconnectAttempts.delete(appName);
        reconnecting.delete(appName);
        sessionStates.set(appName, { status: 'ATTACHED' });
        debugProcessEvents.emit('statusChanged', { appName, status: 'ATTACHED' });
        void vscode.window.showInformationMessage(`CDS Debug: debugger attached to ${appName}`);
        if (getDebugPreferences().openBrowserOnAttach) {
          void openChromeDevTools(port, appName);
        }
      } else {
        reconnecting.delete(appName);
        sessionStates.set(appName, { status: 'ERROR', message: 'Failed to start VS Code debugging.' });
        debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: 'Failed to start VS Code debugging.' });
      }
    })
    .catch((err: unknown) => {
      if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;
      const msg = err instanceof Error ? err.message : String(err);
      logError(`startDebugging error for ${appName}: ${msg}`);
      reconnecting.delete(appName);
      sessionStates.set(appName, { status: 'ERROR', message: msg });
      debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: msg });
    });
}

export async function stopAllProcesses(): Promise<void> {
  const activeAppNames = Array.from(sessionStates.keys());
  
  await Promise.allSettled(activeAppNames.map((appName) => stopProcess(appName, true)));

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot && activeAppNames.length > 0) {
    void removeLaunchConfigs(workspaceRoot, activeAppNames).catch((err: unknown) => {
      logWarn(`Failed to bulk clean launch configs: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

export async function disposeAllProcesses(): Promise<void> {
  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }
  reconnectTimers.clear();

  for (const p of processes.values()) {
    killProcessGroup(p);
  }
  processes.clear();

  const portsToCleanup = Array.from(debugPorts.values());
  debugPorts.clear();
  sessionStates.clear();
  activeDebugSessions.clear();
  stoppedApps.clear();
  sessionParams.clear();
  reconnecting.clear();
  reconnectAttempts.clear();
  currentSessionIds.clear();
  lifecycleVersions.clear();

  debugAttachQueue = Promise.resolve();

  const cleanupCompleted = await waitAllSettledWithTimeout(
    portsToCleanup.map((port) => cleanupPort(port, DEFAULT_PORT_FREE_TIMEOUT_MS)),
    DISPOSE_ALL_PROCESSES_TIMEOUT_MS,
  );
  if (!cleanupCompleted) {
    logWarn(`Timed out waiting for debug port cleanup during deactivate after ${DISPOSE_ALL_PROCESSES_TIMEOUT_MS.toString()}ms.`);
  }

  for (const channel of channels.values()) {
    channel.dispose();
  }
  channels.clear();

  if (sessionListener) {
    sessionListener.dispose();
    sessionListener = null;
  }
  if (startListener) {
    startListener.dispose();
    startListener = null;
  }
}

async function waitAllSettledWithTimeout<T>(promises: Promise<T>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) return true;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => { resolve('timeout'); }, timeoutMs);
    });
    const result = await Promise.race([Promise.allSettled(promises), timeout]);
    return result !== 'timeout';
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
