import * as vscode from 'vscode';
import type {
  BranchPrepService,
  BranchPrepStep,
  BreakpointContextSnapshot,
  CacheSettings,
  CapDebugConfig,
  CfApp,
  CredentialStatus,
  DebugTarget,
  E2eBridgeCommand,
  ExtensionMessage,
  LoadedPackageEntry,
  LoadedPackageSource,
  PackageSourceLocation,
  OrgGroupMapping,
  SyncProgress,
  WebviewMessage,
} from '../types/index';
import { CF_DEFAULT_SPACE, DEFAULT_CACHE_SETTINGS } from '../types/index';
import {
  CfCliError,
  cfLogin,
  cfLogout,
  cfOrgs,
  cfTarget,
  cfTargetAndApps,
  cfTargetOrgAndSpaces,
} from '../core/cfClient';
import { refreshCfSyncSpace } from '../core/cfSpaceRefresh';
import { findRepoFolder } from '../core/folderScanner';
import { buildDebugTargets, buildFallbackTargets, getFolderNameCandidates } from '../core/appMapper';
import { getExistingLaunchConfigs, mergeLaunchJson, readCapDebugConfig } from '../core/launchConfigurator';
import { resolveSharedCapDebugConfig } from '../core/capDebugConfig';
import { getConfig, mappingMatchesTarget, saveConfig, upsertOrgMappings } from '../storage/configStore';
import {
  clearCredentialsFromSecretStorage,
  getCredentialSource,
  getCredentials,
  maskEmail,
  saveCredentialsToSecretStorage,
} from '../core/shellEnv';
import {
  getCachedApps,
  getCacheSettings,
  getDebugPreferences,
  getDebugSessionPackagePreferences,
  saveCachedApps,
  saveCacheSettings,
  saveDebugPreferences,
  saveDebugSessionPackagePreferences,
} from '../storage/cacheStore';
import { cacheSyncEvents, runCacheSync, getCurrentSyncProgress, restartCacheSyncTimer } from '../core/cacheSync';
import { getTopologySnapshot, getTopologySnapshotSync } from '../core/cfTopology';
import { logError, logInfo, logWarn } from '../core/logger';
import { getWebviewContent } from './getWebviewContent';
import {
  startTunnelAndAttach,
  stopProcess,
  stopAllProcesses,
  debugProcessEvents,
  getActiveDebugSessionForApp,
  getDebugSessionById,
  getDebugSessionsForApp,
  getActiveSessions,
  getProcessOutputChannel,
  getSessionParams,
} from '../core/processManager';
import { breakpointSnapshotEvents, clearBreakpointSnapshots, getBreakpointSnapshots } from '../core/breakpointSnapshotManager';
import {
  createPackageSearchIndex,
  loadPackageEntriesFromSessions,
  openPackageSource,
  searchPackageEntries,
  type PackageSearchIndex,
} from '../core/packageSourceBrowser';
import {
  applyE2eBridgeCommand,
  getE2eActiveDebugSessionForApp,
  getE2eCredentialStatusOverride,
  getE2eDebugSessionById,
  getE2eDebugSessionsForApp,
  getE2ePackageLocalRoot,
  isE2eModeEnabled,
} from '../testing/e2eBridge';
import {
  checkoutBranch,
  getCurrentBranch,
  getGitRepoRoot,
  hasUncommittedChanges,
  listBranches,
  pullLatest,
  runPnpmBuild,
  runPnpmInstall,
  stashChanges,
} from '../core/gitOperations';

interface ServiceBranchInfo {
  appName: string;
  folderPath: string;
  repoRoot: string | null;
  targetBranch: string | null;
  currentBranch: string | null;
}

