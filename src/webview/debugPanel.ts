import * as vscode from 'vscode';
import type {
  AppFolderMapping,
  BranchPrepService,
  BranchPrepStep,
  BreakpointContextSnapshot,
  CacheSettings,
  CapDebugConfig,
  CfApp,
  CredentialStatus,
  DebugTarget,
  ExtensionConfig,
  E2eBridgeCommand,
  ExtensionMessage,
  LoadedPackageEntry,
  LoadedPackageSource,
  PackageSourceLocation,
  OrgGroupMapping,
  SharedCfScope,
  SyncProgress,
  WebviewMessage,
} from '../types/index';
import { CF_DEFAULT_SPACE, DEFAULT_CACHE_SETTINGS } from '../types/index';
import {
  cfLogin,
  cfLogout,
  cfOrgs,
  cfTarget,
  cfTargetAndApps,
  cfTargetOrgAndSpaces,
  cfScaleAppInstances,
  isCfAuthError,
} from '../core/cfClient';
import {
  refreshCfSyncRegionOrgs,
  refreshCfSyncSpace,
  resolveRegionKeyForEndpoint,
} from '../core/cfSpaceRefresh';
import { findRepoFolder } from '../core/folderScanner';
import {
  buildDebugTargets,
  buildFallbackTargets,
  getFolderNameCandidates,
  resolveOverrideFolder,
} from '../core/appMapper';
import { getAppFolderMappings } from '../core/appFolderMappingSettings';
import { getExistingLaunchConfigs, mergeLaunchJson, readCapDebugConfig } from '../core/launchConfigurator';
import { resolveSharedCapDebugConfig } from '../core/capDebugConfig';
import {
  parseRemoteRootSetting,
  RemoteRootLookupCoordinator,
  type RemoteRootResolution,
} from '../core/remoteRootResolver';
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
  getLastSpaceRefreshAt,
  saveCachedApps,
  saveCacheSettings,
  saveDebugPreferences,
  saveDebugSessionPackagePreferences,
  saveLastSpaceRefreshAt,
} from '../storage/cacheStore';
import { buildCfApiEndpoint, regionCodeFromApiEndpoint, writeScopeIfChanged } from '../storage/scopeSync';
import {
  cacheSyncEvents,
  getCurrentSyncProgress,
  requestCacheSyncStop,
  restartCacheSyncTimer,
  runCacheSync,
  syncSingleRegion,
} from '../core/cacheSync';
import { getAppsFromTopologySync, getTopologySnapshot, getTopologySnapshotSync } from '../core/cfTopology';
import { logError, logInfo, logWarn, showLogChannel } from '../core/logger';
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
  getActiveAppNames,
  getProcessOutputChannel,
  getSessionParams,
  setBeforeReconnectHook,
} from '../core/processManager';
import { breakpointSnapshotEvents, clearBreakpointSnapshots, getBreakpointSnapshots } from '../core/breakpointSnapshotManager';
import {
  createPackageSearchIndex,
  loadPackageEntriesFromSessions,
  openPackageSource,
  searchPackageEntries,
  type PackageSearchIndex,
} from '../core/packageSourceBrowser';
import { getLoadedSourcesForSessionIds, onLoadedSourceChanged } from '../core/loadedSourceRegistry';
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
  describeGitBranchForLog,
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

const MIN_BADGE_SCALE_INSTANCES = 1;

export function buildLoginConfig(
  apiEndpoint: string,
  orgs: string[],
  existing: ExtensionConfig | undefined,
): ExtensionConfig {
  return {
    apiEndpoint,
    orgs,
    orgGroupMappings: existing?.orgGroupMappings ?? [],
  };
}

