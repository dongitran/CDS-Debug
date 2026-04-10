import * as vscode from 'vscode';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { logInfo, logWarn, logError } from './logger';
import { removeLaunchConfigs } from './launchConfigurator';
import { cfSshEnabled, cfEnableSsh, cfRestartApp } from './cfClient';

const execFileAsync = promisify(execFile);

export const debugProcessEvents = new EventEmitter();

const processes = new Map<string, ChildProcess>();
// Tracks the local debug port for each app independently of the cds-debug child process.
// The cds-debug process may exit after establishing the tunnel (cf ssh runs separately),
// so this map must NOT be cleared on child close — only on explicit stop/terminate/dispose.
const debugPorts = new Map<string, number>();
const channels = new Map<string, vscode.OutputChannel>();
const sessionStates = new Map<string, { status: string; message?: string }>();
const activeDebugSessions = new Map<string, vscode.DebugSession>();
// Tracks whether stopProcess() has already emitted EXITED for an app,
// preventing duplicate emits from child.on('close') or onDidTerminateDebugSession.
const stoppedApps = new Set<string>();
let sessionListener: vscode.Disposable | null = null;
let startListener: vscode.Disposable | null = null;
const DEBUG_SESSION_PREFIX = 'Debug: ';
const activeVsCodeSessions = new Set<string>();

// Serializes concurrent vscode.debug.startDebugging() calls.
// VS Code's debug API is not safe for simultaneous attach requests — the second
// call can silently fail (return false) if it arrives before the first resolves.
// This queue ensures each app attaches only after the previous attach completes.
let debugAttachQueue = Promise.resolve();

// Kills a child process and its entire process group on Unix (SIGTERM → process group),
// ensuring sub-processes like `cf ssh` are also terminated.
function killProcessGroup(child: ChildProcess): void {
  const isWindows = process.platform === 'win32';
  if (!isWindows && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch (err: unknown) {
      // pid may already be gone; fall through to direct kill
      logWarn(`Process group kill failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  child.kill();
}

// Forcibly kills any process still listening on a TCP port.
// Used as a fallback when `cds debug` spawns `cf ssh` in a separate process group,
// which means SIGTERM to the cds process group does NOT reach the SSH tunnel.
async function killProcessOnPort(port: number): Promise<void> {
  const portStr = port.toString();
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano']);
      const lines = stdout.split('\n');
      const pidsToKill = new Set<number>();
      for (const line of lines) {
        if (line.includes(`:${portStr}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const lastPart = parts[parts.length - 1];
          if (!lastPart) continue;
          const pid = parseInt(lastPart, 10);
          if (!isNaN(pid)) pidsToKill.add(pid);
        }
      }
      for (const pid of pidsToKill) {
        // cspell:ignore taskkill
        try { await execFileAsync('taskkill', ['/F', '/PID', pid.toString()]); } catch { /* ignore */ }
      }
    } catch {
      // ignore
    }
    return;
  }

  try {
    const { stdout } = await execFileAsync('lsof', ['-t', '-i', `tcp:${portStr}`]);
    const pids = stdout.trim().split('\n').filter(Boolean);
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
  } catch {
    // lsof not available or no remaining process on the port — nothing to do
  }
}

export function getActiveSessions(): Record<string, { status: string; message?: string }> {
  return Object.fromEntries(sessionStates);
}

