import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { logInfo } from './logger';

const processes = new Map<string, ChildProcess>();
const channels = new Map<string, vscode.OutputChannel>();
let sessionListener: vscode.Disposable | null = null;

export function initializeProcessManager(): void {
  sessionListener ??= vscode.debug.onDidTerminateDebugSession((session) => {
    const p = processes.get(session.name);
    if (p) {
      logInfo(`Debug session ${session.name} stopped. Cleaning up SSH tunnel process...`);
      p.kill();
      processes.delete(session.name);
      const channel = channels.get(session.name);
      if (channel) {
        channel.appendLine('[Extension] Debug session terminated. Process killed.');
      }
    }
  });
}

export function startTunnelAndAttach(appName: string, folderPath: string, port: number, launchConfigName: string): void {
  initializeProcessManager();

  let channel = channels.get(launchConfigName);
  if (!channel) {
    channel = vscode.window.createOutputChannel(`CDS: ${appName}`);
    channels.set(launchConfigName, channel);
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

  processes.set(launchConfigName, child);

  let attached = false;

  const handleOutput = (data: Buffer | string): void => {
    const output = data.toString();
    const ch = channels.get(launchConfigName);
    if (ch) ch.append(output);

    // Trigger attach when the tunnel is ready
    if (!attached && output.toLowerCase().includes('now attach a debugger to port')) {
      attached = true;
      if (ch) ch.appendLine(`\n[Extension] Detected debugger readiness. Attaching VS Code debug config '${launchConfigName}'...`);
      logInfo(`Tunnel ready for ${appName}, attaching VS Code debugger...`);
      
      const workspaceFolder = vscode.workspace.workspaceFolders 
        ? vscode.workspace.workspaceFolders[0] 
        : undefined;
      
      void vscode.debug.startDebugging(workspaceFolder, launchConfigName);
    }
  };

  child.stdout.on('data', handleOutput);
  child.stderr.on('data', handleOutput);

  child.on('close', (code) => {
    const ch = channels.get(launchConfigName);
    if (ch) ch.appendLine(`\n[Extension] Process exited with code ${code?.toString() ?? 'null'}`);
    processes.delete(launchConfigName);
  });
  
  child.on('error', (err) => {
    const ch = channels.get(launchConfigName);
    if (ch) ch.appendLine(`\n[Extension] Failed to spawn process: ${err.message}`);
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
