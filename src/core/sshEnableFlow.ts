import type * as vscode from 'vscode';
import { cfEnableSsh, cfRestartApp, cfSshEnabled } from './cfClient';
import { logError, logInfo } from './logger';

export type SshEnableStatus = 'SSH_ENABLING' | 'SSH_RESTARTING' | 'ERROR';
export type SshEnableStatusSink = (status: SshEnableStatus, message?: string) => void;

export async function ensureSshEnabledForDebug(
  appName: string,
  channel: vscode.OutputChannel,
  setStatus: SshEnableStatusSink,
): Promise<boolean> {
  if (!(await ensureSshFlagEnabled(appName, channel, setStatus))) return false;
  return restartAppForSsh(appName, channel, setStatus);
}

async function ensureSshFlagEnabled(
  appName: string,
  channel: vscode.OutputChannel,
  setStatus: SshEnableStatusSink,
): Promise<boolean> {
  if (await cfSshEnabled(appName)) {
    channel.appendLine(`[Extension] SSH is already enabled for ${appName} — may need a restart.`);
    return true;
  }

  setStatus('SSH_ENABLING');
  try {
    await cfEnableSsh(appName);
    channel.appendLine(`[Extension] SSH enabled for ${appName}. App restart required.`);
    logInfo(`[${appName}] SSH enabled successfully.`);
    return true;
  } catch (err: unknown) {
    const msg = `Failed to enable SSH: ${err instanceof Error ? err.message : String(err)}`;
    channel.appendLine(`[Extension] ${msg}`);
    logError(`[${appName}] ${msg}`);
    setStatus('ERROR', msg);
    return false;
  }
}

async function restartAppForSsh(
  appName: string,
  channel: vscode.OutputChannel,
  setStatus: SshEnableStatusSink,
): Promise<boolean> {
  setStatus('SSH_RESTARTING');
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
    setStatus('ERROR', msg);
    return false;
  }
}