export class DebugLauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'cdsDebug.mainView';

  private view?: vscode.WebviewView;
  private readonly packageEntriesByApp = new Map<string, LoadedPackageEntry[]>();
  private readonly packageSearchIndexByApp = new Map<string, PackageSearchIndex>();

  constructor(private readonly context: vscode.ExtensionContext) {
    debugProcessEvents.on('statusChanged', (payload: { appName: string, status: string, message?: string }) => {
      this.postMessage({ type: 'APP_DEBUG_STATUS', payload });
    });
    cacheSyncEvents.on('progress', (payload: SyncProgress) => {
      this.postMessage({ type: 'SYNC_STATUS', payload });
      // When a sync run finishes, refresh the cross-region org topology so the
      // CF Region step's org search reflects the latest accessible orgs.
      if (!payload.isRunning && payload.lastCompletedAt !== undefined) {
        void this.pushCfTopology();
      }
    });
    breakpointSnapshotEvents.on('snapshotAdded', (snapshot: unknown) => {
      if (!isBreakpointSnapshot(snapshot)) return;
      this.postMessage({ type: 'BREAKPOINT_SNAPSHOT_ADDED', payload: { snapshot } });
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

  public postMessage(message: ExtensionMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async pushCfTopology(): Promise<void> {
    try {
      const topology = await getTopologySnapshot();
      this.postMessage({ type: 'CF_TOPOLOGY', payload: topology });
    } catch (err: unknown) {
      logWarn(`[CfTopology] Failed to read cf-sync topology: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleMessage(raw: unknown): Promise<void> {
    if (!isWebviewMessage(raw)) return;

    switch (raw.type) {
      case 'LOAD_CONFIG': {
        const config = getConfig();
        const credentialStatus = await this.buildCredentialStatus();
        this.postMessage({
          type: 'CONFIG_LOADED',
          payload: {
            config: config ?? null,
            activeSessions: getActiveSessions(),
            credentialStatus,
          },
        });
        // Push current debug preferences immediately so the webview's in-memory
        // state always reflects globalState — not a stale acquireVsCodeApi() snapshot
        // from a previous VS Code session where openBrowserOnAttach may have been true.
        this.postMessage({ type: 'DEBUG_PREFS', payload: getDebugPreferences() });
        this.postMessage({ type: 'DEBUG_SESSION_PACKAGE_PREFS', payload: getDebugSessionPackagePreferences() });
        this.postMessage({ type: 'BREAKPOINT_SNAPSHOTS', payload: { snapshots: getBreakpointSnapshots() } });
        // Synchronous best-effort first so the CF Region step can render the org
        // search input on the very first paint when cf-sync has data on disk.
        this.postMessage({ type: 'CF_TOPOLOGY', payload: getTopologySnapshotSync() });
        void this.pushCfTopology();
        break;
      }

      case 'GET_CF_TOPOLOGY':
        this.postMessage({ type: 'CF_TOPOLOGY', payload: getTopologySnapshotSync() });
        void this.pushCfTopology();
        break;

      case 'SAVE_CREDENTIALS':
        await this.handleSaveCredentials(raw.payload.email, raw.payload.password);
        break;

      case 'GET_CREDENTIALS_STATUS': {
        const status = await this.buildCredentialStatus();
        this.postMessage({ type: 'CREDENTIALS_STATUS', payload: status });
        break;
      }

      case 'CLEAR_CREDENTIALS':
        await this.handleClearCredentials();
        break;

      case 'SELECT_GROUP_FOLDER':
        await this.handleSelectGroupFolder();
        break;

      case 'LOGIN':
        await this.handleLogin(raw.payload.apiEndpoint);
        break;

      case 'SAVE_MAPPINGS':
        await this.handleSaveMappings(raw.payload.mappings);
        break;

      case 'LOAD_SPACES':
        await this.handleLoadSpaces(raw.payload.org);
        break;

      case 'LOAD_APPS':
        await this.handleLoadApps(
          raw.payload.org,
          raw.payload.space ?? CF_DEFAULT_SPACE,
          raw.payload.forceRefresh === true,
        );
        break;

      case 'START_DEBUG':
        await this.handleStartDebug(
          raw.payload.appNames,
          raw.payload.org,
          raw.payload.space ?? CF_DEFAULT_SPACE,
        );
        break;

      case 'STOP_DEBUG':
        stopProcess(raw.payload.appName);
        break;

      case 'RETRY_DEBUG':
        await this.handleRetryDebug(raw.payload.appName);
        break;

      case 'CLEAR_BREAKPOINT_SNAPSHOTS':
        clearBreakpointSnapshots();
        this.postMessage({ type: 'BREAKPOINT_SNAPSHOTS', payload: { snapshots: getBreakpointSnapshots() } });
        break;

      case 'LOAD_PACKAGE_SOURCES':
        await this.handleLoadPackageSources(raw.payload.appName);
        break;

      case 'SEARCH_PACKAGE_SOURCES':
        await this.handleSearchPackageSources(
          raw.payload.appName,
          raw.payload.query,
          raw.payload.requestId,
          raw.payload.packageNameFilterRegex,
        );
        break;

      case 'OPEN_PACKAGE_SOURCE':
        await this.handleOpenPackageSource(raw.payload.appName, raw.payload.source, raw.payload.location);
        break;

      case 'E2E_BRIDGE':
        this.handleE2eBridge(raw.payload);
        break;

      case 'STOP_ALL_DEBUG': {
        stopAllProcesses();
        break;
      }
        
      case 'OPEN_APP_URL':
        this.handleOpenAppUrl(raw.payload.url, raw.payload.source);
        break;

      case 'RESET_LOGIN':
        stopAllProcesses();
        break;

      case 'GET_SYNC_STATUS':
        this.postMessage({ type: 'SYNC_STATUS', payload: getCurrentSyncProgress() });
        break;

      case 'TRIGGER_SYNC':
        runCacheSync();
        break;

      case 'GET_CACHE_CONFIG':
        this.postMessage({ type: 'CACHE_CONFIG', payload: getCacheSettings() });
        break;

      case 'REQUEST_CHANGE_MAPPING': {
        stopAllProcesses();
        this.postMessage({ type: 'PROCEED_CHANGE_MAPPING' });
        break;
      }

      case 'GET_DEBUG_PREFS':
        this.postMessage({ type: 'DEBUG_PREFS', payload: getDebugPreferences() });
        break;

      case 'SAVE_DEBUG_PREFS':
        await saveDebugPreferences(raw.payload);
        this.postMessage({ type: 'DEBUG_PREFS', payload: raw.payload });
        break;

      case 'GET_DEBUG_SESSION_PACKAGE_PREFS':
        this.postMessage({ type: 'DEBUG_SESSION_PACKAGE_PREFS', payload: getDebugSessionPackagePreferences() });
        break;

      case 'SAVE_DEBUG_SESSION_PACKAGE_PREFS':
        await saveDebugSessionPackagePreferences(raw.payload);
        this.postMessage({ type: 'DEBUG_SESSION_PACKAGE_PREFS', payload: getDebugSessionPackagePreferences() });
        break;

      case 'SAVE_CACHE_CONFIG': {
        const VALID_INTERVALS: readonly number[] = [12, 24, 48, 96];
        const rawInterval = raw.payload.intervalHours;
        const settings: CacheSettings = {
          enabled: raw.payload.enabled,
          intervalHours: VALID_INTERVALS.includes(rawInterval)
            ? rawInterval
            : DEFAULT_CACHE_SETTINGS.intervalHours,
        };
        await saveCacheSettings(settings);
        restartCacheSyncTimer();
        this.postMessage({ type: 'CACHE_CONFIG', payload: settings });
        break;
      }
    }
  }

  private async handleRetryDebug(appName: string): Promise<void> {
    const params = getSessionParams(appName);
    if (!params) {
      // Params cleared (e.g. extension restarted) — cannot retry automatically.
      this.postMessage({ type: 'DEBUG_ERROR', payload: { message: `Cannot retry ${appName}: session parameters lost. Please start the debug session again.` } });
      return;
    }
    logInfo(`[Retry] Restarting tunnel for ${appName} on port ${params.port.toString()}`);
    // Kill any lingering process without touching launch.json (config is still valid).
    // `silent = true` suppresses the EXITED broadcast so the active-session card stays
    // visible on screen — the card transitions directly from ERROR → TUNNELING with no
    // intermediate disappear/re-appear flash.
    stopProcess(appName, /* skipConfigCleanup */ true, /* silent */ true);
    // Brief pause so the OS releases the port before we re-bind.
    // startTunnelAndAttach also calls killProcessOnPort, so this is belt-and-suspenders.
    await new Promise(r => setTimeout(r, 300));
    // No manual DEBUG_CONNECTING post needed: spawnSshTunnel will emit TUNNELING via
    // debugProcessEvents which reaches the webview as APP_DEBUG_STATUS, updating the
    // card that is still visible from the silent stop above.
    void startTunnelAndAttach(appName, params.folderPath, params.port, params.launchConfigName).catch((err: unknown) => {
      logError(`[Retry] Tunnel restart failed for ${appName}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private logPackageDiagnostic(appName: string, message: string): void {
    const line = `[Packages][${appName}] ${message}`;
    logInfo(line);
    getProcessOutputChannel(appName)?.appendLine(`[Extension] ${line}`);
  }

  private buildPackageLogger(appName: string): (message: string) => void {
    return (message: string): void => {
      this.logPackageDiagnostic(appName, message);
    };
  }

  private getPackageLocalRoot(appName: string): string | undefined {
    return getSessionParams(appName)?.folderPath ?? getE2ePackageLocalRoot(appName);
  }

  private handleE2eBridge(command: E2eBridgeCommand): void {
    if (!isE2eModeEnabled()) return;

    switch (command.action) {
      case 'EMIT_DEBUG_CONNECTING':
        this.postMessage({ type: 'DEBUG_CONNECTING', payload: command.payload });
        return;
      case 'EMIT_APP_DEBUG_STATUS':
        this.postMessage({ type: 'APP_DEBUG_STATUS', payload: command.payload });
        return;
      case 'SET_PACKAGE_FIXTURE':
      case 'CLEAR_PACKAGE_FIXTURES':
      case 'SET_CREDENTIAL_STATUS_OVERRIDE':
      case 'CLEAR_CREDENTIAL_STATUS_OVERRIDE':
        applyE2eBridgeCommand(command);
        return;
      default:
        return;
    }
  }

  private async handleLoadPackageSources(appName: string): Promise<void> {
    const log = this.buildPackageLogger(appName);
    try {
      const packages = await this.getOrLoadPackageEntriesForApp(appName, log, true);
      this.postMessage({ type: 'PACKAGE_SOURCES_LOADED', payload: { appName, packages } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to load package sources for ${appName}: ${message}`);
      log(`Load failed: ${message}`);
      this.postMessage({ type: 'PACKAGE_SOURCES_ERROR', payload: { appName, message } });
    }
  }

  private async handleSearchPackageSources(
    appName: string,
    query: string,
    requestId: number,
    packageNameFilterRegex?: string,
  ): Promise<void> {
    const log = this.buildPackageLogger(appName);
    try {
      const packages = await this.getOrLoadPackageEntriesForApp(appName, log, false);
      const existingIndex = this.packageSearchIndexByApp.get(appName);
      const index = existingIndex ?? this.createPackageSearchIndexForApp(appName, packages);
      if (!existingIndex) this.packageSearchIndexByApp.set(appName, index);

      const searchResults = await searchPackageEntries(index, query, { packageNameFilterRegex });
      this.postMessage({
        type: 'PACKAGE_SEARCH_RESULTS',
        payload: { appName, query, requestId, packages: searchResults },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to search package sources for ${appName}: ${message}`);
      log(`Search failed: ${message}`);
      this.postMessage({ type: 'PACKAGE_SOURCES_ERROR', payload: { appName, message } });
    }
  }

  private async handleOpenPackageSource(
    appName: string,
    source: LoadedPackageSource,
    location?: PackageSourceLocation,
  ): Promise<void> {
    const session = source.debugSessionId
      ? (getE2eDebugSessionById(source.debugSessionId) ?? getDebugSessionById(source.debugSessionId))
      : (getE2eActiveDebugSessionForApp(appName) ?? getActiveDebugSessionForApp(appName));
    if (!session) {
      this.postMessage({ type: 'PACKAGE_SOURCES_ERROR', payload: { appName, message: `No attached debug session found for ${appName}.` } });
      return;
    }

    try {
      this.logPackageDiagnostic(
        appName,
        `Opening source from ${session.name} [${session.id}] path="${source.path ?? source.name ?? 'unknown'}" sourceRef=${String(source.sourceReference ?? 0)}`,
      );
      const localRoot = this.getPackageLocalRoot(appName);
      await openPackageSource(
        session,
        source,
        location,
        localRoot ? { localRoot } : undefined,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to open package source for ${appName}: ${message}`);
      this.logPackageDiagnostic(appName, `Open failed: ${message}`);
      this.postMessage({ type: 'PACKAGE_SOURCES_ERROR', payload: { appName, message } });
    }
  }

  private async getOrLoadPackageEntriesForApp(
    appName: string,
    log: (message: string) => void,
    forceReload: boolean,
  ): Promise<LoadedPackageEntry[]> {
    if (!forceReload) {
      const cachedPackages = this.packageEntriesByApp.get(appName);
      if (cachedPackages) return cachedPackages;
    }

    const resolveSessions = (): readonly vscode.DebugSession[] => {
      const e2eSessions = getE2eDebugSessionsForApp(appName);
      return e2eSessions.length > 0 ? e2eSessions : getDebugSessionsForApp(appName);
    };

    const rootSession = getE2eActiveDebugSessionForApp(appName) ?? getActiveDebugSessionForApp(appName);
    log(`Packages requested. Root session: ${rootSession ? `${rootSession.name} [${rootSession.id}]` : 'none'}`);

    const packages = await loadPackageEntriesFromSessions(appName, resolveSessions, log);
    this.packageEntriesByApp.set(appName, packages);
    this.packageSearchIndexByApp.set(appName, this.createPackageSearchIndexForApp(appName, packages));
    return packages;
  }

  private createPackageSearchIndexForApp(
    appName: string,
    packages: LoadedPackageEntry[],
  ): PackageSearchIndex {
    const localRoot = this.getPackageLocalRoot(appName);
    return createPackageSearchIndex(packages, localRoot ? { localRoot } : undefined);
  }

  private async handleSelectGroupFolder(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: 'Select local group folder for this org',
    });
    const selected = uris?.[0];
    if (!selected) return;

    logInfo(`Group folder selected: ${selected.fsPath}`);
    this.postMessage({ type: 'GROUP_FOLDER_SELECTED', payload: { path: selected.fsPath } });
  }

  private async handleLogin(apiEndpoint: string): Promise<void> {
    const { email, password } = await getCredentials();

    if (!email || !password) {
      const msg = 'No SAP credentials found. Please set your credentials in the extension setup screen.';
      logError(msg);
      this.postMessage({ type: 'LOGIN_ERROR', payload: { message: msg } });
      return;
    }

    if (!apiEndpoint.startsWith('https://')) {
      const msg = 'API endpoint must start with https://';
      logError(msg);
      this.postMessage({ type: 'LOGIN_ERROR', payload: { message: msg } });
      return;
    }

    logInfo(`Logging in to ${apiEndpoint} …`);

    try {
      // Clear any stale CF session before switching regions. Without this, the
      // CF CLI retains the previously-targeted org/space from a different region
      // in ~/.cf/config.json, causing "org not found" errors on cfTarget calls.
      try {
        await cfLogout();
        logInfo('Cleared previous CF session before login.');
      } catch {
        // Safe to ignore: logout fails when no prior session exists.
      }

      await cfLogin(apiEndpoint, email, password);
      const orgs = await cfOrgs();
      logInfo(`Login successful. Found ${orgs.length.toString()} org(s): ${orgs.join(', ')}`);

      // Preserve only mappings whose org exists in the new region.
      // Stale mappings from a previous region would cause "org not found" when
      // the extension auto-selects them or the user resumes without re-mapping.
      const newOrgSet = new Set(orgs);
      const existing = getConfig();
      const validMappings = (existing?.orgGroupMappings ?? []).filter(
        (m) => newOrgSet.has(m.cfOrg),
      );

      await saveConfig({
        apiEndpoint,
        orgs,
        orgGroupMappings: validMappings,
      });
      this.postMessage({ type: 'LOGIN_SUCCESS', payload: { orgs } });
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`Login failed: ${msg}`);
      // Auth failure with keychain credentials → clear stale creds and redirect
      // to SETUP_CREDENTIALS (posting CREDENTIALS_REVOKED). Skip LOGIN_ERROR to
      // avoid a conflicting screen transition.
      const revoked = await this.handleAuthFailure(err);
      if (!revoked) {
        this.postMessage({ type: 'LOGIN_ERROR', payload: { message: msg } });
      }
    }
  }

  private async handleSaveMappings(mappings: OrgGroupMapping[]): Promise<void> {
    const existing = getConfig();
    if (!existing) return;
    logInfo(`Saving ${mappings.length.toString()} org mapping(s).`);
    // Upsert by org/space so switching between spaces preserves each folder.
    await saveConfig({
      ...existing,
      orgGroupMappings: upsertOrgMappings(existing.orgGroupMappings, mappings),
    });
  }

  private async handleLoadSpaces(org: string): Promise<void> {
    const config = getConfig();
    if (!config) return;

    logInfo(`Loading spaces for org: ${org} …`);
    try {
      const spaces = await this.loadLiveSpaces(config.apiEndpoint, org);
      logInfo(`Spaces loaded for ${org}: ${spaces.join(', ')}`);
      this.postMessage({ type: 'SPACES_LOADED', payload: { org, spaces } });
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`Failed to load spaces for ${org}: ${msg}`);
      const revoked = await this.handleAuthFailure(err);
      if (!revoked) {
        this.postMessage({ type: 'SPACES_ERROR', payload: { org, message: msg } });
      }
    }
  }

  private async handleLoadApps(org: string, space: string, forceRefresh = false): Promise<void> {
    const config = getConfig();
    if (!config) return;

    const mapping = config.orgGroupMappings.find((m) => mappingMatchesTarget(m, org, space));
    if (!mapping) {
      const msg = `No local folder mapped for org/space: ${org}/${space}`;
      logWarn(msg);
      this.postMessage({ type: 'APPS_ERROR', payload: { message: msg } });
      return;
    }

    // Serve from background cache when enabled and fresh (within configured interval).
    const cacheSettings = getCacheSettings();
    if (!forceRefresh && cacheSettings.enabled) {
      const cached = getCachedApps(config.apiEndpoint, org, space);
      if (cached) {
        const ageMs = Date.now() - cached.cachedAt;
        const ttlMs = cacheSettings.intervalHours * 60 * 60 * 1000;
        if (ageMs < ttlMs) {
          logInfo(`Apps served from cache for target: ${org}/${space} (${Math.floor(ageMs / 60_000).toString()}m old).`);
          this.postMessage({ type: 'APPS_LOADED', payload: { apps: cached.apps } });
          // Warm up the CF session in the background so that handleStartDebug
          // never hits an expired token when the app list came from cache.
          // Failures are silently retried with a full re-login.
          void this.ensureCfSession(config.apiEndpoint, org, space);
          return;
        }
      }
    }

    if (forceRefresh) {
      const credentialsRevoked = await this.refreshCfSyncSpaceCache(config.apiEndpoint, org, space);
      if (credentialsRevoked) return;
    }

    logInfo(`Loading apps for target: ${org}/${space} …`);
    try {
      const apps = await this.loadLiveApps(config.apiEndpoint, org, space);
      await saveCachedApps(config.apiEndpoint, org, apps, space);
      const started = apps.filter((a) => a.state === 'started').length;
      logInfo(`Apps loaded: ${apps.length.toString()} total, ${started.toString()} started.`);
      this.postMessage({ type: 'APPS_LOADED', payload: { apps } });
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`Failed to load apps for ${org}/${space}: ${msg}`);
      const revoked = await this.handleAuthFailure(err);
      if (!revoked) {
        this.postMessage({ type: 'APPS_ERROR', payload: { message: msg } });
      }
    }
  }

  private async refreshCfSyncSpaceCache(apiEndpoint: string, org: string, space: string): Promise<boolean> {
    const { email, password } = await getCredentials();
    const result = await refreshCfSyncSpace({ apiEndpoint, orgName: org, spaceName: space, email, password });

    if (result.status === 'refreshed') {
      logInfo(`[Reload] cf-sync refreshed ${result.regionKey}/${org}/${space} (${result.appCount.toString()} app(s)).`);
      return false;
    }

    if (result.status === 'skipped') {
      logWarn(`[Reload] cf-sync space refresh skipped: ${result.reason}.`);
      return false;
    }

    const revoked = await this.handleAuthFailure(result.error);
    if (revoked) return true;
    logWarn(`[Reload] cf-sync space refresh failed: ${extractErrorMessage(result.error)}`);
    return false;
  }

  private async loadLiveSpaces(apiEndpoint: string, org: string): Promise<string[]> {
    try {
      return await cfTargetOrgAndSpaces(org);
    } catch (err: unknown) {
      if (!isAuthError(err)) throw err;
      logInfo(`cfTargetOrgAndSpaces auth failed — attempting re-login before loading spaces for ${org}.`);
      await this.reLogin(apiEndpoint);
      return await cfTargetOrgAndSpaces(org);
    }
  }

  private async loadLiveApps(apiEndpoint: string, org: string, space: string): Promise<CfApp[]> {
    try {
      return await cfTargetAndApps(org, space);
    } catch (err: unknown) {
      if (!isAuthError(err)) throw err;
      logInfo(`cfTargetAndApps auth failed — attempting re-login before loading apps for ${org}/${space}.`);
      await this.reLogin(apiEndpoint);
      return await cfTargetAndApps(org, space);
    }
  }

  private async handleStartDebug(appNames: string[], org: string, space: string): Promise<void> {
    const config = getConfig();
    if (!config) return;

    const mapping = config.orgGroupMappings.find((m) => mappingMatchesTarget(m, org, space));
    if (!mapping) {
      const msg = `No mapping found for org/space: ${org}/${space}`;
      logError(msg);
      this.postMessage({ type: 'DEBUG_ERROR', payload: { message: msg } });
      return;
    }

    logInfo(`Starting debug for ${appNames.length.toString()} app(s): ${appNames.join(', ')}`);

    // Always target the org before opening the cf ssh tunnel. handleLoadApps may have
    // served apps from cache without calling cfTarget, leaving ~/.cf untargeted.
    // If the token has expired in the meantime, re-login automatically.
    logInfo(`[StartDebug] Targeting CF org/space: ${org}/${space}…`);
    try {
      await cfTarget(org, space);
      logInfo(`[StartDebug] CF org/space targeted successfully.`);
    } catch {
      logInfo(`cfTarget failed — attempting re-login before starting debug for ${org}/${space}.`);
      try {
        logInfo(`[StartDebug] Re-authenticating to ${config.apiEndpoint}…`);
        await this.reLogin(config.apiEndpoint);
        logInfo(`[StartDebug] Re-authentication successful. Targeting org/space again…`);
        await cfTarget(org, space);
        logInfo(`[StartDebug] CF org/space targeted after re-login.`);
      } catch (retryErr: unknown) {
        const msg = extractErrorMessage(retryErr);
        logError(`Failed to target org/space ${org}/${space} after re-login: ${msg}`);
        // Auth failure → clear stale keychain creds and redirect to credential setup.
        const revoked = await this.handleAuthFailure(retryErr);
        if (!revoked) {
          this.postMessage({ type: 'DEBUG_ERROR', payload: { message: `CF target failed: ${msg}` } });
        }
        return;
      }
    }

    const groupPath = mapping.groupFolderPath;

    logInfo(`[StartDebug] Resolving local folders under: ${groupPath}`);
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
    logInfo(`[StartDebug] Folder resolution complete. ${resolvedPaths.length.toString()}/${appNames.length.toString()} apps mapped.`);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? mapping.groupFolderPath;

    const existingPorts: Record<string, number> = {};
    const usedPorts = new Set<number>();
    try {
      const existingConfigs = await getExistingLaunchConfigs(workspaceRoot);
      for (const c of existingConfigs.configurations) {
        if (c.port) usedPorts.add(c.port);
        if (c.name.startsWith('Debug: ')) {
          existingPorts[c.name.slice(7)] = c.port;
        }
      }
    } catch {
      // Ignore errors parsing launch.json
    }

    const { targets, unmapped } = buildDebugTargets(appNames, resolvedPaths, existingPorts, usedPorts);

    const sharedCapConfig = await resolveSharedCapDebugConfig(workspaceRoot);

    if (targets.length === 0) {
      // All apps unmapped — build fallback targets using workspaceRoot so debug can still proceed.
      // Source maps won't resolve, but the SSH tunnel and debug console will work.
      logWarn(`No local folder found for any selected app. Starting debug in console-only mode (no source maps).`);
      const fallbackTargets = buildFallbackTargets(unmapped, workspaceRoot, existingPorts, usedPorts);
      await this.launchDebugSessions(fallbackTargets, workspaceRoot, [], sharedCapConfig);
      return;
    }

    // Branch preparation is an experimental feature — only run when explicitly enabled.
    const debugPrefs = getDebugPreferences();
    let finalTargets: DebugTarget[];

    if (debugPrefs.enableBranchPrep) {
      // Resolve target branches: config lookup + optional QuickPick for unconfigured repos
      const branchInfos = await this.resolveTargetBranches(targets, org, sharedCapConfig);

      // Services with a target branch go through preparation; others proceed directly
      const servicesNeedingPrep = branchInfos.filter((b) => b.targetBranch !== null);
      const targetsSkippingPrep = targets.filter((t) => !branchInfos.find((b) => b.appName === t.appName)?.targetBranch);

      if (servicesNeedingPrep.length > 0) {
        const prepServices: BranchPrepService[] = servicesNeedingPrep.map((b) => ({
          appName: b.appName,
          targetBranch: b.targetBranch ?? '',
          currentBranch: b.currentBranch ?? 'unknown',
        }));
        this.postMessage({ type: 'BRANCH_PREP_START', payload: { services: prepServices } });

        const prepSuccessful = await this.runBranchPreparation(targets, branchInfos);
        finalTargets = [...targetsSkippingPrep, ...prepSuccessful];
      } else {
        finalTargets = targets;
      }
    } else {
      finalTargets = targets;
    }

    if (finalTargets.length === 0) {
      this.postMessage({ type: 'DEBUG_ERROR', payload: { message: 'Branch preparation failed for all services.' } });
      return;
    }

    await this.launchDebugSessions(finalTargets, workspaceRoot, unmapped, sharedCapConfig);
  }

  /**
   * Determines the target branch for each debug target.
   * Priority: per-app `branch` field > shared fallback `orgBranchMap` > per-app `orgBranchMap` > QuickPick.
   * QuickPick is shown once per git repo root to avoid duplicate prompts in monorepos.
   */
  private async resolveTargetBranches(
    targets: DebugTarget[],
    org: string,
    fallbackConfig: CapDebugConfig | null,
  ): Promise<ServiceBranchInfo[]> {
    // Pre-fetch repo roots and per-app configs in parallel (deduplicated by folder path)
    const uniqueFolderPaths = [...new Set(targets.map((t) => t.folderPath))];
    const [repoRootResults, appConfigResults] = await Promise.all([
      Promise.all(uniqueFolderPaths.map((p) => getGitRepoRoot(p))),
      Promise.all(uniqueFolderPaths.map((p) => readCapDebugConfig(p))),
    ]);
    const repoRoots = new Map(uniqueFolderPaths.map((p, i) => [p, repoRootResults[i]]));
    const appConfigs = new Map(uniqueFolderPaths.map((p, i) => [p, appConfigResults[i]]));

    const resolvedBranches = new Map<string, string | null>();
    const reposNeedingPrompt = new Map<string, string[]>(); // repoRoot → appNames
    const currentBranches = new Map<string, string | null>(); // repoRoot → currentBranch

    for (const target of targets) {
      const repoRoot = repoRoots.get(target.folderPath) ?? null;
      const appConfig = appConfigs.get(target.folderPath);

      if (appConfig?.branch) {
        resolvedBranches.set(target.appName, appConfig.branch);
      } else {
        const orgMap = fallbackConfig?.orgBranchMap ?? appConfig?.orgBranchMap;
        if (orgMap?.[org]) {
          resolvedBranches.set(target.appName, orgMap[org]);
        } else if (repoRoot) {
          if (!reposNeedingPrompt.has(repoRoot)) reposNeedingPrompt.set(repoRoot, []);
          const queuedNames = reposNeedingPrompt.get(repoRoot);
          if (queuedNames) queuedNames.push(target.appName);
        } else {
          resolvedBranches.set(target.appName, null);
        }
      }
    }

    // Show one QuickPick per repo; fetch branches + currentBranch in parallel
    for (const [repoRoot, appNamesForRepo] of reposNeedingPrompt) {
      const [branches, currentBranch] = await Promise.all([listBranches(repoRoot), getCurrentBranch(repoRoot)]);
      currentBranches.set(repoRoot, currentBranch);

      type BranchItem = vscode.QuickPickItem & { branch: string | null };
      const items: BranchItem[] = [
        {
          label: '$(close) Skip branch switch',
          description: currentBranch ? `Keep current: ${currentBranch}` : 'Keep current branch',
          branch: null,
        },
        ...branches.map((b): BranchItem => {
          const item: BranchItem = { label: `$(git-branch) ${b}`, branch: b };
          if (b === currentBranch) item.description = 'current';
          return item;
        }),
      ];

      const selected = await vscode.window.showQuickPick(items, {
        title: `Select branch to debug: ${appNamesForRepo.join(', ')}`,
        placeHolder: `Current branch: ${currentBranch ?? 'unknown'}`,
        matchOnDescription: true,
      });

      const chosenBranch = selected ? selected.branch : null;
      for (const appName of appNamesForRepo) {
        resolvedBranches.set(appName, chosenBranch);
      }
    }

    // Fetch currentBranch for repos that had a configured branch (skipped QuickPick path)
    const reposWithoutCurrentBranch = [...new Set(
      repoRootResults.filter((r): r is string => r !== null && !currentBranches.has(r)),
    )];
    if (reposWithoutCurrentBranch.length > 0) {
      const fetched = await Promise.all(reposWithoutCurrentBranch.map((r) => getCurrentBranch(r)));
      reposWithoutCurrentBranch.forEach((r, i) => currentBranches.set(r, fetched[i] ?? null));
    }

    return targets.map((target) => {
      const repoRoot = repoRoots.get(target.folderPath) ?? null;
      return {
        appName: target.appName,
        folderPath: target.folderPath,
        repoRoot,
        targetBranch: resolvedBranches.get(target.appName) ?? null,
        currentBranch: repoRoot ? (currentBranches.get(repoRoot) ?? null) : null,
      };
    });
  }

  /**
   * Runs branch preparation (stash → checkout → install → build) for services
   * that have a target branch. Handles monorepos by processing each git root once.
   * Returns the list of DebugTargets whose preparation succeeded.
   */
  private async runBranchPreparation(
    targets: DebugTarget[],
    branchInfos: ServiceBranchInfo[],
  ): Promise<DebugTarget[]> {
    const successfulTargets: DebugTarget[] = [];

    // Track per-repo whether a branch checkout was performed (for monorepo pnpm sharing)
    const repoCheckedOut = new Map<string, boolean>();

    const postStatus = (appName: string, step: BranchPrepStep, message?: string): void => {
      const payload: { appName: string; step: BranchPrepStep; message?: string } = { appName, step };
      if (message !== undefined) payload.message = message;
      this.postMessage({ type: 'BRANCH_PREP_STATUS', payload });
    };

    for (const info of branchInfos) {
      if (info.targetBranch === null) continue; // handled separately (targetsSkippingPrep)

      const target = targets.find((t) => t.appName === info.appName);
      if (!target) continue;

      const repoRoot = info.repoRoot ?? info.folderPath;
      const alreadyProcessedRepo = repoCheckedOut.has(repoRoot);

      try {
        if (!alreadyProcessedRepo) {
          const currentBranch = info.currentBranch;
          let changedWorkingTree = false;

          // Stash uncommitted changes if any
          const dirty = await hasUncommittedChanges(repoRoot);
          if (dirty) {
            logInfo(`[${info.appName}] Stashing uncommitted changes in ${repoRoot}`);
            postStatus(info.appName, 'stashing');
            const stashed = await stashChanges(repoRoot);
            if (stashed) changedWorkingTree = true;
          }

          if (currentBranch !== info.targetBranch) {
            logInfo(`[${info.appName}] Checking out branch ${info.targetBranch} in ${repoRoot}`);
            postStatus(info.appName, 'checking-out');
            await checkoutBranch(repoRoot, info.targetBranch);
            changedWorkingTree = true;
          }

          logInfo(`[${info.appName}] Pulling latest changes for branch ${info.targetBranch} in ${repoRoot}`);
          postStatus(info.appName, 'pulling');
          const pullResult = await pullLatest(repoRoot);
          if (pullResult.changed) {
            changedWorkingTree = true;
          }

          if (!changedWorkingTree) {
            // Already on the correct branch, no local changes stashed, and no remote updates
            logInfo(`[${info.appName}] Branch ${info.targetBranch} is up to date, skipping install/build.`);
            postStatus(info.appName, 'skipped', `Up to date`);
            repoCheckedOut.set(repoRoot, false);
            successfulTargets.push(target);
            continue;
          }

          repoCheckedOut.set(repoRoot, true);
        } else if (!repoCheckedOut.get(repoRoot)) {
          // Shared repo that was already up to date — skip this service too
          logInfo(`[${info.appName}] Shared repo already up to date, skipping git ops.`);
          postStatus(info.appName, 'skipped', `Up to date`);
          successfulTargets.push(target);
          continue;
        }

        // Run pnpm install + build after checkout
        logInfo(`[${info.appName}] Running pnpm install in ${info.folderPath}`);
        postStatus(info.appName, 'installing');
        await runPnpmInstall(info.folderPath);

        logInfo(`[${info.appName}] Running pnpm build in ${info.folderPath}`);
        postStatus(info.appName, 'building');
        await runPnpmBuild(info.folderPath);

        logInfo(`[${info.appName}] Branch preparation complete.`);
        postStatus(info.appName, 'done');
        successfulTargets.push(target);
      } catch (err: unknown) {
        const msg = extractErrorMessage(err);
        logError(`Branch prep failed for ${info.appName}: ${msg}`);
        postStatus(info.appName, 'error', msg);
      }
    }

    return successfulTargets;
  }

  /** Merges launch.json, posts DEBUG_CONNECTING, and starts tunnel processes. */
  private async launchDebugSessions(
    targets: DebugTarget[],
    workspaceRoot: string,
    unmapped: string[],
    fallbackConfig: CapDebugConfig | null,
  ): Promise<void> {
    logInfo(`[StartDebug] Merging launch.json for ${targets.length.toString()} target(s)…`);
    await mergeLaunchJson(workspaceRoot, targets, fallbackConfig);
    logInfo(`Updated .vscode/launch.json with ${targets.length.toString()} config(s).`);

    const ports: Record<string, number> = {};
    for (const target of targets) {
      ports[target.appName] = target.port;
    }
    const noLocalFolderApps = targets.filter((t) => t.noLocalFolder).map((t) => t.appName);
    this.postMessage({
      type: 'DEBUG_CONNECTING',
      payload: {
        appNames: targets.map((t) => t.appName),
        ports,
        ...(noLocalFolderApps.length > 0 ? { unmappedApps: noLocalFolderApps } : {}),
      },
    });

    for (const target of targets) {
      const launchConfigName = `Debug: ${target.appName}`;
      void startTunnelAndAttach(target.appName, target.folderPath, target.port, launchConfigName).catch((err: unknown) => {
        logError(`Failed to start tunnel for ${target.appName}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    if (unmapped.length > 0) {
      logWarn(`${unmapped.length.toString()} app(s) not mapped: ${unmapped.join(', ')}`);
      void vscode.window.showWarningMessage(
        `${unmapped.length.toString()} app(s) could not be mapped to a local folder: ${unmapped.join(', ')}`,
      );
    }
  }

  private handleOpenAppUrl(rawUrl: string, source: 'manual' | 'auto'): void {
    // Extension is the authoritative gatekeeper for auto-opens.
    // Webview state can be stale due to timing races; globalState is always the truth.
    if (source === 'auto' && !getDebugPreferences().openBrowserOnAttach) {
      logInfo('Auto-open blocked: openBrowserOnAttach is disabled in preferences.');
      return;
    }
    const safeUri = toSafeHttpUri(rawUrl);
    if (!safeUri) {
      const msg = 'Blocked unsafe or malformed app URL.';
      logWarn(msg);
      this.postMessage({ type: 'DEBUG_ERROR', payload: { message: msg } });
      return;
    }
    void vscode.env.openExternal(safeUri);
  }

  /** Builds a CredentialStatus snapshot for the current session. */
  private async buildCredentialStatus(): Promise<CredentialStatus> {
    const e2eOverride = getE2eCredentialStatusOverride();
    if (e2eOverride) return e2eOverride;

    const { email } = await getCredentials();
    const source = await getCredentialSource();
    return {
      hasCredentials: !!(email),
      email,
      source,
    };
  }

  private async handleSaveCredentials(email: string, password: string): Promise<void> {
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0 || !trimmedEmail.includes('@')) {
      this.postMessage({ type: 'CREDENTIALS_ERROR', payload: { message: 'Please enter a valid email address.' } });
      return;
    }
    if (!password) {
      this.postMessage({ type: 'CREDENTIALS_ERROR', payload: { message: 'Password is required.' } });
      return;
    }
    try {
      await saveCredentialsToSecretStorage(trimmedEmail, password);
      logInfo(`[Credentials] Saved credentials for ${maskEmail(trimmedEmail)} to SecretStorage.`);
      this.postMessage({
        type: 'CREDENTIALS_SAVED',
        payload: { email: trimmedEmail, source: 'keychain' },
      });
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`[Credentials] Failed to save credentials: ${msg}`);
      this.postMessage({ type: 'CREDENTIALS_ERROR', payload: { message: `Could not save credentials: ${msg}` } });
    }
  }

  private async handleClearCredentials(): Promise<void> {
    await clearCredentialsFromSecretStorage();
    const status = await this.buildCredentialStatus();
    logInfo('[Credentials] Credentials cleared from SecretStorage.');
    this.postMessage({ type: 'CREDENTIALS_STATUS', payload: status });
  }

  /**
   * Called when a CF authentication error is detected (wrong/expired credentials).
   * If the active credential source is 'keychain', clears the stale stored credentials
   * and sends CREDENTIALS_REVOKED to the webview so the user is redirected to the
   * Setup Credentials screen immediately.
   *
   * Returns true if credentials were revoked (keychain source), false otherwise.
   * Callers should skip posting their own error message when this returns true,
   * as the redirect to SETUP_CREDENTIALS replaces the normal error flow.
   */
  private async handleAuthFailure(err: unknown): Promise<boolean> {
    if (!isAuthError(err)) return false;
    const source = await getCredentialSource();
    if (source !== 'keychain') return false;
    // Only auto-revoke keychain credentials — env-var credentials are managed externally.
    await clearCredentialsFromSecretStorage();
    logInfo('[Credentials] Auth failure with keychain credentials — cleared and prompting for new credentials.');
    this.postMessage({
      type: 'CREDENTIALS_REVOKED',
      payload: { message: 'Credentials rejected by Cloud Foundry. Please enter your updated credentials.' },
    });
    return true;
  }

  /**
   * Re-authenticates against the CF API using stored credentials.
   * Used as a recovery path when a cached app list is loaded and the
   * interactive CF token has since expired.
   */
  private async reLogin(apiEndpoint: string): Promise<void> {
    const { email, password } = await getCredentials();
    if (!email || !password) {
      throw new Error('No credentials available — cannot re-authenticate. Please set credentials in the extension.');
    }
    logInfo(`Re-authenticating to ${apiEndpoint} after token expiry…`);
    try {
      await cfLogout();
    } catch {
      // Ignore logout failure when there is no prior session.
    }
    await cfLogin(apiEndpoint, email, password);
    logInfo('Re-authentication successful.');
  }

  /**
   * Targets the given CF org in the background to keep ~/.cf warmed up.
   * Called after serving apps from cache so that handleStartDebug never
   * encounters an expired token as the very first CF CLI invocation.
   */
  private async ensureCfSession(apiEndpoint: string, org: string, space: string): Promise<void> {
    try {
      await cfTarget(org, space);
      logInfo(`[Session] CF session refreshed — target ${org}/${space} selected.`);
    } catch {
      logInfo(`[Session] cfTarget failed — attempting silent re-login for ${org}/${space}.`);
      try {
        await this.reLogin(apiEndpoint);
        await cfTarget(org, space);
        logInfo(`[Session] Silent re-login successful — target ${org}/${space} selected.`);
      } catch (err: unknown) {
        logWarn(`[Session] Silent re-login failed: ${err instanceof Error ? err.message : String(err)}`);
        // Proactively clear stale keychain credentials so the user is redirected to
        // the setup screen before they attempt to start a debug session and hit the
        // same auth failure again.
        await this.handleAuthFailure(err);
      }
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

/**
 * Returns true when the error looks like a CF authentication failure
 * (wrong credentials, expired password, etc.) rather than a network or
 * server-side issue.  Checks both the Node.js error message and, when the
 * error is a CfCliError, the raw CF CLI stderr output.
 */
function isAuthError(err: unknown): boolean {
  const message = extractErrorMessage(err).toLowerCase();
  const stderr = err instanceof CfCliError ? err.stderr.toLowerCase() : '';
  const combined = `${message} ${stderr}`;
  return (
    combined.includes('authentication failed') ||
    combined.includes('credentials were rejected') ||
    combined.includes('invalid credentials') ||
    combined.includes('unauthorized') ||
    combined.includes('not authorized') ||
    combined.includes('invalid_grant')
  );
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

function isBreakpointSnapshot(value: unknown): value is BreakpointContextSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string'
    && typeof rec.appName === 'string'
    && typeof rec.sessionName === 'string'
    && Array.isArray(rec.scopes)
  );
}
