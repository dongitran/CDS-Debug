import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { logError, logInfo, logWarn } from './logger';
import { createCfProcessEnv } from './cfEnvironment';

/**
 * Manages `cf logs <appName>` streaming child processes.
 * Emits 'logLine', 'logError', and 'logEnd' events.
 */
class CfLogsManager extends EventEmitter {
  private readonly _processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly _starting = new Map<string, Promise<boolean>>();
  private readonly _startVersions = new Map<string, number>();

  async startStreaming(appName: string): Promise<boolean> {
    if (this._processes.has(appName)) {
      logWarn(`[CfLogs] Already streaming for ${appName} — ignoring duplicate start.`);
      return true;
    }
    const existingStart = this._starting.get(appName);
    if (existingStart !== undefined) return existingStart;

    logInfo(`[CfLogs] Starting log stream for ${appName}.`);
    const version = (this._startVersions.get(appName) ?? 0) + 1;
    this._startVersions.set(appName, version);
    const tracked = this.startProcess(appName, version).finally(() => {
      if (this._starting.get(appName) === tracked) this._starting.delete(appName);
    });
    this._starting.set(appName, tracked);
    return tracked;
  }

  private async startProcess(appName: string, version: number): Promise<boolean> {
    const env = await createCfProcessEnv();
    if (this._startVersions.get(appName) !== version) return false;
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
    return true;
  }

  stopStreaming(appName: string): void {
    this._startVersions.set(appName, (this._startVersions.get(appName) ?? 0) + 1);
    this._starting.delete(appName);
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
    const appNames = new Set([...this._processes.keys(), ...this._starting.keys()]);
    for (const appName of appNames) {
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
