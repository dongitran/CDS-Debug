import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logError, logInfo, logWarn } from './logger';

/**
 * Manages `cf logs <appName>` streaming child processes.
 * Emits 'logLine', 'logError', and 'logEnd' events.
 */
class CfLogsManager extends EventEmitter {
  private readonly _processes = new Map<string, ChildProcessWithoutNullStreams>();

  startStreaming(appName: string): void {
    if (this._processes.has(appName)) {
      logWarn(`[CfLogs] Already streaming for ${appName} — ignoring duplicate start.`);
      return;
    }

    logInfo(`[CfLogs] Starting log stream for ${appName}.`);

    const env: NodeJS.ProcessEnv = { ...process.env };
    const child = spawn('cf', ['logs', appName], { env, stdio: 'pipe' });
    this._processes.set(appName, child);

    child.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed.length > 0) {
          this.emit('logLine', appName, trimmed);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed.length > 0) {
          this.emit('logLine', appName, trimmed);
        }
      }
    });

    child.on('error', (err: Error) => {
      logError(`[CfLogs] Process error for ${appName}: ${err.message}`);
      this._processes.delete(appName);
      this.emit('logError', appName, err.message);
      this.emit('logEnd', appName);
    });

    child.on('close', (code: number | null) => {
      logInfo(`[CfLogs] Stream ended for ${appName} (exit code ${code?.toString() ?? 'null'}).`);
      this._processes.delete(appName);
      this.emit('logEnd', appName);
    });
  }

  stopStreaming(appName: string): void {
    const child = this._processes.get(appName);
    if (!child) return;
    logInfo(`[CfLogs] Stopping log stream for ${appName}.`);
    try {
      child.kill('SIGTERM');
    } catch {
      // Process may have already exited.
    }
    this._processes.delete(appName);
    this.emit('logEnd', appName);
  }

  stopAll(): void {
    for (const appName of this._processes.keys()) {
      this.stopStreaming(appName);
    }
  }

  isStreaming(appName: string): boolean {
    return this._processes.has(appName);
  }

  streamingApps(): string[] {
    return [...this._processes.keys()];
  }

  dispose(): void {
    this.stopAll();
    this.removeAllListeners();
  }
}

export const cfLogsManager = new CfLogsManager();
