import * as vscode from 'vscode';
import { initConfigStore, clearConfig } from './storage/configStore';
import { initCacheStore } from './storage/cacheStore';
import { initCacheSync, disposeCacheSync } from './core/cacheSync';
import { DebugLauncherViewProvider } from './webview/debugPanel';
import { disposeLogger } from './core/logger';
import { disposeAllProcesses, initializeProcessManager, stopAllProcesses } from './core/processManager';

export function activate(context: vscode.ExtensionContext): void {
  initConfigStore(context);
  initCacheStore(context);
  initCacheSync();
  initializeProcessManager();

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
}

export function deactivate(): void {
  disposeCacheSync();
  disposeAllProcesses();
  disposeLogger();
}
