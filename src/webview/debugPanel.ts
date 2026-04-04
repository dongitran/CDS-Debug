import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionMessage, OrgGroupMapping, WebviewMessage } from '../types/index';
import { cfLogin, cfOrgs, cfTargetAndApps } from '../core/cfClient';
import { findGroupFolders, findRepoFolder } from '../core/folderScanner';
import { buildDebugTargets } from '../core/appMapper';
import { mergeLaunchJson } from '../core/launchConfigurator';
import { getConfig, saveConfig } from '../storage/configStore';
import { getWebviewContent } from './getWebviewContent';

export class DebugLauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'cdsDebug.mainView';

  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _resolveContext: vscode.WebviewViewResolveContext,
    _cancellationToken: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = getWebviewContent();
    webviewView.webview.onDidReceiveMessage(
      (raw: unknown) => void this.handleMessage(raw),
      undefined,
      this.context.subscriptions,
    );
  }

  private post(message: ExtensionMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!isWebviewMessage(raw)) return;

    switch (raw.type) {
      case 'LOAD_CONFIG':
        this.post({ type: 'CONFIG_LOADED', payload: { config: getConfig() ?? null } });
        break;

      case 'SELECT_ROOT_FOLDER':
        await this.handleSelectRootFolder();
        break;

      case 'LOGIN':
        await this.handleLogin(raw.payload.apiEndpoint);
        break;

      case 'SAVE_MAPPINGS':
        await this.handleSaveMappings(raw.payload.mappings);
        break;

      case 'LOAD_APPS':
        await this.handleLoadApps(raw.payload.org);
        break;

      case 'START_DEBUG':
        await this.handleStartDebug(raw.payload.appNames, raw.payload.org);
        break;
    }
  }

  private async handleSelectRootFolder(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: 'Select projects root folder',
    });
    const selected = uris?.[0];
    if (!selected) return;

    const rootPath = selected.fsPath;
    const groupFolders = await findGroupFolders(rootPath);
    const existing = getConfig();
    await saveConfig({
      rootFolderPath: rootPath,
      apiEndpoint: existing?.apiEndpoint ?? '',
      orgGroupMappings: existing?.orgGroupMappings ?? [],
    });

    this.post({
      type: 'ROOT_FOLDER_SELECTED',
      payload: { path: rootPath, groupFolders },
    });
  }

  private async handleLogin(apiEndpoint: string): Promise<void> {
    const email = process.env.SAP_EMAIL ?? '';
    const password = process.env.SAP_PASSWORD ?? '';

    if (!email || !password) {
      this.post({
        type: 'LOGIN_ERROR',
        payload: { message: 'SAP_EMAIL or SAP_PASSWORD environment variable is not set.' },
      });
      return;
    }

    if (!apiEndpoint.startsWith('https://')) {
      this.post({
        type: 'LOGIN_ERROR',
        payload: { message: 'API endpoint must start with https://' },
      });
      return;
    }

    try {
      await cfLogin(apiEndpoint, email, password);
      const orgs = await cfOrgs();
      const existing = getConfig();
      await saveConfig({
        rootFolderPath: existing?.rootFolderPath ?? '',
        apiEndpoint,
        orgGroupMappings: existing?.orgGroupMappings ?? [],
      });
      this.post({ type: 'LOGIN_SUCCESS', payload: { orgs } });
    } catch (err: unknown) {
      this.post({
        type: 'LOGIN_ERROR',
        payload: { message: extractErrorMessage(err) },
      });
    }
  }

  private async handleSaveMappings(mappings: OrgGroupMapping[]): Promise<void> {
    const existing = getConfig();
    if (!existing) return;
    await saveConfig({ ...existing, orgGroupMappings: mappings });
  }

  private async handleLoadApps(org: string): Promise<void> {
    const config = getConfig();
    if (!config) return;

    const mapping = config.orgGroupMappings.find((m) => m.cfOrg === org);
    if (!mapping) {
      this.post({ type: 'APPS_ERROR', payload: { message: `No local folder mapped for org: ${org}` } });
      return;
    }

    try {
      const apps = await cfTargetAndApps(org);
      this.post({ type: 'APPS_LOADED', payload: { apps } });
    } catch (err: unknown) {
      this.post({ type: 'APPS_ERROR', payload: { message: extractErrorMessage(err) } });
    }
  }

  private async handleStartDebug(appNames: string[], org: string): Promise<void> {
    const config = getConfig();
    if (!config) return;

    const mapping = config.orgGroupMappings.find((m) => m.cfOrg === org);
    if (!mapping) {
      this.post({ type: 'DEBUG_ERROR', payload: { message: `No mapping found for org: ${org}` } });
      return;
    }

    const groupPath = path.join(config.rootFolderPath, mapping.localGroupPath);

    // Resolve each app name to its local source folder
    const resolvedPaths: string[] = [];
    for (const appName of appNames) {
      const folderName = appName.replaceAll('-', '_');
      const folderPath = await findRepoFolder(groupPath, folderName);
      if (folderPath !== null) resolvedPaths.push(folderPath);
    }

    const { targets, unmapped } = buildDebugTargets(appNames, resolvedPaths);

    if (targets.length === 0) {
      this.post({
        type: 'DEBUG_ERROR',
        payload: { message: `Could not map any app to a local folder. Unmapped: ${unmapped.join(', ')}` },
      });
      return;
    }

    // Write / merge launch.json
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? config.rootFolderPath;
    await mergeLaunchJson(workspaceRoot, targets);

    // Start each service in an integrated terminal + attach debugger
    for (const target of targets) {
      const folderName = path.basename(target.folderPath);
      const terminal = vscode.window.createTerminal({
        name: `CDS: ${folderName}`,
        cwd: target.folderPath,
      });
      terminal.sendText(`npx --yes cds watch --inspect=${target.port.toString()}`);
      terminal.show(false);
    }

    this.post({ type: 'DEBUG_STARTED', payload: { count: targets.length } });

    if (unmapped.length > 0) {
      void vscode.window.showWarningMessage(
        `${unmapped.length.toString()} app(s) could not be mapped to a local folder: ${unmapped.join(', ')}`,
      );
    }
  }
}

function isWebviewMessage(value: unknown): value is WebviewMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as Record<string, unknown>).type === 'string'
  );
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
