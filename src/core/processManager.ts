import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logInfo, logWarn } from './logger';

export const debugProcessEvents = new EventEmitter();

const processes = new Map<string, ChildProcess>();
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

    // Guard: stopProcess() may have already emitted EXITED
    if (stoppedApps.has(appName)) {
      stoppedApps.delete(appName);
      return;
    }

    sessionStates.delete(appName);
    debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });
  });
}

export function stopProcess(appName: string): void {
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
  // Mark as stopped so downstream close/terminate events skip duplicate EXITED emit
  stoppedApps.add(appName);
  // Stop only sessions tied to this app, never unrelated debug sessions.
  stopActiveDebugSessionForApp(appName);
  sessionStates.delete(appName);
  debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });
}

function stopActiveDebugSessionForApp(appName: string): void {
  const sessionName = `${DEBUG_SESSION_PREFIX}${appName}`;
  const session = activeDebugSessions.get(sessionName);
  if (session) {
    void vscode.debug.stopDebugging(session);
  }
}

export function startTunnelAndAttach(appName: string, folderPath: string, port: number, launchConfigName: string): void {
  initializeProcessManager();

  let channel = channels.get(appName);
  if (!channel) {
    channel = vscode.window.createOutputChannel(`CDS: ${appName}`);
    channels.set(appName, channel);
  }
  channel.clear();
  const cmdStr = `cds debug ${appName} -f -p ${port.toString()}`;
  channel.appendLine(`[Extension] Starting background process: ${cmdStr}`);
  logInfo(`[Background] ${cmdStr}`);

  const isWindows = process.platform === 'win32';
  const child = spawn(isWindows ? 'cds.cmd' : 'cds', ['debug', appName, '-f', '-p', port.toString()], {
    cwd: folderPath,
    shell: isWindows,
    // On Unix, detached creates a new process group so killProcessGroup(-pid)
    // terminates cds debug AND any child processes it spawned (e.g. cf ssh).
    detached: !isWindows,
  });

  processes.set(appName, child);
  sessionStates.set(appName, { status: 'TUNNELING' });
  debugProcessEvents.emit('statusChanged', { appName, status: 'TUNNELING' });

  let attached = false;

  const handleOutput = (data: Buffer | string): void => {
    const output = data.toString();
    const ch = channels.get(appName);
    if (ch) ch.append(output);

    // Trigger attach when the tunnel is ready
    if (!attached && output.toLowerCase().includes('now attach a debugger to port')) {
      attached = true;
      if (ch) ch.appendLine(`\n[Extension] Detected debugger readiness. Attaching VS Code debug config '${launchConfigName}'...`);
      logInfo(`Tunnel ready for ${appName}, attaching VS Code debugger...`);
      
      const workspaceFolder = vscode.workspace.workspaceFolders 
        ? vscode.workspace.workspaceFolders[0] 
        : undefined;
      
      void vscode.debug.startDebugging(workspaceFolder, launchConfigName).then((success) => {
        if (success) {
          sessionStates.set(appName, { status: 'ATTACHED' });
          debugProcessEvents.emit('statusChanged', { appName, status: 'ATTACHED' });
        } else {
          sessionStates.set(appName, { status: 'ERROR', message: 'Failed to start VS Code debugging.' });
          debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: 'Failed to start VS Code debugging.' });
        }
      });
    }
  };

  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);

  child.on('close', (code) => {
    const ch = channels.get(appName);
    if (ch) ch.appendLine(`\n[Extension] Process exited with code ${code?.toString() ?? 'null'}`);
    processes.delete(appName);

    // stopProcess() already emitted EXITED — nothing more to do
    if (stoppedApps.has(appName)) return;

    // Only emit EXITED if VS Code debugging has also stopped.
    // Sometimes 'cds debug' exits but leaves the underlying tunnel active.
    if (!activeVsCodeSessions.has(launchConfigName)) {
      sessionStates.delete(appName);
      debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });
    }
  });
  
  child.on('error', (err) => {
    const ch = channels.get(appName);
    if (ch) ch.appendLine(`\n[Extension] Failed to spawn process: ${err.message}`);
    sessionStates.set(appName, { status: 'ERROR', message: err.message });
    debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: err.message });
  });
}

export function disposeAllProcesses(): void {
  for (const p of processes.values()) {
    killProcessGroup(p);
  }
  processes.clear();
  sessionStates.clear();
  activeDebugSessions.clear();
  stoppedApps.clear();

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