export function initializeProcessManager(): void {
  startListener ??= vscode.debug.onDidStartDebugSession((session) => {
    activeVsCodeSessions.add(session.name);
    activeDebugSessions.set(session.name, session);
  });

  sessionListener ??= vscode.debug.onDidTerminateDebugSession((session) => {
    activeVsCodeSessions.delete(session.name);
    activeDebugSessions.delete(session.name);

    if (!session.name.startsWith(DEBUG_SESSION_PREFIX)) return;
    const appName = session.name.slice(DEBUG_SESSION_PREFIX.length);

    // Kill tunnel process if still running (e.g. user stopped debugger from VS Code toolbar)
    const p = processes.get(appName);
    if (p) {
      logInfo(`Debug session ${session.name} stopped. Cleaning up SSH tunnel process...`);
      killProcessGroup(p);
      processes.delete(appName);
      const channel = channels.get(appName);
      if (channel) {
        channel.appendLine('[Extension] Debug session terminated. Process killed.');
      }
    }
    // Always kill by port: cds-debug may have already exited (process map entry gone)
    // while cf ssh tunnel still runs as a separate process.
    const port = debugPorts.get(appName);
    if (port !== undefined) {
      debugPorts.delete(appName);
      setTimeout(() => void killProcessOnPort(port), 600);
    }

    // Guard: stopProcess() or primitive exit may have already handled cleanup
    if (stoppedApps.has(appName)) return;
    
    // Claim token to prevent concurrent native hooks from duplicating cleanup
    stoppedApps.add(appName);

    sessionStates.delete(appName);
    debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });

    // Clean up launch config automatically when VS Code debugging stops natively
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      void removeLaunchConfigs(workspaceRoot, [appName]).catch((err: unknown) => {
        logWarn(`Failed to clean launch config for ${appName}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  });
}

export function stopProcess(appName: string, skipConfigCleanup = false): void {
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
  // Always kill by port regardless of whether the cds-debug process is still in the map.
  // cds-debug may have exited early (after tunnel setup) so `processes` entry could already
  // be gone, yet cf ssh is still listening on the port.
  const port = debugPorts.get(appName);
  if (port !== undefined) {
    debugPorts.delete(appName);
    setTimeout(() => void killProcessOnPort(port), 600);
  }
  // Mark as stopped so downstream close/terminate events skip duplicate EXITED emit
  stoppedApps.add(appName);
  // Stop only sessions tied to this app, never unrelated debug sessions.
  stopActiveDebugSessionForApp(appName, skipConfigCleanup);
  sessionStates.delete(appName);
  debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });
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

  // Clear any residual stopped state to ensure native termination works on subsequent runs
  stoppedApps.delete(appName);

  let channel = channels.get(appName);
  if (!channel) {
    channel = vscode.window.createOutputChannel(`CDS: ${appName}`);
    channels.set(appName, channel);
  }
  channel.clear();

  // Pre-flight: free the local port before binding the SSH tunnel
  channel.appendLine(`[Extension] Ensuring port ${port.toString()} is free...`);
  logInfo(`Ensuring port ${port.toString()} is free before starting...`);
  await killProcessOnPort(port);
  await new Promise(r => setTimeout(r, 200));

  // Step 1: Send USR1 signal to the remote node process to activate the inspector.
  // This is a one-shot command — it exits immediately after signalling.
  const signalCmd = `kill -s USR1 $(pidof node)`;
  channel.appendLine(`[Extension] Activating Node inspector on ${appName}: cf ssh ${appName} -c "${signalCmd}"`);
  logInfo(`[Step 1] Activating Node inspector: cf ssh ${appName} -c "${signalCmd}"`);

  const signalResult = await runCfSshSignal(appName, signalCmd, channel);

  // Detect SSH disabled: cf ssh fails with "not authorized" when SSH is not enabled
  if (isSshDisabledError(signalResult.stderr)) {
    channel.appendLine(`[Extension] SSH is disabled for ${appName}. Attempting to enable...`);
    logInfo(`[${appName}] SSH disabled — starting enable/restart flow.`);
    const enabled = await ensureSshEnabled(appName, channel);
    if (!enabled) return;

    // Retry Step 1 after SSH was enabled and app restarted
    channel.appendLine(`[Extension] Retrying Node inspector activation after SSH enable...`);
    logInfo(`[${appName}] Retrying USR1 signal after SSH enable/restart.`);
    await runCfSshSignal(appName, signalCmd, channel);
  }

  // Brief pause to let the inspector socket initialize before we tunnel to it.
  // Node needs ~300ms to open the WebSocket after receiving USR1.
  await new Promise(r => setTimeout(r, 300));

  // Step 2: Open a persistent SSH tunnel — remote 9229 → local <port>.
  // Each app gets its own unique local port so parallel tunnels never conflict.
  spawnSshTunnel(appName, folderPath, port, launchConfigName, channel);
}

function isSshDisabledError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes('not authorized') || lower.includes('ssh support is disabled');
}

// Checks SSH status, enables SSH, then automatically restarts the app.
// Returns true if SSH is ready, false if an error occurred.
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

// Spawns the persistent SSH tunnel and wires up stdout/stderr/close/error handlers.
function spawnSshTunnel(
  appName: string,
  folderPath: string,
  port: number,
  launchConfigName: string,
  channel: vscode.OutputChannel,
): void {
  const tunnelArg = `${port.toString()}:localhost:9229`;
  channel.appendLine(`[Extension] Opening SSH tunnel: cf ssh ${appName} -L ${tunnelArg}`);
  logInfo(`[Background] cf ssh ${appName} -L ${tunnelArg}`);

  const isWindows = process.platform === 'win32';
  const child = spawn('cf', ['ssh', appName, '-L', tunnelArg], {
    cwd: folderPath,
    shell: isWindows,
    // Detached so killProcessGroup(-pid) terminates the entire cf ssh process tree
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
    // Fatal SSH binding error — report immediately so UI shows ERROR state
    if (text.toLowerCase().includes('address already in use') || text.toLowerCase().includes('permission denied')) {
      const errMsg = `Port ${port.toString()} is already in use or access was denied.`;
      logError(`[${appName}] ${errMsg}`);
      sessionStates.set(appName, { status: 'ERROR', message: errMsg });
      debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: errMsg });
    }
  });

  // `cf ssh -L` does not print a readiness message. TCP-probe the local port
  // every 250ms until the tunnel accepts connections, then trigger VS Code attach.
  void probeTunnelAndAttach(appName, port, launchConfigName, channel);

  child.on('close', (code) => {
    channels.get(appName)?.appendLine(`\n[Extension] Process exited with code ${code?.toString() ?? 'null'}`);
    processes.delete(appName);

    if (stoppedApps.has(appName)) return;

    if (!activeVsCodeSessions.has(launchConfigName)) {
      stoppedApps.add(appName);
      sessionStates.delete(appName);
      debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        void removeLaunchConfigs(workspaceRoot, [appName]).catch((err: unknown) => {
          logWarn(`Failed to clean launch config for ${appName} on process exit: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  });

  child.on('error', (err) => {
    channels.get(appName)?.appendLine(`\n[Extension] Failed to spawn cf ssh: ${err.message}`);
    sessionStates.set(appName, { status: 'ERROR', message: err.message });
    debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: err.message });
  });
}

