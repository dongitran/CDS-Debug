import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logInfo, logWarn, logError } from './logger';
import { removeLaunchConfigs } from './launchConfigurator';
import { openChromeDevTools } from './chromeDevTools';
import { getDebugPreferences } from '../storage/cacheStore';
import { cleanupPort, DEFAULT_PORT_FREE_TIMEOUT_MS } from './portCleanup';
import { waitInspectorReady } from './inspectorReadyProbe';
import { CF_SSH_SIGNAL_TIMEOUT_MS, isSshDisabledError, runCfSshSignal } from './cfSshSignal';
import { registerActiveTunnel, unregisterActiveTunnel } from './orphanTunnelReaper';
import {
  clearBreakpointsBeforeStop,
  handleRemoteInspectorAfterStop,
  scanAndWarnForDebuggerLiterals,
} from './remoteInspectorCleanup';
import { getRemoteInspectorCleanupSettings } from './remoteInspectorSettings';
import { startTunnelKeepalive, type TunnelKeepaliveDispose } from './tunnelKeepalive';
import { waitAllSettledWithTimeout } from './asyncUtils';
import { buildInspectorSignalCommand } from './nodeInspectorSignal';
import { ensureSshEnabledForDebug, type SshEnableStatus } from './sshEnableFlow';
import {
  clearDebugSessionRegistry,
  DEBUG_SESSION_PREFIX,
  getActiveDebugSessionForApp,
  getDebugSessionById,
  getDebugSessionsForApp,
  hasActiveVsCodeSession,
  trackStartedDebugSession,
  untrackDebugSession,
} from './debugSessionRegistry';
import { incrementLocalTelemetryCounter } from './localTelemetry';

export {
  DEBUG_SESSION_PREFIX,
  getActiveDebugSessionForApp,
  getDebugSessionById,
  getDebugSessionsForApp,
};

export const debugProcessEvents = new EventEmitter();

const processes = new Map<string, ChildProcess>();
// Keep ports independent from child processes because cf ssh can outlive cds-debug.
const debugPorts = new Map<string, number>();
const channels = new Map<string, vscode.OutputChannel>();
const sessionStates = new Map<string, { status: string; message?: string }>();
const sessionParams = new Map<string, { folderPath: string; port: number; launchConfigName: string }>();
const keepaliveDisposables = new Map<string, TunnelKeepaliveDispose>();
const stoppedApps = new Set<string>();
let sessionListener: vscode.Disposable | null = null;
let startListener: vscode.Disposable | null = null;

const reconnecting = new Set<string>();
const reconnectAttempts = new Map<string, number>();
const MAX_RECONNECT_ATTEMPTS = 3;
const TERMINATE_RECONNECT_GRACE_MS = 350;
const DISPOSE_ALL_PROCESSES_TIMEOUT_MS = 5_000;
const currentSessionIds = new Map<string, string>();
const lifecycleVersions = new Map<string, number>();
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

let debugAttachQueue = Promise.resolve();

export type BeforeReconnectHook = (
  appName: string,
  params: { folderPath: string; port: number; launchConfigName: string },
) => Promise<void>;

export const BEFORE_RECONNECT_HOOK_TIMEOUT_MS = 3000;

let beforeReconnectHook: BeforeReconnectHook | undefined;

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

function disposeKeepalive(appName: string): void {
  keepaliveDisposables.get(appName)?.();
  keepaliveDisposables.delete(appName);
}

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

export function getProcessOutputChannel(appName: string): vscode.OutputChannel | undefined {
  return channels.get(appName);
}

export function getActiveAppNames(): string[] {
  return Array.from(sessionStates.keys());
}

function setSessionStatus(appName: string, status: SshEnableStatus, message?: string): void {
  const next = message === undefined ? { status } : { status, message };
  sessionStates.set(appName, next);
  debugProcessEvents.emit('statusChanged', { appName, status, message });
}

