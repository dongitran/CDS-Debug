import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logInfo } from './logger';

export const debugProcessEvents = new EventEmitter();

const processes = new Map<string, ChildProcess>();
const channels = new Map<string, vscode.OutputChannel>();
let sessionListener: vscode.Disposable | null = null;

export function initializeProcessManager(): void {
  sessionListener ??= vscode.debug.onDidTerminateDebugSession((session) => {
    const appName = session.name.replace('Debug: ', '');
    const p = processes.get(appName);
    if (p) {
      logInfo(`Debug session ${session.name} stopped. Cleaning up SSH tunnel process...`);
      p.kill();
      processes.delete(appName);
      const channel = channels.get(appName);
      if (channel) {
        channel.appendLine('[Extension] Debug session terminated. Process killed.');
      }
      debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });
    }
  });
}

export function stopProcess(appName: string): void {
  const p = processes.get(appName);
  if (p) {
    logInfo(`Killing process for ${appName} explicitly.`);
    p.kill();
    processes.delete(appName);
    const channel = channels.get(appName);
    if (channel) {
      channel.appendLine(`[Extension] Process killed early by explicit Stop request.`);
    }
    // VS Code debug session might still be running locally, let's stop it too
    void vscode.debug.stopDebugging();
    debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });
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
  });

  processes.set(appName, child);
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
          debugProcessEvents.emit('statusChanged', { appName, status: 'ATTACHED' });
        } else {
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
    debugProcessEvents.emit('statusChanged', { appName, status: 'EXITED' });
  });
  
  child.on('error', (err) => {
    const ch = channels.get(appName);
    if (ch) ch.appendLine(`\n[Extension] Failed to spawn process: ${err.message}`);
    debugProcessEvents.emit('statusChanged', { appName, status: 'ERROR', message: err.message });
  });
}

export function disposeAllProcesses(): void {
  for (const p of processes.values()) {
    p.kill();
  }
  processes.clear();

  for (const channel of channels.values()) {
    channel.dispose();
  }
  channels.clear();

  if (sessionListener) {
    sessionListener.dispose();
    sessionListener = null;
  }
}
