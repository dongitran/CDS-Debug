import * as vscode from 'vscode';
import { initConfigStore, clearConfig } from './storage/configStore';
import { initCacheStore, getDebugSessionPackagePreferences } from './storage/cacheStore';
import { initCacheSync, disposeCacheSync } from './core/cacheSync';
import { DebugLauncherViewProvider } from './webview/debugPanel';
import { disposeLogger, logInfo, logWarn } from './core/logger';
import { disposeAllProcesses, initializeProcessManager, stopAllProcesses, getActiveAppNames } from './core/processManager';
import { setSecretStorage, clearCredentialsFromSecretStorage } from './core/shellEnv';
import { cleanStaleDebugConfigs, removeLaunchConfigs } from './core/launchConfigurator';
import { disposeBreakpointSnapshotManager, initializeBreakpointSnapshotManager } from './core/breakpointSnapshotManager';
import { disposeBreakpointResolver, initializeBreakpointResolver } from './core/breakpointResolver';
import { disposePackageBreakpointMirror, initializePackageBreakpointMirror } from './core/packageBreakpointMirror';
import { clearOpenedPackageUris } from './core/packageSourceBrowser';
import { disposePackageTabDeduplicator, initializePackageTabDeduplicator } from './core/packageTabDeduplicator';
import { showWhatsNewIfNeeded } from './core/whatsNewManager';
import { WhatsNewPanel } from './webview/whatsNewPanel';
import { initializeTunnelRegistry, reapOrphanCfSshTunnels } from './core/orphanTunnelReaper';
import { incrementLocalTelemetryCounter, initializeLocalTelemetry } from './core/localTelemetry';
import type { SharedCfScope } from './types/index';

export function activate(context: vscode.ExtensionContext): void {
  initConfigStore(context);
  initCacheStore(context);
  setSecretStorage(context.secrets);
  initializeLocalTelemetry(context);
  initializeTunnelRegistry(context.globalStorageUri.fsPath);
  if (process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC !== '1') {
    initCacheSync();
  }
  initializeProcessManager();
  initializeBreakpointSnapshotManager();
  initializeBreakpointResolver();
  initializePackageBreakpointMirror();
  initializePackageTabDeduplicator();

  // Belt-and-suspenders cleanup of the Package browser URI tracker around debug
  // session lifecycle events. The tracker is an in-memory Map that survives across
  // debug sessions within the same extension host; stale entries from a prior run
  // would otherwise be picked up by TabDedupe as the "canonical" URI on the next run
  // and redirect the user to a dead-session editor (content unloadable, breakpoint
  // margin dot never renders, even though the BP appears in the Breakpoints panel and
  // fires through the BPMirror's path-based propagation). Clearing on both START and
  // TERMINATE handles every observed window:
  //   - START: the previous debug session may have been killed externally (e.g.
  //     via VS Code's red square in the toolbar) without our `stopProcess` running.
  //   - TERMINATE: covers the normal stop path.
  const DEBUG_SESSION_PREFIX = 'Debug: ';
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (!session.name.startsWith(DEBUG_SESSION_PREFIX)) return;
      const appName = session.name.slice(DEBUG_SESSION_PREFIX.length);
      clearOpenedPackageUris(appName);
    }),
  );
  context.subscriptions.push(
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (!session.name.startsWith(DEBUG_SESSION_PREFIX)) return;
      const appName = session.name.slice(DEBUG_SESSION_PREFIX.length);
      clearOpenedPackageUris(appName);
    }),
  );

  // Remove stale debug configurations left by a previous session that ended without
  // proper cleanup (e.g. VS Code was force-killed while a debug session was active).
  // Safe to remove unconditionally on activation: no debug sessions can be running when
  // the extension is loading into a fresh VS Code instance. The withLock mechanism inside
  // cleanStaleDebugConfigs ensures any subsequent mergeLaunchJson call is serialized
  // after this cleanup completes, preventing a race if the user starts debugging quickly.
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const staleCleanupTasks: Promise<void>[] = [];
  if (workspaceFolders) {
    for (const folder of workspaceFolders) {
      staleCleanupTasks.push(cleanStaleDebugConfigs(folder.uri.fsPath).catch((err: unknown) => {
        logWarn(
          `Failed to clean stale debug configs in ${folder.uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }));
    }
  }
  void Promise.allSettled(staleCleanupTasks)
    .then(() => reapOrphanCfSshTunnels({ globalStoragePath: context.globalStorageUri.fsPath, graceMs: 60_000 }))
    .then((result) => {
      logInfo(`[TunnelReaper] activation reap killed ${result.killed.length.toString()} pid(s), skipped ${result.skipped.length.toString()}.`);
      if (result.killed.length > 0) void incrementLocalTelemetryCounter('orphanTunnelReaped');
    })
    .catch((err: unknown) => {
      logWarn(`[TunnelReaper] activation reap failed: ${err instanceof Error ? err.message : String(err)}`);
    });

  const provider = new DebugLauncherViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DebugLauncherViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cdsDebug.packageRegexFilter')) {
        provider.postMessage({
          type: 'DEBUG_SESSION_PACKAGE_PREFS',
          payload: getDebugSessionPackagePreferences(),
        });
      }

      if (e.affectsConfiguration('sapCap.currentScope')) {
        const newScope = vscode.workspace
          .getConfiguration('sapCap')
          .get<SharedCfScope>('currentScope');
        if (newScope) {
          provider.handleExternalScopeChange(newScope);
        }
      }
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
    vscode.commands.registerCommand('cdsDebug.stopAllSessions', async () => {
      await stopAllProcesses();
      await vscode.window.showInformationMessage('CDS Debug: all debug sessions stopped.');
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

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsDebug.showWhatsNew', () => {
      WhatsNewPanel.show(context);
    }),
  );

  showWhatsNewIfNeeded(context);
}

export async function deactivate(): Promise<void> {
  disposeCacheSync();
  disposeBreakpointSnapshotManager();
  disposeBreakpointResolver();
  disposePackageBreakpointMirror();
  disposePackageTabDeduplicator();

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

  await disposeAllProcesses();
  disposeLogger();
}