interface SshSignalResult {
  exitCode: number | null;
  stderr: string;
}

// Runs `cf ssh <appName> -c <cmd>` as a one-shot command and waits for it to finish.
// Returns the exit code and accumulated stderr so callers can detect SSH-disabled errors.
// Exit code ≠ 0 is logged as a warning but does not throw — USR1 failures are non-fatal
// (the inspector may already be active, or pidof node returns empty on a quiet process).
async function runCfSshSignal(appName: string, cmd: string, channel: vscode.OutputChannel): Promise<SshSignalResult> {
  return new Promise((resolve) => {
    const child = spawn('cf', ['ssh', appName, '-c', cmd]);
    let stderrBuf = '';

    child.stdout.on('data', (data: Buffer | string) => { channel.append(data.toString()); });
    child.stderr.on('data', (data: Buffer | string) => {
      const text = data.toString();
      stderrBuf += text;
      channel.append(text);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        logWarn(`[${appName}] USR1 signal command exited with code ${code?.toString() ?? 'null'} — inspector may already be active.`);
      }
      resolve({ exitCode: code, stderr: stderrBuf });
    });

    child.on('error', (err) => {
      logWarn(`[${appName}] Failed to run USR1 signal: ${err.message}`);
      resolve({ exitCode: null, stderr: err.message }); // non-fatal — proceed to tunnel step
    });
  });
}

// TCP-probes localhost:<port> every 250ms until the tunnel accepts a connection,
// then enqueues the VS Code attach. Times out after 15 seconds.
async function probeTunnelAndAttach(
  appName: string,
  port: number,
  launchConfigName: string,
  channel: vscode.OutputChannel,
): Promise<void> {
  const PROBE_INTERVAL_MS = 250;
  const TIMEOUT_MS = 15_000;
  const started = Date.now();

  const isReady = await new Promise<boolean>((resolve) => {
    const attempt = (): void => {
      if (Date.now() - started > TIMEOUT_MS) {
        resolve(false);
        return;
      }

      // Attempt a TCP connection to the local tunnel port to check readiness
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.setTimeout(200);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        socket.destroy();
        setTimeout(attempt, PROBE_INTERVAL_MS);
      });

      socket.on('timeout', () => {
        socket.destroy();
        setTimeout(attempt, PROBE_INTERVAL_MS);
      });
    };

    attempt();
  });

  if (!isReady) {
    const errMsg = `Tunnel on port ${port.toString()} did not become ready within ${(TIMEOUT_MS / 1000).toString()}s.`;
    logError(`[${appName}] ${errMsg}`);
    sessionStates.set(appName, { status: 'ERROR', message: errMsg });
    debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: errMsg });
    return;
  }

  channel.appendLine(`\n[Extension] Tunnel ready on port ${port.toString()}. Attaching VS Code debugger '${launchConfigName}'...`);
  logInfo(`Tunnel ready for ${appName} on port ${port.toString()}, attaching VS Code debugger...`);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  const currentQueue = debugAttachQueue;
  debugAttachQueue = currentQueue
    .then(() => vscode.debug.startDebugging(workspaceFolder, launchConfigName))
    .then((success) => {
      if (success) {
        sessionStates.set(appName, { status: 'ATTACHED' });
        debugProcessEvents.emit('statusChanged', { appName, status: 'ATTACHED' });
        void vscode.window.showInformationMessage(`CDS Debug: debugger attached to ${appName}`);
      } else {
        sessionStates.set(appName, { status: 'ERROR', message: 'Failed to start VS Code debugging.' });
        debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: 'Failed to start VS Code debugging.' });
      }
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`startDebugging error for ${appName}: ${msg}`);
      sessionStates.set(appName, { status: 'ERROR', message: msg });
      debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: msg });
    });
}

export function stopAllProcesses(): void {
  const activeAppNames = Array.from(sessionStates.keys());
  
  for (const appName of activeAppNames) {
    stopProcess(appName, true);
  }

  // Bulk clean config outside the loop to prevent filesystem race conditions
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot && activeAppNames.length > 0) {
    void removeLaunchConfigs(workspaceRoot, activeAppNames).catch((err: unknown) => {
      logWarn(`Failed to bulk clean launch configs: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

export function disposeAllProcesses(): void {
  for (const p of processes.values()) {
    killProcessGroup(p);
  }
  processes.clear();
  for (const port of debugPorts.values()) {
    void killProcessOnPort(port);
  }
  debugPorts.clear();
  sessionStates.clear();
  activeDebugSessions.clear();
  stoppedApps.clear();

  // Reset the attach queue so stale promise chains from a previous session
  // do not interfere after the extension is deactivated and re-activated.
  debugAttachQueue = Promise.resolve();

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
