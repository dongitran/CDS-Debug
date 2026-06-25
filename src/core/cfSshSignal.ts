import type * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { logWarn } from './logger';
import { createCfProcessEnv } from './cfEnvironment';

export const CF_SSH_SIGNAL_TIMEOUT_MS = 15_000;

export interface SshSignalResult {
  exitCode: number | null;
  stderr: string;
}

export function isSshDisabledError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes('not authorized') || lower.includes('ssh support is disabled');
}

export async function runCfSshSignal(
  appName: string,
  cmd: string,
  channel: vscode.OutputChannel,
  shouldStart?: () => boolean,
): Promise<SshSignalResult> {
  const env = await createCfProcessEnv();
  if (shouldStart !== undefined && !shouldStart()) {
    return { exitCode: null, stderr: '' };
  }
  return new Promise((resolve) => {
    const child = spawn('cf', ['ssh', appName, '-c', cmd], { env });
    let stderrBuf = '';
    let settled = false;

    const finish = (result: SshSignalResult, timeout?: ReturnType<typeof setTimeout>): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      logWarn(`[${appName}] USR1 signal command timed out after ${(CF_SSH_SIGNAL_TIMEOUT_MS / 1000).toString()}s — killing and proceeding.`);
      channel.appendLine(`[Extension] USR1 signal timed out — killing cf ssh and continuing.`);
      try {
        child.kill();
      } catch {
        // Process may have already exited.
      }
      finish({ exitCode: null, stderr: stderrBuf });
    }, CF_SSH_SIGNAL_TIMEOUT_MS);

    child.stdout.on('data', (data: Buffer | string) => { channel.append(data.toString()); });
    child.stderr.on('data', (data: Buffer | string) => {
      const text = data.toString();
      stderrBuf += text;
      channel.append(text);
    });

    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        logWarn(`[${appName}] USR1 signal command exited with code ${code?.toString() ?? 'null'} — inspector may already be active.`);
      }
      finish({ exitCode: code, stderr: stderrBuf }, timeout);
    });

    child.on('error', (err) => {
      if (settled) return;
      logWarn(`[${appName}] Failed to run USR1 signal: ${err.message}`);
      finish({ exitCode: null, stderr: err.message }, timeout);
    });
  });
}
