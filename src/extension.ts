import * as vscode from 'vscode';
import { initConfigStore, clearConfig } from './storage/configStore';
import { initCacheStore } from './storage/cacheStore';
import { initCacheSync, disposeCacheSync } from './core/cacheSync';
import { DebugLauncherViewProvider } from './webview/debugPanel';
import { disposeLogger, logWarn } from './core/logger';
import { disposeAllProcesses, initializeProcessManager, stopAllProcesses, getActiveAppNames } from './core/processManager';
import { setSecretStorage, clearCredentialsFromSecretStorage } from './core/shellEnv';
import { cleanStaleDebugConfigs, removeLaunchConfigs } from './core/launchConfigurator';
import { disposeBreakpointSnapshotManager, initializeBreakpointSnapshotManager } from './core/breakpointSnapshotManager';

export function activate(context: vscode.ExtensionContext): void {
  initConfigStore(context);
  initCacheStore(context);
  setSecretStorage(context.secrets);
  if (process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC !== '1') {
    initCacheSync();
  }
  initializeProcessManager();
  initializeBreakpointSnapshotManager();

  // Remove stale debug configurations left by a previous session that ended without
  // proper cleanup (e.g. VS Code was force-killed while a debug session was active).
  // Safe to remove unconditionally on activation: no debug sessions can be running when
  // the extension is loading into a fresh VS Code instance. The withLock mechanism inside
  // cleanStaleDebugConfigs ensures any subsequent mergeLaunchJson call is serialized
  // after this cleanup completes, preventing a race if the user starts debugging quickly.
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    for (const folder of workspaceFolders) {
      void cleanStaleDebugConfigs(folder.uri.fsPath).catch((err: unknown) => {
        logWarn(
          `Failed to clean stale debug configs in ${folder.uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  const provider = new DebugLauncherViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DebugLauncherViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsDebug.resetConfig', () => {
      void clearConfig().then(() => {
        void vscode.window.showInformationMessage(
          'CDS Debug: configuration reset. Reload the panel to start over.',
        );
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsDebug.stopAllSessions', () => {
      stopAllProcesses();
      void vscode.window.showInformationMessage('CDS Debug: all debug sessions stopped.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsDebug.clearCredentials', () => {
      void clearCredentialsFromSecretStorage().then(() => {
        void vscode.window.showInformationMessage(
          'CDS Debug: saved credentials cleared from system keychain.',
        );
      });
    }),
  );
}

export async function deactivate(): Promise<void> {
  disposeCacheSync();
  disposeBreakpointSnapshotManager();

  // Best-effort cleanup of active debug configurations on normal VS Code shutdown.
  // Removes the Debug: entries from launch.json so the file is not left dirty when the
  // user next opens the workspace. On force-kill this path does not run, but
  // activation-time cleanup (cleanStaleDebugConfigs) covers that scenario instead.
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const activeAppNames = getActiveAppNames();
    if (activeAppNames.length > 0) {
      await removeLaunchConfigs(workspaceRoot, activeAppNames).catch(() => undefined);
    }
  }

  disposeAllProcesses();
  disposeLogger();
}
