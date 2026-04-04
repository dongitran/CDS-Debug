import * as vscode from 'vscode';
import { initConfigStore, clearConfig } from './storage/configStore';
import { DebugLauncherViewProvider } from './webview/debugPanel';

export function activate(context: vscode.ExtensionContext): void {
  initConfigStore(context);

  const provider = new DebugLauncherViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DebugLauncherViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('sapDebugLauncher.resetConfig', () => {
      void clearConfig().then(() => {
        void vscode.window.showInformationMessage(
          'SAP Debug Launcher: configuration reset. Reload the panel to start over.',
        );
      });
    }),
  );
}

export function deactivate(): void {
  // No cleanup needed
}
