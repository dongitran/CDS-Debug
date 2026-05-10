import * as vscode from 'vscode';
import type { RemoteInspectorCleanupSettings } from '../types/index';

export const DEFAULT_REMOTE_INSPECTOR_CLEANUP_SETTINGS: RemoteInspectorCleanupSettings = {
  warnRemoteInspectorAfterStop: false,
  autoRestartAppAfterStop: false,
  warnDebuggerLiteralOnAttach: true,
  clearRemoteBreakpointsBeforeStop: true,
  tunnelKeepaliveIntervalSeconds: 10,
  signalAllNodeProcesses: false,
};

export function getRemoteInspectorCleanupSettings(): RemoteInspectorCleanupSettings {
  const config = vscode.workspace.getConfiguration('cdsDebug');
  return {
    warnRemoteInspectorAfterStop: readBoolean(config, 'warnRemoteInspectorAfterStop'),
    autoRestartAppAfterStop: readBoolean(config, 'autoRestartAppAfterStop'),
    warnDebuggerLiteralOnAttach: readBoolean(config, 'warnDebuggerLiteralOnAttach'),
    clearRemoteBreakpointsBeforeStop: readBoolean(config, 'clearRemoteBreakpointsBeforeStop'),
    tunnelKeepaliveIntervalSeconds: readKeepaliveInterval(config),
    signalAllNodeProcesses: readBoolean(config, 'signalAllNodeProcesses'),
  };
}

function readBoolean(
  config: vscode.WorkspaceConfiguration,
  key: keyof Omit<RemoteInspectorCleanupSettings, 'tunnelKeepaliveIntervalSeconds'>,
): boolean {
  return config.get(key, DEFAULT_REMOTE_INSPECTOR_CLEANUP_SETTINGS[key]);
}

function readKeepaliveInterval(config: vscode.WorkspaceConfiguration): number {
  const value = config.get(
    'tunnelKeepaliveIntervalSeconds',
    DEFAULT_REMOTE_INSPECTOR_CLEANUP_SETTINGS.tunnelKeepaliveIntervalSeconds,
  );
  if (!Number.isFinite(value)) return DEFAULT_REMOTE_INSPECTOR_CLEANUP_SETTINGS.tunnelKeepaliveIntervalSeconds;
  return Math.max(0, Math.min(60, value));
}
