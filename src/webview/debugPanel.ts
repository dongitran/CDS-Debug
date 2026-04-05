import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CacheSettings, ExtensionMessage, OrgGroupMapping, SyncProgress, WebviewMessage } from '../types/index';
import { cfLogin, cfOrgs, cfTargetAndApps } from '../core/cfClient';
import { findGroupFolders, findRepoFolder } from '../core/folderScanner';
import { buildDebugTargets, getFolderNameCandidates } from '../core/appMapper';
import { mergeLaunchJson } from '../core/launchConfigurator';
import { getConfig, saveConfig } from '../storage/configStore';
import { getCachedApps, getCacheSettings, saveCacheSettings } from '../storage/cacheStore';
import { cacheSyncEvents, runCacheSync, getCurrentSyncProgress, restartCacheSyncTimer } from '../core/cacheSync';
import { logError, logInfo, logWarn } from '../core/logger';
import { getWebviewContent } from './getWebviewContent';
import { startTunnelAndAttach, stopProcess, debugProcessEvents, getActiveSessions } from '../core/processManager';

export class DebugLauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'cdsDebug.mainView';

  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {
    debugProcessEvents.on('statusChanged', (payload: { appName: string, status: string, message?: string }) => {
      this.post({ type: 'APP_DEBUG_STATUS', payload });
    });
    cacheSyncEvents.on('progress', (payload: SyncProgress) => {
      this.post({ type: 'SYNC_STATUS', payload });
    });
  }

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
      case 'LOAD_CONFIG': {
        const config = getConfig();
        let groupFolders: string[] = [];
        if (config?.rootFolderPath) {
          groupFolders = await findGroupFolders(config.rootFolderPath);
        }
        this.post({ 
          type: 'CONFIG_LOADED', 
          payload: { 
            config: config ?? null,
            groupFolders,
            activeSessions: getActiveSessions()
          } 
        });
        break;
      }

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

      case 'STOP_DEBUG':
        stopProcess(raw.payload.appName);
        break;
        
      case 'OPEN_APP_URL':
        this.handleOpenAppUrl(raw.payload.url);
        break;

      case 'RESET_LOGIN':
        // State reset handled on frontend; no server-side action needed.
        break;

      case 'GET_SYNC_STATUS':
        this.post({ type: 'SYNC_STATUS', payload: getCurrentSyncProgress() });
        break;

      case 'TRIGGER_SYNC':
        runCacheSync();
        break;

      case 'GET_CACHE_CONFIG':
        this.post({ type: 'CACHE_CONFIG', payload: getCacheSettings() });
        break;

      case 'SAVE_CACHE_CONFIG': {
        const settings: CacheSettings = raw.payload;
        await saveCacheSettings(settings);
        restartCacheSyncTimer();
        this.post({ type: 'CACHE_CONFIG', payload: settings });
        break;
      }
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
      orgs: existing?.orgs ?? [],
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

    logInfo(`Logging in to ${apiEndpoint} …`);

    try {
      await cfLogin(apiEndpoint, email, password);
      const orgs = await cfOrgs();
      logInfo(`Login successful. Found ${orgs.length.toString()} org(s): ${orgs.join(', ')}`);
      const existing = getConfig();
      await saveConfig({
        rootFolderPath: existing?.rootFolderPath ?? '',
        apiEndpoint,
        orgs,
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

    // Serve from background cache when enabled and fresh (within configured interval).
    const cacheSettings = getCacheSettings();
    if (cacheSettings.enabled) {
      const cached = getCachedApps(config.apiEndpoint, org);
      if (cached) {
        const ageMs = Date.now() - cached.cachedAt;
        const ttlMs = cacheSettings.syncIntervalHours * 60 * 60 * 1000;
        if (ageMs < ttlMs) {
          logInfo(`Apps served from cache for org: ${org} (${Math.floor(ageMs / 60_000).toString()}m old).`);
          this.post({ type: 'APPS_LOADED', payload: { apps: cached.apps } });
          return;
        }
      }
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

    this.post({ type: 'DEBUG_CONNECTING', payload: { appNames } });

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

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? config.rootFolderPath;

    const existingPorts: Record<string, number> = {};
    const usedPorts = new Set<number>();
    try {
      const existingConfigs = await import('../core/launchConfigurator').then(m => m.getExistingLaunchConfigs(workspaceRoot));
      for (const c of existingConfigs.configurations) {
        if (c.port) usedPorts.add(c.port);
        // Extract original appName from "Debug: app-name"
        if (c.name.startsWith('Debug: ')) {
          existingPorts[c.name.slice(7)] = c.port;
        }
      }
    } catch {
      // Ignore errors parsing launch.json
    }

    const { targets, unmapped } = buildDebugTargets(appNames, resolvedPaths, existingPorts, usedPorts);

    if (targets.length === 0) {
      const msg = `Could not map any app to a local folder. Unmapped: ${unmapped.join(', ')}`;
      logError(msg);
      this.post({ type: 'DEBUG_ERROR', payload: { message: msg } });
      return;
    }

    await mergeLaunchJson(workspaceRoot, targets);
    logInfo(`Updated .vscode/launch.json with ${targets.length.toString()} config(s).`);

    for (const target of targets) {
      const launchConfigName = `Debug: ${target.appName}`;
      startTunnelAndAttach(target.appName, target.folderPath, target.port, launchConfigName);
    }

    if (unmapped.length > 0) {
      logWarn(`${unmapped.length.toString()} app(s) not mapped: ${unmapped.join(', ')}`);
      void vscode.window.showWarningMessage(
        `${unmapped.length.toString()} app(s) could not be mapped to a local folder: ${unmapped.join(', ')}`,
      );
    }
  }

  private handleOpenAppUrl(rawUrl: string): void {
    const safeUri = toSafeHttpUri(rawUrl);
    if (!safeUri) {
      const msg = 'Blocked unsafe or malformed app URL.';
      logWarn(msg);
      this.post({ type: 'DEBUG_ERROR', payload: { message: msg } });
      return;
    }
    void vscode.env.openExternal(safeUri);
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

function toSafeHttpUri(rawUrl: string): vscode.Uri | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return vscode.Uri.parse(parsed.toString());
  } catch {
    return null;
  }
}