async function emitExitedAndCleanup(appName: string, sessionName: string): Promise<void> {
  disposeKeepalive(appName);
  const p = processes.get(appName);
  if (p) {
    logInfo(`Debug session ${sessionName} stopped. Cleaning up SSH tunnel process...`);
    killProcessGroup(p);
    processes.delete(appName);
    void unregisterActiveTunnel(appName);
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

  await handleRemoteInspectorAfterStop(appName);
}

function scheduleReconnect(
  appName: string,
  lifecycleVersion: number,
  trigger: 'session terminate' | 'child close' | 'keepalive',
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
  const reconnectMsg = reconnectMessage(trigger, attempts);
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

function reconnectMessage(
  trigger: 'session terminate' | 'child close' | 'keepalive',
  attempts: number,
): string {
  const suffix = `Reconnecting (${attempts.toString()}/${MAX_RECONNECT_ATTEMPTS.toString()})…`;
  if (trigger === 'session terminate') return `Tunnel dropped (detected via session terminate). ${suffix}`;
  if (trigger === 'keepalive') return `Inspector keepalive failed repeatedly. ${suffix}`;
  return `Tunnel dropped unexpectedly. ${suffix}`;
}

async function runHookWithTimeout(
  hook: BeforeReconnectHook,
  appName: string,
  params: { folderPath: string; port: number; launchConfigName: string },
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`beforeReconnect hook timed out after ${BEFORE_RECONNECT_HOOK_TIMEOUT_MS.toString()}ms`));
    }, BEFORE_RECONNECT_HOOK_TIMEOUT_MS);
  });
  try {
    await Promise.race([hook(appName, params), timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

async function runReconnectAttempt(
  appName: string,
  lifecycleVersion: number,
  trigger: 'session terminate' | 'child close' | 'keepalive',
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
  await clearBreakpointsForApp(appName);
  if (beforeReconnectHook !== undefined) {
    try {
      await runHookWithTimeout(beforeReconnectHook, appName, params);
    } catch (err: unknown) {
      logWarn(`[${appName}] beforeReconnect hook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) {
    reconnecting.delete(appName);
    return;
  }
  startTunnelAndAttach(appName, params.folderPath, params.port, params.launchConfigName)
    .catch((err: unknown) => {
      reconnecting.delete(appName);
      const msg = err instanceof Error ? err.message : String(err);
      logError(`[${appName}] Auto-reconnect (${trigger}) failed unexpectedly: ${msg}`);
      sessionStates.set(appName, { status: 'ERROR', message: msg });
      debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: msg });
    });
}

async function clearBreakpointsForApp(appName: string): Promise<void> {
  try {
    await clearBreakpointsBeforeStop(appName, getActiveDebugSessionForApp(appName));
  } catch (err: unknown) {
    logWarn(`[${appName}] Pre-stop breakpoint clear failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function initializeProcessManager(): void {
  startListener ??= vscode.debug.onDidStartDebugSession((session) => {
    trackStartedDebugSession(session);
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
  if (!session.name.startsWith(DEBUG_SESSION_PREFIX)) {
    untrackDebugSession(session);
    return;
  }

  const appName = session.name.slice(DEBUG_SESSION_PREFIX.length);

  const currentId = currentSessionIds.get(appName);
  if (currentId !== undefined && currentId !== session.id) {
    logInfo(`[${appName}] Ignoring stale terminate event for old session ${session.id} (current: ${currentId}).`);
    return;
  }
  currentSessionIds.delete(appName);
  untrackDebugSession(session);

  if (stoppedApps.has(appName)) return;

  if (reconnecting.has(appName)) {
    return;
  }

  const prevStatus = sessionStates.get(appName)?.status;
  if (prevStatus === 'ATTACHED') {
    const lifecycleVersion = getLifecycleVersion(appName);
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

export async function stopProcess(
  appName: string,
  skipConfigCleanup = false,
  silent = false,
  suppressRemoteInspectorNotice = false,
): Promise<void> {
  bumpLifecycleVersion(appName);
  clearReconnectTimer(appName);
  // Mark before async DAP cleanup so a fast Stop -> Start can delete this marker
  // after the new lifecycle starts instead of having this stop path poison it.
  stoppedApps.add(appName);
  disposeKeepalive(appName);
  await clearBreakpointsForApp(appName);
  const p = processes.get(appName);
  if (p) {
    logInfo(`Killing process group for ${appName} explicitly.`);
    killProcessGroup(p);
    processes.delete(appName);
    void unregisterActiveTunnel(appName);
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
  stopActiveDebugSessionForApp(appName, skipConfigCleanup);
  sessionStates.delete(appName);
  if (!silent) {
    debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });
  }

  if (port !== undefined) {
    await cleanupDebugPort(appName, port);
  }

  if (!silent && !suppressRemoteInspectorNotice) {
    await handleRemoteInspectorAfterStop(appName);
  }
}

function stopActiveDebugSessionForApp(appName: string, skipConfigCleanup = false): void {
  const session = getActiveDebugSessionForApp(appName);
  if (session) {
    void vscode.debug.stopDebugging(session);
  }
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

  stoppedApps.delete(appName);

  let channel = channels.get(appName);
  if (!channel) {
    channel = vscode.window.createOutputChannel(`CDS: ${appName}`);
    channels.set(appName, channel);
  }
  channel.clear();

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

  const signalCmd = buildInspectorSignalCommand();
  channel.appendLine(`[Extension] Activating Node inspector on ${appName}: cf ssh ${appName} -c "${signalCmd}"`);
  logInfo(`[${appName}] Step 1: activating Node inspector via cf ssh (timeout ${(CF_SSH_SIGNAL_TIMEOUT_MS / 1000).toString()}s)…`);
  const signalResult = await runCfSshSignal(appName, signalCmd, channel);
  logInfo(`[${appName}] USR1 signal done (exit code: ${signalResult.exitCode?.toString() ?? 'null'}).`);

  if (isSshDisabledError(signalResult.stderr)) {
    channel.appendLine(`[Extension] SSH is disabled for ${appName}. Attempting to enable...`);
    logInfo(`[${appName}] SSH disabled — starting enable/restart flow.`);
    const enabled = await ensureSshEnabledForDebug(appName, channel, (status, message) => {
      setSessionStatus(appName, status, message);
    });
    if (!enabled) {
      reconnecting.delete(appName);
      return;
    }
    if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;

    channel.appendLine(`[Extension] Retrying Node inspector activation after SSH enable...`);
    logInfo(`[${appName}] Retrying USR1 signal after SSH enable/restart.`);
    await runCfSshSignal(appName, signalCmd, channel);
    if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;
  }

  await new Promise(r => setTimeout(r, 300));
  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;

  logInfo(`[${appName}] Step 2: opening SSH tunnel on port ${port.toString()}…`);
  spawnSshTunnel(appName, folderPath, port, launchConfigName, channel, lifecycleVersion);
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
  if (child.pid !== undefined) {
    void registerActiveTunnel({
      appName,
      pid: child.pid,
      port,
      startedAt: Date.now(),
      ownerPid: process.pid,
    });
  }
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

  void probeTunnelAndAttach(appName, port, launchConfigName, channel, lifecycleVersion);

  child.on('close', (code) => {
    disposeKeepalive(appName);
    void unregisterActiveTunnel(appName);
    channels.get(appName)?.appendLine(`\n[Extension] Process exited with code ${code?.toString() ?? 'null'}`);
    if (!isCurrentLifecycle(appName, lifecycleVersion)) return;
    if (processes.get(appName) === child) {
      processes.delete(appName);
    }
    if (stoppedApps.has(appName)) return;

    if (reconnecting.has(appName)) return;

    const prevStatus = sessionStates.get(appName)?.status;
    if (prevStatus === 'ATTACHED') {
      if (scheduleReconnect(appName, lifecycleVersion, 'child close')) return;
    }

    if (!hasActiveVsCodeSession(launchConfigName)) {
      void emitExitedAndCleanup(appName, launchConfigName);
    }
  });

  child.on('error', (err) => {
    disposeKeepalive(appName);
    void unregisterActiveTunnel(appName);
    if (!isCurrentLifecycle(appName, lifecycleVersion)) return;
    channels.get(appName)?.appendLine(`\n[Extension] Failed to spawn cf ssh: ${err.message}`);
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
  const PROBE_INTERVAL_MS = 500;
  const configuredSecs = vscode.workspace.getConfiguration('cdsDebug').get('tunnelReadyTimeoutSeconds', 30);
  const TIMEOUT_MS = Math.max(10, Math.min(120, configuredSecs)) * 1000;
  logInfo(`[${appName}] Probing Node inspector through tunnel on port ${port.toString()} (timeout ${(TIMEOUT_MS / 1000).toString()}s)…`);

  const isReady = await waitInspectorReady(
    port,
    TIMEOUT_MS,
    PROBE_INTERVAL_MS,
    () => isCurrentLifecycle(appName, lifecycleVersion) && !stoppedApps.has(appName),
  );

  if (!isCurrentLifecycle(appName, lifecycleVersion) || stoppedApps.has(appName)) return;

  if (!isReady) {
    const errMsg = `Remote Node inspector did not respond through tunnel on port ${port.toString()} within ${(TIMEOUT_MS / 1000).toString()}s. The app may still be starting; try increasing cdsDebug.tunnelReadyTimeoutSeconds in VS Code settings.`;
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
        startKeepaliveForApp(appName, lifecycleVersion);
        const folderPath = sessionParams.get(appName)?.folderPath;
        if (folderPath !== undefined) {
          void scanAndWarnForDebuggerLiterals(appName, folderPath, lifecycleVersion, channel);
        }
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

function startKeepaliveForApp(appName: string, lifecycleVersion: number): void {
  const session = getActiveDebugSessionForApp(appName);
  if (session === undefined) return;
  disposeKeepalive(appName);
  const intervalSeconds = getRemoteInspectorCleanupSettings().tunnelKeepaliveIntervalSeconds;
  const dispose = startTunnelKeepalive(session, appName, intervalSeconds, () => {
    if (!isCurrentLifecycle(appName, lifecycleVersion)) return;
    logWarn(`[${appName}] Inspector keepalive requested reconnect.`);
    void incrementLocalTelemetryCounter('keepaliveReconnectTriggered');
    scheduleReconnect(appName, lifecycleVersion, 'keepalive');
  });
  keepaliveDisposables.set(appName, dispose);
}

export async function stopAllProcesses(): Promise<void> {
  const activeAppNames = Array.from(sessionStates.keys());
  
  await Promise.allSettled(activeAppNames.map((appName) => stopProcess(appName, true, false, true)));

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot && activeAppNames.length > 0) {
    void removeLaunchConfigs(workspaceRoot, activeAppNames).catch((err: unknown) => {
      logWarn(`Failed to bulk clean launch configs: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

export async function disposeAllProcesses(): Promise<void> {
  await Promise.allSettled(Array.from(sessionStates.keys()).map((appName) => clearBreakpointsForApp(appName)));

  for (const timer of reconnectTimers.values()) {
    clearTimeout(timer);
  }
  reconnectTimers.clear();

  for (const appName of keepaliveDisposables.keys()) {
    disposeKeepalive(appName);
  }

  for (const p of processes.values()) {
    killProcessGroup(p);
  }
  await Promise.allSettled(Array.from(processes.keys()).map((appName) => unregisterActiveTunnel(appName)));
  processes.clear();

  const portsToCleanup = Array.from(debugPorts.values());
  debugPorts.clear();
  sessionStates.clear();
  clearDebugSessionRegistry();
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