export class DebugLauncherViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'cdsDebug.mainView';

  private view?: vscode.WebviewView;
  private readonly packageEntriesByApp = new Map<string, LoadedPackageEntry[]>();
  private readonly packageSearchIndexByApp = new Map<string, PackageSearchIndex>();
  private readonly resolvedRemoteRoots = new Map<string, string>();
  // Parallel map keyed by appName so reconnect re-merges can pick up the cached
  // remoteRoot without needing to recompute the (apiEndpoint, org, space) cache key.
  private readonly resolvedRemoteRootByApp = new Map<string, string>();
  private readonly remoteRootLookupCoordinator = new RemoteRootLookupCoordinator();
  // Tracks (apiEndpoint, org, space, appName, configuredRemoteRoot) keys that have already
  // surfaced a "remoteRoot did not resolve" notification, so we do not nag the user during
  // each Start Debug click. Cleared on Reset Configuration / window reload by definition.
  private readonly notifiedUnmatchedRemoteRoots = new Set<string>();
  private readonly warmupPromises = new Map<string, Promise<void>>();
  private scopeChangeQueue: Promise<void> = Promise.resolve();
  private lastWrittenScope: SharedCfScope | undefined;
  private pendingExternalScope: SharedCfScope | undefined;

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
    cacheSyncEvents.on('regionWarmed', () => {
      void this.pushCfTopology();
    });
    breakpointSnapshotEvents.on('snapshotAdded', (snapshot: unknown) => {
      if (!isBreakpointSnapshot(snapshot)) return;
      this.postMessage({ type: 'BREAKPOINT_SNAPSHOT_ADDED', payload: { snapshot } });
    });
    setBeforeReconnectHook((appName, params) => this.handleBeforeReconnect(appName, params));
  }

  private async handleBeforeReconnect(
    appName: string,
    params: { folderPath: string; port: number; launchConfigName: string },
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot === undefined) return;

    const target: DebugTarget = { appName, folderPath: params.folderPath, port: params.port };
    const fallbackConfig = await resolveSharedCapDebugConfig(workspaceRoot);
    const cachedRemoteRoot = this.resolvedRemoteRootByApp.get(appName);
    const resolvedRemoteRoots = cachedRemoteRoot !== undefined
      ? new Map([[appName, cachedRemoteRoot]])
      : new Map<string, string>();

    try {
      await mergeLaunchJson(workspaceRoot, [target], fallbackConfig, { resolvedRemoteRoots });
      logInfo(`[${appName}] Reconnect re-merged launch.json from current cap-debug-config.json.`);
    } catch (err: unknown) {
      logWarn(`[${appName}] Reconnect re-merge of launch.json failed: ${extractErrorMessage(err)}`);
    }
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

  public handleExternalScopeChange(scope: SharedCfScope): void {
    if (this.isLastWrittenScope(scope)) {
      return;
    }

    this.scopeChangeQueue = this.scopeChangeQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.isLastWrittenScope(scope)) return;
        await this.handleScopeChangeInternal(scope);
      })
      .catch((err: unknown) => {
        logWarn(`[ScopeSync] Scope change handling failed: ${extractErrorMessage(err)}`);
      });
  }

  private isLastWrittenScope(scope: SharedCfScope): boolean {
    return this.lastWrittenScope?.regionCode === scope.regionCode
      && this.lastWrittenScope.orgName === scope.orgName
      && this.lastWrittenScope.spaceName === scope.spaceName;
  }

  private async handleScopeChangeInternal(scope: SharedCfScope): Promise<void> {
    await this.stopActiveSessionsForScopeChange();

    const config = getConfig();
    const activeRegionCode = config ? regionCodeFromApiEndpoint(config.apiEndpoint) : undefined;

    if (config && activeRegionCode === scope.regionCode) {
      this.postScopeSyncForMapping(scope);
      return;
    }

    await this.handleExternalRegionChange(scope);
  }

  private async stopActiveSessionsForScopeChange(): Promise<void> {
    const activeApps = getActiveAppNames();
    if (activeApps.length === 0) return;

    const appList = activeApps.join(', ');
    logInfo(
      `[ScopeSync] Stopping ${activeApps.length.toString()} active debug session(s) due to external scope change: ${appList}`,
    );

    await stopAllProcesses();
    clearBreakpointSnapshots();
    this.postMessage({ type: 'BREAKPOINT_SNAPSHOTS', payload: { snapshots: [] } });

    void vscode.window.showInformationMessage(
      `CDS Debug: stopped debug session(s) for ${appList} due to CF scope change.`,
    );
  }

  private async handleExternalRegionChange(scope: SharedCfScope): Promise<void> {
    const newApiEndpoint = buildCfApiEndpoint(scope.regionCode);
    const { email, password } = await getCredentials();
    if (!email || !password) {
      this.pendingExternalScope = scope;
      this.postMessage({
        type: 'REGION_PREFILL',
        payload: { regionCode: scope.regionCode, apiEndpoint: newApiEndpoint },
      });
      logWarn('[ScopeSync] No stored credentials — pre-filled region endpoint for manual login.');
      return;
    }

    this.pendingExternalScope = undefined;

    try {
      try {
        await cfLogout();
      } catch {
        // Safe to ignore: logout fails when no prior session exists.
      }

      await cfLogin(newApiEndpoint, email, password);
      const orgs = await cfOrgs();
      const existing = getConfig();
      await saveConfig(buildLoginConfig(newApiEndpoint, orgs, existing));
      this.postMessage({ type: 'LOGIN_SUCCESS', payload: { orgs, apiEndpoint: newApiEndpoint } });

      if (!orgs.includes(scope.orgName)) return;
      this.postScopeSyncForMapping(scope);
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`[ScopeSync] Cross-region auto-login failed: ${msg}`);
      const revoked = await this.handleAuthFailure(err);
      if (!revoked) {
        this.postMessage({ type: 'LOGIN_ERROR', payload: { message: msg } });
      }
    }
  }

  private applyPendingExternalScopeIfAny(orgs: string[]): void {
    const scope = this.pendingExternalScope;
    if (!scope) return;
    this.pendingExternalScope = undefined;
    if (!orgs.includes(scope.orgName)) return;
    this.postScopeSyncForMapping(scope);
  }

  private postScopeSyncForMapping(scope: SharedCfScope): void {
    const config = getConfig();
    const hasMapping = config?.orgGroupMappings.some((mapping) => (
      mappingMatchesTarget(mapping, scope.orgName, scope.spaceName)
    )) ?? false;
    this.postMessage({
      type: hasMapping ? 'SCOPE_SYNCED' : 'SCOPE_SYNCED_NO_MAPPING',
      payload: { orgName: scope.orgName, spaceName: scope.spaceName },
    });
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
        this.postMessage({ type: 'CF_TOPOLOGY', payload: getTopologySnapshotSync() });
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
        this.bootstrapCacheSyncForExistingCredentials(credentialStatus);
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
        await this.handleLogin(raw.payload.apiEndpoint, raw.payload.topologyOrgName);
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

      case 'WARMUP_CF_SESSION':
        await this.handleWarmupCfSession(
          raw.payload.org,
          raw.payload.space ?? CF_DEFAULT_SPACE,
        );
        break;

      case 'START_DEBUG':
        await this.handleStartDebug(
          raw.payload.appNames,
          raw.payload.org,
          raw.payload.space ?? CF_DEFAULT_SPACE,
        );
        break;

      case 'SCALE_APP_INSTANCES':
        await this.handleScaleAppInstances(
          raw.payload.appName,
          raw.payload.org,
          raw.payload.space ?? CF_DEFAULT_SPACE,
          raw.payload.targetInstances,
        );
        break;

      case 'STOP_DEBUG':
        await stopProcess(raw.payload.appName);
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

      case 'WEBVIEW_ERROR': {
        // The webview has no dev console in normal use — surfacing its uncaught
        // errors here is the only way to diagnose intermittent blank-panel reports.
        const { context, message, stack, screen } = raw.payload;
        logError(`[Webview] ${context} (screen=${screen}): ${message}${stack ? `\n${stack}` : ''}`);
        break;
      }

      case 'STOP_ALL_DEBUG': {
        await stopAllProcesses();
        break;
      }
        
      case 'OPEN_APP_URL':
        this.handleOpenAppUrl(raw.payload.url, raw.payload.source);
        break;

      case 'RESET_LOGIN':
        await stopAllProcesses();
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
        requestCacheSyncStop();
        await stopAllProcesses();
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
    await stopProcess(appName, /* skipConfigCleanup */ true, /* silent */ true);
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
      const openedUri = await openPackageSource(
        session,
        source,
        location,
        { ...(localRoot ? { localRoot } : {}), appName },
      );
      this.logPackageDiagnostic(
        appName,
        `Opened editor URI scheme=${openedUri.scheme} query="${openedUri.query || '<none>'}" toString=${openedUri.toString()}`,
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

    // Push-collected sources for whichever sessions currently belong to the app. Resolved
    // lazily each attempt so child "Remote Process" sessions that appear mid-warm-up are
    // included as soon as they exist.
    const getExtraSources = (): readonly LoadedPackageSource[] =>
      getLoadedSourcesForSessionIds(resolveSessions().map((session) => session.id));

    // Wake the warm-up retry the instant a new session starts OR a loadedSource event
    // arrives, instead of sleeping the full poll interval.
    const pendingWakeResolvers: (() => void)[] = [];
    const wakeAll = (): void => { for (const resolve of pendingWakeResolvers.splice(0)) resolve(); };
    const sessionDisposable = vscode.debug.onDidStartDebugSession(wakeAll);
    const loadedSourceDisposable = onLoadedSourceChanged(wakeAll);
    const makeWakeSignal = (): Promise<void> =>
      new Promise<void>((resolve) => { pendingWakeResolvers.push(resolve); });

    let packages: LoadedPackageEntry[];
    try {
      packages = await loadPackageEntriesFromSessions(
        appName,
        resolveSessions,
        log,
        { makeWakeSignal, getExtraSources },
      );
    } finally {
      sessionDisposable.dispose();
      loadedSourceDisposable.dispose();
      wakeAll();
    }

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

  private async handleLogin(apiEndpoint: string, topologyOrgName?: string): Promise<void> {
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
      const topologyShortcut = topologyOrgName
        ? this.loadTopologyShortcutLoginOrgs(apiEndpoint, topologyOrgName)
        : undefined;
      const loginOrgs = topologyShortcut ?? await this.loadLoginOrgs(apiEndpoint, email, password);
      const orgs = loginOrgs.orgs;

      const existing = getConfig();
      await saveConfig(buildLoginConfig(apiEndpoint, orgs, existing));
      this.postMessage({ type: 'LOGIN_SUCCESS', payload: { orgs, apiEndpoint } });
      this.applyPendingExternalScopeIfAny(orgs);
      this.startSingleRegionSyncAfterLogin(apiEndpoint, email, password, loginOrgs.topologyAlreadyAvailable);
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

  private loadTopologyShortcutLoginOrgs(
    apiEndpoint: string,
    orgName: string,
  ): { orgs: string[]; topologyAlreadyAvailable: boolean } | undefined {
    const topologyOrgs = this.getTopologyOrgsForEndpoint(apiEndpoint);
    if (!topologyOrgs?.includes(orgName)) return undefined;

    logInfo(`[Topology] Continuing with synced org ${orgName}; skipped region org refresh for ${apiEndpoint}.`);
    return { orgs: topologyOrgs, topologyAlreadyAvailable: true };
  }

  private async loadLoginOrgs(
    apiEndpoint: string,
    email: string,
    password: string,
  ): Promise<{ orgs: string[]; topologyAlreadyAvailable: boolean }> {
    const topologyOrgs = this.getTopologyOrgsForEndpoint(apiEndpoint);
    const topologyAlreadyAvailable = topologyOrgs !== undefined;
    const refreshed = await refreshCfSyncRegionOrgs({ apiEndpoint, email, password });

    if (refreshed.status === 'refreshed') {
      logInfo(`[cf-sync] Refreshed ${refreshed.orgNames.length.toString()} org(s) for ${refreshed.regionKey}.`);
      void this.pushCfTopology();
      return { orgs: refreshed.orgNames, topologyAlreadyAvailable };
    }

    if (refreshed.status === 'failed') {
      logWarn(
        `[cf-sync] Region org refresh failed for ${refreshed.regionKey}: ${extractErrorMessage(refreshed.error)}. Falling back to live cf orgs.`,
      );
    }

    try {
      const orgs = await cfOrgs();
      logInfo(`Login successful. Found ${orgs.length.toString()} org(s): ${orgs.join(', ')}`);
      return { orgs, topologyAlreadyAvailable };
    } catch (error: unknown) {
      if (!topologyOrgs) throw error;
      logWarn(`[Topology] Live cf orgs failed for ${apiEndpoint}; using ${topologyOrgs.length.toString()} synced org(s).`);
      return { orgs: topologyOrgs, topologyAlreadyAvailable };
    }
  }

  private getTopologyOrgsForEndpoint(apiEndpoint: string): string[] | undefined {
    const normalized = normalizeEndpoint(apiEndpoint);
    const orgs = getTopologySnapshotSync().accounts
      .filter((account) => normalizeEndpoint(account.apiEndpoint) === normalized)
      .map((account) => account.orgName);
    return orgs.length > 0 ? [...new Set(orgs)] : undefined;
  }

  private startSingleRegionSyncAfterLogin(
    apiEndpoint: string,
    email: string,
    password: string,
    topologyAlreadyAvailable: boolean,
  ): void {
    if (topologyAlreadyAvailable) return;
    if (process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC === '1') return;
    if (!getCacheSettings().enabled) return;
    const regionKey = resolveRegionKeyForEndpoint(apiEndpoint);
    if (regionKey === undefined) return;

    void syncSingleRegion(regionKey, email, password).catch((err: unknown) => {
      logWarn(`[Bootstrap] Single-region sync failed: ${extractErrorMessage(err)}`);
    });
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
    if (!config) {
      // No config (e.g. reset while the webview retained old state) — a silent return
      // would leave the webview on its loading screen forever.
      this.postMessage({
        type: 'SPACES_ERROR',
        payload: { org, message: 'Extension configuration is missing. Please log in again.' },
      });
      return;
    }

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
    if (!config) {
      this.postMessage({
        type: 'APPS_ERROR',
        payload: { message: 'Extension configuration is missing. Please log in again.' },
      });
      return;
    }

    const mapping = config.orgGroupMappings.find((m) => mappingMatchesTarget(m, org, space));
    if (!mapping) {
      const msg = `No local folder mapped for org/space: ${org}/${space}`;
      logWarn(msg);
      this.postMessage({ type: 'APPS_ERROR', payload: { message: msg } });
      return;
    }

    const cacheSettings = getCacheSettings();
    if (forceRefresh) {
      const credentialsRevoked = await this.refreshCfSyncSpaceCache(config.apiEndpoint, org, space);
      if (credentialsRevoked) return;
      const served = await this.tryServeTopologyApps(config.apiEndpoint, org, space);
      if (served) {
        void this.pushCfTopology();
        return;
      }
    }

    const topologyServed = !forceRefresh
      && await this.tryServeTopologyApps(config.apiEndpoint, org, space);
    if (topologyServed) return;

    if (!forceRefresh && cacheSettings.enabled) {
      const cached = getCachedApps(config.apiEndpoint, org, space);
      if (cached) {
        const ageMs = Date.now() - cached.cachedAt;
        const ttlMs = cacheSettings.intervalHours * 60 * 60 * 1000;
        if (ageMs < ttlMs) {
          logInfo(`Apps served from cache for target: ${org}/${space} (${Math.floor(ageMs / 60_000).toString()}m old).`);
          this.postMessage({ type: 'APPS_LOADED', payload: { apps: cached.apps } });
          await this.writeScopeAfterAppsLoaded(org, space);
          // Refresh the CF token in the background. Avoids an expired-token
          // pause the first time Start Debug runs after restoring from cache.
          // Per-app remote folder discovery is deferred to Start Debug click.
          void this.keepCfSessionAliveTracked(config.apiEndpoint, org, space);
          return;
        }
      }
    }

    logInfo(`Loading apps for target: ${org}/${space} …`);
    try {
      const apps = await this.loadLiveApps(config.apiEndpoint, org, space);
      await saveCachedApps(config.apiEndpoint, org, apps, space);
      const started = apps.filter((a) => a.state === 'started').length;
      logInfo(`Apps loaded: ${apps.length.toString()} total, ${started.toString()} started.`);
      this.postMessage({ type: 'APPS_LOADED', payload: { apps } });
      await this.writeScopeAfterAppsLoaded(org, space);
      void this.keepCfSessionAliveTracked(config.apiEndpoint, org, space);
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`Failed to load apps for ${org}/${space}: ${msg}`);
      const revoked = await this.handleAuthFailure(err);
      if (!revoked) {
        this.postMessage({ type: 'APPS_ERROR', payload: { message: msg } });
      }
    }
  }

  private async handleScaleAppInstances(
    appName: string,
    org: string,
    space: string,
    targetInstances: number,
  ): Promise<void> {
    const config = getConfig();
    if (!config) return;

    const fail = (message: string): void => {
      this.postMessage({ type: 'APP_SCALE_ERROR', payload: { appName, message } });
    };
    const mapping = config.orgGroupMappings.find((m) => mappingMatchesTarget(m, org, space));
    if (!mapping) {
      fail(`No local folder mapped for org/space: ${org}/${space}`);
      return;
    }
    if (getActiveAppNames().includes(appName)) {
      fail('Stop debugging this app before scaling instances.');
      return;
    }
    if (!Number.isInteger(targetInstances) || targetInstances < MIN_BADGE_SCALE_INSTANCES) {
      fail('Instance target must be an integer of at least 1.');
      return;
    }

    try {
      await this.awaitWarmupIfRunning(config.apiEndpoint, org, space);
      const currentApps = await this.loadLiveApps(config.apiEndpoint, org, space);
      const app = currentApps.find((candidate) => candidate.name === appName);
      const validationError = validateBadgeScaleRequest(app, targetInstances);
      if (validationError) {
        fail(validationError);
        return;
      }

      logInfo(`[Scale] Scaling ${appName} in ${org}/${space} to ${targetInstances.toString()} instance(s).`);
      await this.scaleAppInstancesWithAuthRetry(config.apiEndpoint, org, space, appName, targetInstances);
      const apps = await this.loadLiveApps(config.apiEndpoint, org, space);
      await saveCachedApps(config.apiEndpoint, org, apps, space);
      this.postMessage({ type: 'APPS_LOADED', payload: { apps } });
      void this.keepCfSessionAliveTracked(config.apiEndpoint, org, space);
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`[Scale] Failed to scale ${appName} in ${org}/${space}: ${msg}`);
      const revoked = await this.handleAuthFailure(err);
      if (!revoked) fail(`Failed to scale ${appName}: ${msg}`);
    }
  }

  private async scaleAppInstancesWithAuthRetry(
    apiEndpoint: string,
    org: string,
    space: string,
    appName: string,
    targetInstances: number,
  ): Promise<void> {
    try {
      await cfScaleAppInstances(appName, targetInstances);
    } catch (err: unknown) {
      if (!isCfAuthError(err)) throw err;
      logInfo(`cfScaleAppInstances auth failed — attempting re-login before scaling ${appName}.`);
      await this.reLogin(apiEndpoint);
      await cfTarget(org, space);
      await cfScaleAppInstances(appName, targetInstances);
    }
  }

  private async writeScopeAfterAppsLoaded(org: string, space: string): Promise<void> {
    const config = getConfig();
    if (!config) return;
    const regionCode = regionCodeFromApiEndpoint(config.apiEndpoint);
    if (!regionCode) return;

    const scope: SharedCfScope = { regionCode, orgName: org, spaceName: space };
    const previousScope = this.lastWrittenScope;
    this.lastWrittenScope = scope;
    try {
      await writeScopeIfChanged(scope);
    } catch (err: unknown) {
      this.lastWrittenScope = previousScope;
      logWarn(`[ScopeSync] Failed to write shared CF scope: ${extractErrorMessage(err)}`);
    }
  }

  private async refreshCfSyncSpaceCache(apiEndpoint: string, org: string, space: string): Promise<boolean> {
    const { email, password } = await getCredentials();
    const result = await refreshCfSyncSpace({ apiEndpoint, orgName: org, spaceName: space, email, password });

    if (result.status === 'refreshed') {
      logInfo(`[Reload] cf-sync refreshed ${result.regionKey}/${org}/${space} (${result.appCount.toString()} app(s)).`);
      await saveLastSpaceRefreshAt(apiEndpoint, org, space);
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

  private async tryServeTopologyApps(
    apiEndpoint: string,
    org: string,
    space: string,
  ): Promise<boolean> {
    const apps = getAppsFromTopologySync(apiEndpoint, org, space);
    // Empty array = cf-sync knows the space but has not synced its apps yet. Serving
    // it would put the launcher on a READY screen with zero rows and skip the live
    // fetch entirely; fall through to cache/live loading instead.
    if (apps === undefined || apps.length === 0) return false;

    logInfo(`[Topology] Skipped live cf apps for ${org}/${space} — using topology cache.`);
    await saveCachedApps(apiEndpoint, org, apps, space);
    this.postMessage({ type: 'APPS_LOADED', payload: { apps } });
    await this.writeScopeAfterAppsLoaded(org, space);
    void this.keepCfSessionAliveTracked(apiEndpoint, org, space);
    this.refreshStaleTopologySpaceInBackground(apiEndpoint, org, space);
    return true;
  }

  private refreshStaleTopologySpaceInBackground(apiEndpoint: string, org: string, space: string): void {
    const settings = getCacheSettings();
    if (!settings.enabled) return;

    const lastRefresh = getLastSpaceRefreshAt(apiEndpoint, org, space) ?? 0;
    const ttlMs = settings.intervalHours * 60 * 60 * 1000;
    if (Date.now() - lastRefresh <= ttlMs) return;

    void this.refreshSingleSpaceInBackground(apiEndpoint, org, space);
  }

  private async refreshSingleSpaceInBackground(apiEndpoint: string, org: string, space: string): Promise<void> {
    const credentialsRevoked = await this.refreshCfSyncSpaceCache(apiEndpoint, org, space);
    if (credentialsRevoked) return;
    void this.pushCfTopology();
  }

  private async loadLiveSpaces(apiEndpoint: string, org: string): Promise<string[]> {
    try {
      return await cfTargetOrgAndSpaces(org);
    } catch (err: unknown) {
      if (!isCfAuthError(err)) throw err;
      logInfo(`cfTargetOrgAndSpaces auth failed — attempting re-login before loading spaces for ${org}.`);
      await this.reLogin(apiEndpoint);
      return await cfTargetOrgAndSpaces(org);
    }
  }

  private async loadLiveApps(apiEndpoint: string, org: string, space: string): Promise<CfApp[]> {
    try {
      return await cfTargetAndApps(org, space);
    } catch (err: unknown) {
      if (!isCfAuthError(err)) throw err;
      logInfo(`cfTargetAndApps auth failed — attempting re-login before loading apps for ${org}/${space}.`);
      await this.reLogin(apiEndpoint);
      return await cfTargetAndApps(org, space);
    }
  }

  private async resolveLocalFolderPath(
    groupPath: string,
    appName: string,
    overrides: readonly AppFolderMapping[],
  ): Promise<string | null> {
    for (const candidate of getFolderNameCandidates(appName, overrides)) {
      const folderPath = await findRepoFolder(groupPath, candidate);
      if (folderPath !== null) return folderPath;
    }
    return null;
  }

  // Lightweight CF session keepalive. Refreshes the cf token only — no per-app
  // SSH discovery happens here. Discovery of remoteRoot is deferred until the
  // user clicks Start Debug, where it runs in parallel for the selected apps.
  private keepCfSessionAlive(apiEndpoint: string, org: string, space: string): Promise<void> {
    return this.ensureCfSession(apiEndpoint, org, space);
  }

  private async getConfiguredRemoteRoot(
    target: DebugTarget,
    fallbackConfig: CapDebugConfig | null,
  ): Promise<string | undefined> {
    const appConfig = target.noLocalFolder === true ? null : await readCapDebugConfig(target.folderPath);
    return appConfig?.remoteRoot ?? fallbackConfig?.remoteRoot;
  }

  private async resolveRemoteRootsForTargets(
    targets: readonly DebugTarget[],
    apiEndpoint: string,
    org: string,
    space: string,
    fallbackConfig: CapDebugConfig | null,
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    // Probe all targets concurrently. The lookup coordinator dedupes by cacheKey
    // so duplicate keys still resolve once. allSettled keeps one app's failure
    // from cancelling the rest — per-target errors are already logged inside
    // resolveRemoteRootForTarget.
    await Promise.allSettled(
      targets.map(async (target) => {
        const configuredRemoteRoot = await this.getConfiguredRemoteRoot(target, fallbackConfig);
        await this.resolveRemoteRootForTarget(target, apiEndpoint, org, space, configuredRemoteRoot, resolved);
      }),
    );
    return resolved;
  }

  private async resolveRemoteRootForTarget(
    target: DebugTarget,
    apiEndpoint: string,
    org: string,
    space: string,
    configuredRemoteRoot: string | undefined,
    resolved: Map<string, string>,
  ): Promise<void> {
    if (configuredRemoteRoot === undefined) return;
    const setting = parseRemoteRootSetting(configuredRemoteRoot);
    if (setting.kind === 'invalid-regex') {
      logWarn(`[RemoteRoot] ${target.appName}: invalid regex (${setting.error})`);
      return;
    }
    if (setting.kind !== 'regex') return;

    const cacheKey = this.remoteRootCacheKey(apiEndpoint, org, space, target.appName, configuredRemoteRoot);
    const cached = this.resolvedRemoteRoots.get(cacheKey);
    if (cached !== undefined) {
      resolved.set(target.appName, cached);
      return;
    }

    try {
      const result = await this.remoteRootLookupCoordinator.resolve(cacheKey, target.appName, configuredRemoteRoot);
      this.storeResolvedRemoteRoot(apiEndpoint, org, space, target.appName, configuredRemoteRoot, result);
      if (result.status === 'resolved') {
        resolved.set(target.appName, result.remoteRoot);
      } else if (result.status === 'unmatched' || result.status === 'invalid-regex') {
        this.notifyUnmatchedRemoteRoot(target.appName, cacheKey, result, target.folderPath);
      }
    } catch (err: unknown) {
      logWarn(`[RemoteRoot] ${target.appName}: on-demand lookup failed (${extractErrorMessage(err)})`);
    }
  }

  private notifyUnmatchedRemoteRoot(
    appName: string,
    cacheKey: string,
    result: RemoteRootResolution,
    folderPath: string,
  ): void {
    if (this.notifiedUnmatchedRemoteRoots.has(cacheKey)) return;
    this.notifiedUnmatchedRemoteRoots.add(cacheKey);

    const detail = describeRemoteRootResolution(result);
    const message = `CDS Debug: remoteRoot for "${appName}" — ${detail}. Breakpoints may not bind until cap-debug-config.json is corrected.`;
    void vscode.window.showWarningMessage(message, 'Open cap-debug-config.json', 'Open Output Channel', 'Continue Anyway')
      .then((choice) => {
        if (choice === 'Open cap-debug-config.json') {
          return this.openCapDebugConfig(folderPath);
        }
        if (choice === 'Open Output Channel') {
          showLogChannel();
        }
        return undefined;
      });
  }

  private async openCapDebugConfig(folderPath: string): Promise<void> {
    const configUri = vscode.Uri.joinPath(vscode.Uri.file(folderPath), 'cap-debug-config.json');
    try {
      const doc = await vscode.workspace.openTextDocument(configUri);
      await vscode.window.showTextDocument(doc);
    } catch {
      // No per-service file — fall back to the user-level setting that controls the same field.
      await vscode.commands.executeCommand('workbench.action.openSettings', 'cdsDebug.sharedCapDebugConfig');
    }
  }

  private storeResolvedRemoteRoot(
    apiEndpoint: string,
    org: string,
    space: string,
    appName: string,
    configuredRemoteRoot: string,
    result: RemoteRootResolution,
  ): void {
    if (result.status === 'resolved') {
      const cacheKey = this.remoteRootCacheKey(apiEndpoint, org, space, appName, configuredRemoteRoot);
      this.resolvedRemoteRoots.set(cacheKey, result.remoteRoot);
      this.resolvedRemoteRootByApp.set(appName, result.remoteRoot);
      logInfo(`[RemoteRoot] ${appName} resolved to ${result.remoteRoot}`);
      return;
    }
    if (result.status !== 'literal' && result.status !== 'none') {
      logWarn(`[RemoteRoot] ${appName}: ${describeRemoteRootResolution(result)}`);
    }
  }

  private remoteRootCacheKey(
    apiEndpoint: string,
    org: string,
    space: string,
    appName: string,
    configuredRemoteRoot: string,
  ): string {
    return JSON.stringify([apiEndpoint, org, space, appName, configuredRemoteRoot]);
  }

  private warmupKey(apiEndpoint: string, org: string, space: string): string {
    return JSON.stringify([apiEndpoint, org, space]);
  }

  // Tracked variant so concurrent triggers share a single in-flight keepalive,
  // and Start Debug can await any in-flight session refresh via awaitWarmupIfRunning.
  private keepCfSessionAliveTracked(
    apiEndpoint: string,
    org: string,
    space: string,
  ): Promise<void> {
    const key = this.warmupKey(apiEndpoint, org, space);
    const existing = this.warmupPromises.get(key);
    if (existing) return existing;

    const warmup = this.keepCfSessionAlive(apiEndpoint, org, space)
      .finally(() => {
        this.warmupPromises.delete(key);
      });
    this.warmupPromises.set(key, warmup);
    return warmup;
  }

  private async handleWarmupCfSession(org: string, space: string): Promise<void> {
    const config = getConfig();
    if (!config) return;

    const mapping = config.orgGroupMappings.find((m) => mappingMatchesTarget(m, org, space));
    if (!mapping) return;

    const hasTopology = getAppsFromTopologySync(config.apiEndpoint, org, space) !== undefined;
    if (!hasTopology) return;

    await this.writeScopeAfterAppsLoaded(org, space);
    await this.keepCfSessionAliveTracked(config.apiEndpoint, org, space);
    this.refreshStaleTopologySpaceInBackground(config.apiEndpoint, org, space);
  }

  private async awaitWarmupIfRunning(apiEndpoint: string, org: string, space: string): Promise<void> {
    const warmup = this.warmupPromises.get(this.warmupKey(apiEndpoint, org, space));
    if (warmup) await warmup;
  }

  private async handleStartDebug(appNames: string[], org: string, space: string): Promise<void> {
    const config = getConfig();
    if (!config) {
      // The webview optimistically added PENDING session cards on click — a silent
      // return would leave them spinning forever.
      this.postMessage({
        type: 'DEBUG_ERROR',
        payload: { message: 'Extension configuration is missing. Please log in again.' },
      });
      return;
    }

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
    await this.awaitWarmupIfRunning(config.apiEndpoint, org, space);
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

    const appFolderMappings = getAppFolderMappings();
    logInfo(`[StartDebug] Resolving local folders under: ${groupPath}`);
    const resolvedPaths: string[] = [];
    for (const appName of appNames) {
      const folderPath = await this.resolveLocalFolderPath(groupPath, appName, appFolderMappings);

      if (folderPath !== null) {
        resolvedPaths.push(folderPath);
        const viaOverride = resolveOverrideFolder(appName, appFolderMappings) !== undefined;
        logInfo(`Mapped${viaOverride ? ' (via appFolderMappings setting)' : ''}: ${appName} → ${folderPath}`);
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

    const { targets, unmapped } = buildDebugTargets(
      appNames, resolvedPaths, existingPorts, usedPorts, undefined, appFolderMappings,
    );

    const sharedCapConfig = await resolveSharedCapDebugConfig(workspaceRoot);

    if (targets.length === 0) {
      // All apps unmapped — build fallback targets using workspaceRoot so debug can still proceed.
      // Source maps won't resolve, but the SSH tunnel and debug console will work.
      logWarn(`No local folder found for any selected app. Starting debug in console-only mode (no source maps).`);
      const fallbackTargets = buildFallbackTargets(unmapped, workspaceRoot, existingPorts, usedPorts);
      this.postDiscoveringRemoteRoot(fallbackTargets);
      const resolvedRemoteRoots = await this.resolveRemoteRootsForTargets(
        fallbackTargets,
        config.apiEndpoint,
        org,
        space,
        sharedCapConfig,
      );
      await this.launchDebugSessions(fallbackTargets, workspaceRoot, [], sharedCapConfig, resolvedRemoteRoots);
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

    this.postDiscoveringRemoteRoot(finalTargets);
    const resolvedRemoteRoots = await this.resolveRemoteRootsForTargets(
      finalTargets,
      config.apiEndpoint,
      org,
      space,
      sharedCapConfig,
    );
    await this.launchDebugSessions(finalTargets, workspaceRoot, unmapped, sharedCapConfig, resolvedRemoteRoots);
  }

  // Notifies the webview that remote-folder resolution is starting for the
  // listed apps. Posted before resolveRemoteRootsForTargets so the user sees
  // a "Discovering remote folder…" hint while the cf ssh probe runs (5–10 s
  // for cold regex lookups). For literal/cached remoteRoots the resolve is
  // near-instant and the label only flashes briefly.
  private postDiscoveringRemoteRoot(targets: readonly DebugTarget[]): void {
    if (targets.length === 0) return;
    this.postMessage({
      type: 'DEBUG_DISCOVERING_REMOTE_ROOT',
      payload: { appNames: targets.map((target) => target.appName) },
    });
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
            logInfo(`[${info.appName}] Checking out branch ${describeGitBranchForLog(info.targetBranch)} in ${repoRoot}`);
            postStatus(info.appName, 'checking-out');
            await checkoutBranch(repoRoot, info.targetBranch);
            changedWorkingTree = true;
          }

          logInfo(
            `[${info.appName}] Pulling latest changes for branch ${describeGitBranchForLog(info.targetBranch)} in ${repoRoot}`,
          );
          postStatus(info.appName, 'pulling');
          const pullResult = await pullLatest(repoRoot);
          if (pullResult.changed) {
            changedWorkingTree = true;
          }

          if (!changedWorkingTree) {
            // Already on the correct branch, no local changes stashed, and no remote updates
            logInfo(
              `[${info.appName}] Branch ${describeGitBranchForLog(info.targetBranch)} is up to date, skipping install/build.`,
            );
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
    resolvedRemoteRoots: ReadonlyMap<string, string>,
  ): Promise<void> {
    logInfo(`[StartDebug] Merging launch.json for ${targets.length.toString()} target(s)…`);
    await mergeLaunchJson(workspaceRoot, targets, fallbackConfig, { resolvedRemoteRoots });
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
      this.triggerCacheSync('[CacheSync] Triggered immediate sync after credentials saved.');
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`[Credentials] Failed to save credentials: ${msg}`);
      this.postMessage({ type: 'CREDENTIALS_ERROR', payload: { message: `Could not save credentials: ${msg}` } });
    }
  }

  private bootstrapCacheSyncForExistingCredentials(status: CredentialStatus): void {
    if (!status.hasCredentials) return;
    if (getCurrentSyncProgress().lastCompletedAt !== undefined) return;
    this.triggerCacheSync('[CacheSync] Triggered initial sync for existing credentials.');
  }

  private triggerCacheSync(message: string): void {
    if (process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC === '1') return;
    runCacheSync();
    logInfo(message);
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
    if (!isCfAuthError(err)) return false;
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

function validateBadgeScaleRequest(app: CfApp | undefined, targetInstances: number): string | null {
  if (!app) return 'App is no longer available in this space.';
  if (app.state !== 'started') return 'Only started apps can be scaled from this badge.';
  if (typeof app.runningInstances !== 'number' || typeof app.totalInstances !== 'number') {
    return 'Current instance counts are unavailable. Refresh apps and try again.';
  }
  if (app.instanceProcessCount !== undefined && app.instanceProcessCount > 1) {
    return 'Scaling multiple CF processes is not supported from this badge yet.';
  }
  if (app.runningInstances !== app.totalInstances) {
    return 'Wait until current instances are running before scaling.';
  }

  const delta = targetInstances - app.totalInstances;
  if (delta !== 1 && delta !== -1) return 'Scale one instance at a time from this badge.';
  return null;
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
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

function describeRemoteRootResolution(result: RemoteRootResolution): string {
  switch (result.status) {
    case 'invalid-regex':
      return `invalid regex (${result.error})`;
    case 'unmatched':
      return `no remote folder matched ${result.pattern}`;
    case 'none':
      return 'remoteRoot is not configured';
    case 'literal':
      return `literal remoteRoot ${result.remoteRoot}`;
    case 'resolved':
      return `resolved remoteRoot ${result.remoteRoot}`;
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
