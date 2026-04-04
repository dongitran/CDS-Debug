import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionMessage, OrgGroupMapping, WebviewMessage } from '../types/index';
import { cfLogin, cfOrgs, cfTargetAndApps } from '../core/cfClient';
import { findGroupFolders, findRepoFolder } from '../core/folderScanner';
import { buildDebugTargets, getFolderNameCandidates } from '../core/appMapper';
import { mergeLaunchJson } from '../core/launchConfigurator';
import { getConfig, saveConfig } from '../storage/configStore';
import { logError, logInfo, logWarn } from '../core/logger';
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
    logInfo('Panel loaded.');
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
    logInfo(`Root folder selected: ${rootPath}`);
    const groupFolders = await findGroupFolders(rootPath);
    logInfo(`Found ${groupFolders.length.toString()} group folder(s): ${groupFolders.join(', ')}`);
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
      const msg = 'SAP_EMAIL or SAP_PASSWORD environment variable is not set.';
      logError(msg);
      this.post({ type: 'LOGIN_ERROR', payload: { message: msg } });
      return;
    }

    if (!apiEndpoint.startsWith('https://')) {
      const msg = 'API endpoint must start with https://';
      logError(msg);
      this.post({ type: 'LOGIN_ERROR', payload: { message: msg } });
      return;
    }

    logInfo(`Logging in to ${apiEndpoint} as ${email} …`);

    try {
      await cfLogin(apiEndpoint, email, password);
      const orgs = await cfOrgs();
      logInfo(`Login successful. Found ${orgs.length.toString()} org(s): ${orgs.join(', ')}`);
      const existing = getConfig();
      await saveConfig({
        rootFolderPath: existing?.rootFolderPath ?? '',
        apiEndpoint,
        orgGroupMappings: existing?.orgGroupMappings ?? [],
      });
      this.post({ type: 'LOGIN_SUCCESS', payload: { orgs } });
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`Login failed: ${msg}`);
      this.post({ type: 'LOGIN_ERROR', payload: { message: msg } });
    }
  }

  private async handleSaveMappings(mappings: OrgGroupMapping[]): Promise<void> {
    const existing = getConfig();
    if (!existing) return;
    logInfo(`Saving ${mappings.length.toString()} org mapping(s).`);
    await saveConfig({ ...existing, orgGroupMappings: mappings });
  }

  private async handleLoadApps(org: string): Promise<void> {
    const config = getConfig();
    if (!config) return;

    const mapping = config.orgGroupMappings.find((m) => m.cfOrg === org);
    if (!mapping) {
      const msg = `No local folder mapped for org: ${org}`;
      logWarn(msg);
      this.post({ type: 'APPS_ERROR', payload: { message: msg } });
      return;
    }

    logInfo(`Loading apps for org: ${org} …`);
    try {
      const apps = await cfTargetAndApps(org);
      const started = apps.filter((a) => a.state === 'started').length;
      logInfo(`Apps loaded: ${apps.length.toString()} total, ${started.toString()} started.`);
      this.post({ type: 'APPS_LOADED', payload: { apps } });
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`Failed to load apps for ${org}: ${msg}`);
      this.post({ type: 'APPS_ERROR', payload: { message: msg } });
    }
  }

  private async handleStartDebug(appNames: string[], org: string): Promise<void> {
    const config = getConfig();
    if (!config) return;

    const mapping = config.orgGroupMappings.find((m) => m.cfOrg === org);
    if (!mapping) {
      const msg = `No mapping found for org: ${org}`;
      logError(msg);
      this.post({ type: 'DEBUG_ERROR', payload: { message: msg } });
      return;
    }

    logInfo(`Starting debug for ${appNames.length.toString()} app(s): ${appNames.join(', ')}`);

    const groupPath = path.join(config.rootFolderPath, mapping.localGroupPath);

    const resolvedPaths: string[] = [];
    for (const appName of appNames) {
      let folderPath: string | null = null;
      for (const candidate of getFolderNameCandidates(appName)) {
        folderPath = await findRepoFolder(groupPath, candidate);
        if (folderPath !== null) break;
      }
      
      if (folderPath !== null) {
        resolvedPaths.push(folderPath);
        logInfo(`Mapped: ${appName} → ${folderPath}`);
      } else {
        logWarn(`Could not find local folder for: ${appName}`);
      }
    }

    const { targets, unmapped } = buildDebugTargets(appNames, resolvedPaths);

    if (targets.length === 0) {
      const msg = `Could not map any app to a local folder. Unmapped: ${unmapped.join(', ')}`;
      logError(msg);
      this.post({ type: 'DEBUG_ERROR', payload: { message: msg } });
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? config.rootFolderPath;
    await mergeLaunchJson(workspaceRoot, targets);
    logInfo(`Updated .vscode/launch.json with ${targets.length.toString()} config(s).`);

    for (const target of targets) {
      const folderName = path.basename(target.folderPath);
      const cmd = `cds watch --inspect=${target.port.toString()}`;
      logInfo(`Terminal [${folderName}] > ${cmd}`);
      const terminal = vscode.window.createTerminal({
        name: `CDS: ${folderName}`,
        cwd: target.folderPath,
      });
      terminal.sendText(cmd);
      terminal.show(false);
    }

    this.post({ type: 'DEBUG_STARTED', payload: { count: targets.length } });

    if (unmapped.length > 0) {
      logWarn(`${unmapped.length.toString()} app(s) not mapped: ${unmapped.join(', ')}`);
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
