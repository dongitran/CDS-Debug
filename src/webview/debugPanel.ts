import type * as vscode from 'vscode';
import type {
  AppFolderMapping,
  AppWatchdogConfig,
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
  SharedCfScope,
  SaveSshProxySettingsPayload,
  SshProxyStatus,
  SyncProgress,
} from '../types/index';
import { CF_DEFAULT_SPACE, DEFAULT_CACHE_SETTINGS } from '../types/index';
import {
  RemoteRootLookupCoordinator,
  type RemoteRootResolution,
} from '../core/remoteRootResolver';
import { getConfig } from '../storage/configStore';
import {
  getCacheSettings,
  getDebugPreferences,
  getDebugSessionPackagePreferences,
  saveCacheSettings,
  saveDebugPreferences,
  saveDebugSessionPackagePreferences,
} from '../storage/cacheStore';
import {
  cacheSyncEvents,
  getCurrentSyncProgress,
  requestCacheSyncStop,
  restartCacheSyncTimer,
  runCacheSync,
} from '../core/cacheSync';
import { getTopologySnapshotSync } from '../core/cfTopology';
import { logError, logInfo } from '../core/logger';
import { getWebviewContent } from './getWebviewContent';
import {
  stopProcess,
  stopAllProcesses,
  debugProcessEvents,
  getActiveSessions,
  setBeforeReconnectHook,
} from '../core/processManager';
import { breakpointSnapshotEvents, clearBreakpointSnapshots, getBreakpointSnapshots } from '../core/breakpointSnapshotManager';
import {
  type PackageSearchIndex,
} from '../core/packageSourceBrowser';
import {
  applyE2eBridgeCommand,
  isE2eModeEnabled,
} from '../testing/e2eBridge';
import {
  refreshSshProxyStatus,
  sshProxyEvents,
} from '../core/sshProxyTunnel';
import { AuthHandler } from "./handlers/AuthHandler";
import { ScopeSyncHandler } from "./handlers/ScopeSyncHandler";
import { CfOperationsHandler } from "./handlers/CfOperationsHandler";
import { PackageBrowserHandler } from "./handlers/PackageBrowserHandler";
import { DebugSessionHandler } from "./handlers/DebugSessionHandler";
import { BranchPrepHandler } from "./handlers/BranchPrepHandler";
import { SettingsHandler } from "./handlers/SettingsHandler";
import type { CfTargetScope, ServiceBranchInfo } from "./webviewUtils";
import { isBreakpointSnapshot, isWebviewMessage } from "./webviewUtils";

export class DebugLauncherViewProvider implements vscode.WebviewViewProvider {
    public readonly authHandler = new AuthHandler(this);
    public readonly scopeSyncHandler = new ScopeSyncHandler(this);
    public readonly cfOperationsHandler = new CfOperationsHandler(this);
    public readonly packageBrowserHandler = new PackageBrowserHandler(this);
    public readonly debugSessionHandler = new DebugSessionHandler(this);
    public readonly branchPrepHandler = new BranchPrepHandler(this);
    public readonly settingsHandler = new SettingsHandler(this);
  public static readonly viewId = 'cdsDebug.mainView';

  public view?: vscode.WebviewView;
  public readonly packageEntriesByApp = new Map<string, LoadedPackageEntry[]>();
  public readonly packageSearchIndexByApp = new Map<string, PackageSearchIndex>();
  public readonly resolvedRemoteRoots = new Map<string, string>();
  // Parallel map keyed by appName so reconnect re-merges can pick up the cached
  // remoteRoot without needing to recompute the (apiEndpoint, org, space) cache key.
  public readonly resolvedRemoteRootByApp = new Map<string, string>();
  public readonly remoteRootLookupCoordinator = new RemoteRootLookupCoordinator();
  // Tracks (apiEndpoint, org, space, appName, configuredRemoteRoot) keys that have already
  // surfaced a "remoteRoot did not resolve" notification, so we do not nag the user during
  // each Start Debug click. Cleared on Reset Configuration / window reload by definition.
  public readonly notifiedUnmatchedRemoteRoots = new Set<string>();
  public readonly warmupPromises = new Map<string, Promise<void>>();
  public scopeChangeQueue: Promise<void> = Promise.resolve();
  public lastWrittenScope: SharedCfScope | undefined;
  public pendingExternalScope: SharedCfScope | undefined;

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
    sshProxyEvents.on('statusChanged', (proxyStatus: SshProxyStatus) => {
      this.postMessage({ type: 'SSH_PROXY_STATUS', payload: proxyStatus });
    });
    setBeforeReconnectHook((appName, params) => this.handleBeforeReconnect(appName, params));
  }

  public resolveWebviewView(
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

  public async handleMessage(raw: unknown): Promise<void> {
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
        this.postMessage({ type: 'SSH_PROXY_STATUS', payload: await refreshSshProxyStatus() });
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

      case 'GET_SSH_PROXY_STATUS':
        this.postMessage({ type: 'SSH_PROXY_STATUS', payload: await refreshSshProxyStatus() });
        break;

      case 'SAVE_SSH_PROXY_SETTINGS':
        await this.handleSaveSshProxySettings(raw.payload);
        break;

      case 'CLEAR_SSH_PROXY_SETTINGS':
        await this.handleClearSshProxySettings();
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

      case 'GET_APP_WATCHDOG_CONFIG':
        this.postAppWatchdogConfig();
        break;

      case 'SAVE_APP_WATCHDOG_CONFIG':
        await this.handleSaveAppWatchdogConfig(raw.payload);
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

  public handleE2eBridge(command: E2eBridgeCommand): void {
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

  // Lightweight CF session keepalive. Refreshes the cf token only — no per-app
  // SSH discovery happens here. Discovery of remoteRoot is deferred until the
  // user clicks Start Debug, where it runs in parallel for the selected apps.
  // Tracked variant so concurrent triggers share a single in-flight keepalive,
  // and Start Debug can await any in-flight session refresh via awaitWarmupIfRunning.
  // Notifies the webview that remote-folder resolution is starting for the
  // listed apps. Posted before resolveRemoteRootsForTargets so the user sees
  // a "Discovering remote folder…" hint while the cf ssh probe runs (5–10 s
  // for cold regex lookups). For literal/cached remoteRoots the resolve is
  // near-instant and the label only flashes briefly.
      public async handleLogin(apiEndpoint: string, topologyOrgName?: string): Promise<void> {
        return this.authHandler.handleLogin(apiEndpoint, topologyOrgName);
      }
      public loadTopologyShortcutLoginOrgs(apiEndpoint: string, orgName: string): { orgs: string[]; topologyAlreadyAvailable: boolean } | undefined {
        return this.authHandler.loadTopologyShortcutLoginOrgs(apiEndpoint, orgName);
      }
      public async loadLoginOrgs(apiEndpoint: string, email: string, password: string): Promise<{ orgs: string[]; topologyAlreadyAvailable: boolean }> {
        return this.authHandler.loadLoginOrgs(apiEndpoint, email, password);
      }
      public getTopologyOrgsForEndpoint(apiEndpoint: string): string[] | undefined {
        return this.authHandler.getTopologyOrgsForEndpoint(apiEndpoint);
      }
      public startSingleRegionSyncAfterLogin(apiEndpoint: string, email: string, password: string, topologyAlreadyAvailable: boolean): void {
        this.authHandler.startSingleRegionSyncAfterLogin(apiEndpoint, email, password, topologyAlreadyAvailable);
      }
      public async handleSaveCredentials(email: string, password: string): Promise<void> {
        return this.authHandler.handleSaveCredentials(email, password);
      }
      public async handleClearCredentials(): Promise<void> {
        return this.authHandler.handleClearCredentials();
      }
      public async buildCredentialStatus(): Promise<CredentialStatus> {
        return this.authHandler.buildCredentialStatus();
      }
      public async handleAuthFailure(err: unknown): Promise<boolean> {
        return this.authHandler.handleAuthFailure(err);
      }
      public async reLogin(apiEndpoint: string): Promise<void> {
        return this.authHandler.reLogin(apiEndpoint);
      }
      public bootstrapCacheSyncForExistingCredentials(status: CredentialStatus): void {
        this.authHandler.bootstrapCacheSyncForExistingCredentials(status);
      }
      public triggerCacheSync(message: string): void {
        this.authHandler.triggerCacheSync(message);
      }
      public handleExternalScopeChange(scope: SharedCfScope): void {
        this.scopeSyncHandler.handleExternalScopeChange(scope);
      }
      public isLastWrittenScope(scope: SharedCfScope): boolean {
        return this.scopeSyncHandler.isLastWrittenScope(scope);
      }
      public async handleScopeChangeInternal(scope: SharedCfScope): Promise<void> {
        return this.scopeSyncHandler.handleScopeChangeInternal(scope);
      }
      public async stopActiveSessionsForScopeChange(): Promise<void> {
        return this.scopeSyncHandler.stopActiveSessionsForScopeChange();
      }
      public async handleExternalRegionChange(scope: SharedCfScope): Promise<void> {
        return this.scopeSyncHandler.handleExternalRegionChange(scope);
      }
      public applyPendingExternalScopeIfAny(orgs: string[]): void {
        this.scopeSyncHandler.applyPendingExternalScopeIfAny(orgs);
      }
      public postScopeSyncForMapping(scope: SharedCfScope): void {
        this.scopeSyncHandler.postScopeSyncForMapping(scope);
      }
      public async pushCfTopology(): Promise<void> {
        return this.scopeSyncHandler.pushCfTopology();
      }
      public async writeScopeAfterAppsLoaded(org: string, space: string): Promise<void> {
        return this.scopeSyncHandler.writeScopeAfterAppsLoaded(org, space);
      }
      public async handleLoadSpaces(org: string): Promise<void> {
        return this.cfOperationsHandler.handleLoadSpaces(org);
      }
      public async handleLoadApps(org: string, space: string, forceRefresh = false): Promise<void> {
        return this.cfOperationsHandler.handleLoadApps(org, space, forceRefresh);
      }
      public async handleWarmupCfSession(org: string, space: string): Promise<void> {
        return this.cfOperationsHandler.handleWarmupCfSession(org, space);
      }
      public keepCfSessionAlive(apiEndpoint: string, org: string, space: string): Promise<void> {
        return this.cfOperationsHandler.keepCfSessionAlive(apiEndpoint, org, space);
      }
      public keepCfSessionAliveTracked(apiEndpoint: string, org: string, space: string): Promise<void> {
        return this.cfOperationsHandler.keepCfSessionAliveTracked(apiEndpoint, org, space);
      }
      public async awaitWarmupIfRunning(apiEndpoint: string, org: string, space: string): Promise<void> {
        return this.cfOperationsHandler.awaitWarmupIfRunning(apiEndpoint, org, space);
      }
      public warmupKey(apiEndpoint: string, org: string, space: string): string {
        return this.cfOperationsHandler.warmupKey(apiEndpoint, org, space);
      }
      public async refreshCfSyncSpaceCache(apiEndpoint: string, org: string, space: string): Promise<boolean> {
        return this.cfOperationsHandler.refreshCfSyncSpaceCache(apiEndpoint, org, space);
      }
      public async tryServeTopologyApps(apiEndpoint: string, org: string, space: string): Promise<boolean> {
        return this.cfOperationsHandler.tryServeTopologyApps(apiEndpoint, org, space);
      }
      public refreshStaleTopologySpaceInBackground(apiEndpoint: string, org: string, space: string): void {
        this.cfOperationsHandler.refreshStaleTopologySpaceInBackground(apiEndpoint, org, space);
      }
      public async refreshSingleSpaceInBackground(apiEndpoint: string, org: string, space: string): Promise<void> {
        return this.cfOperationsHandler.refreshSingleSpaceInBackground(apiEndpoint, org, space);
      }
      public async loadLiveSpaces(apiEndpoint: string, org: string): Promise<string[]> {
        return this.cfOperationsHandler.loadLiveSpaces(apiEndpoint, org);
      }
      public async loadLiveApps(apiEndpoint: string, org: string, space: string): Promise<CfApp[]> {
        return this.cfOperationsHandler.loadLiveApps(apiEndpoint, org, space);
      }
      public async handleScaleAppInstances(appName: string, org: string, space: string, targetInstances: number): Promise<void> {
        return this.cfOperationsHandler.handleScaleAppInstances(appName, org, space, targetInstances);
      }
      public async scaleAppInstancesWithAuthRetry(apiEndpoint: string, org: string, space: string, appName: string, targetInstances: number): Promise<void> {
        return this.cfOperationsHandler.scaleAppInstancesWithAuthRetry(apiEndpoint, org, space, appName, targetInstances);
      }
      public async ensureCfSession(apiEndpoint: string, org: string, space: string): Promise<void> {
        return this.cfOperationsHandler.ensureCfSession(apiEndpoint, org, space);
      }
      public async handleLoadPackageSources(appName: string): Promise<void> {
        return this.packageBrowserHandler.handleLoadPackageSources(appName);
      }
      public async handleSearchPackageSources(appName: string, query: string, requestId: number, packageNameFilterRegex?: string): Promise<void> {
        return this.packageBrowserHandler.handleSearchPackageSources(appName, query, requestId, packageNameFilterRegex);
      }
      public async handleOpenPackageSource(appName: string, source: LoadedPackageSource, location?: PackageSourceLocation): Promise<void> {
        return this.packageBrowserHandler.handleOpenPackageSource(appName, source, location);
      }
      public async getOrLoadPackageEntriesForApp(appName: string, log: (message: string) => void, forceReload: boolean): Promise<LoadedPackageEntry[]> {
        return this.packageBrowserHandler.getOrLoadPackageEntriesForApp(appName, log, forceReload);
      }
      public createPackageSearchIndexForApp(appName: string, packages: LoadedPackageEntry[]): PackageSearchIndex {
        return this.packageBrowserHandler.createPackageSearchIndexForApp(appName, packages);
      }
      public logPackageDiagnostic(appName: string, message: string): void {
        this.packageBrowserHandler.logPackageDiagnostic(appName, message);
      }
      public buildPackageLogger(appName: string): (message: string) => void {
        return this.packageBrowserHandler.buildPackageLogger(appName);
      }
      public getPackageLocalRoot(appName: string): string | undefined {
        return this.packageBrowserHandler.getPackageLocalRoot(appName);
      }
      public async handleStartDebug(appNames: string[], org: string, space: string): Promise<void> {
        return this.debugSessionHandler.handleStartDebug(appNames, org, space);
      }
      public async handleRetryDebug(appName: string): Promise<void> {
        return this.debugSessionHandler.handleRetryDebug(appName);
      }
      public async handleBeforeReconnect(appName: string, params: { folderPath: string; port: number; launchConfigName: string }): Promise<void> {
        return this.debugSessionHandler.handleBeforeReconnect(appName, params);
      }
      public postDiscoveringRemoteRoot(targets: readonly DebugTarget[]): void {
        this.debugSessionHandler.postDiscoveringRemoteRoot(targets);
      }
      public async resolveLocalFolderPath(groupPath: string, appName: string, overrides: readonly AppFolderMapping[]): Promise<string | null> {
        return this.debugSessionHandler.resolveLocalFolderPath(groupPath, appName, overrides);
      }
      public async getConfiguredRemoteRoot(target: DebugTarget, fallbackConfig: CapDebugConfig | null): Promise<string | undefined> {
        return this.debugSessionHandler.getConfiguredRemoteRoot(target, fallbackConfig);
      }
      public async resolveRemoteRootsForTargets(targets: readonly DebugTarget[], apiEndpoint: string, org: string, space: string, fallbackConfig: CapDebugConfig | null): Promise<Map<string, string>> {
        return this.debugSessionHandler.resolveRemoteRootsForTargets(targets, apiEndpoint, org, space, fallbackConfig);
      }
      public async resolveRemoteRootForTarget(target: DebugTarget, apiEndpoint: string, org: string, space: string, configuredRemoteRoot: string | undefined, resolved: Map<string, string>): Promise<void> {
        return this.debugSessionHandler.resolveRemoteRootForTarget(target, apiEndpoint, org, space, configuredRemoteRoot, resolved);
      }
      public notifyUnmatchedRemoteRoot(appName: string, cacheKey: string, result: RemoteRootResolution, folderPath: string): void {
        this.debugSessionHandler.notifyUnmatchedRemoteRoot(appName, cacheKey, result, folderPath);
      }
      public async openCapDebugConfig(folderPath: string): Promise<void> {
        return this.debugSessionHandler.openCapDebugConfig(folderPath);
      }
      public storeResolvedRemoteRoot(apiEndpoint: string, org: string, space: string, appName: string, configuredRemoteRoot: string, result: RemoteRootResolution): void {
        this.debugSessionHandler.storeResolvedRemoteRoot(apiEndpoint, org, space, appName, configuredRemoteRoot, result);
      }
      public remoteRootCacheKey(apiEndpoint: string, org: string, space: string, appName: string, configuredRemoteRoot: string): string {
        return this.debugSessionHandler.remoteRootCacheKey(apiEndpoint, org, space, appName, configuredRemoteRoot);
      }
      public async launchDebugSessions(targets: DebugTarget[], workspaceRoot: string, unmapped: string[], fallbackConfig: CapDebugConfig | null, resolvedRemoteRoots: ReadonlyMap<string, string>, scope: CfTargetScope): Promise<void> {
        return this.debugSessionHandler.launchDebugSessions(targets, workspaceRoot, unmapped, fallbackConfig, resolvedRemoteRoots, scope);
      }
      public async registerWatchdogForTargets(targets: DebugTarget[], scope: CfTargetScope): Promise<void> {
        return this.debugSessionHandler.registerWatchdogForTargets(targets, scope);
      }
      public async resolveAppRouteUrl(scope: CfTargetScope, appName: string): Promise<string | undefined> {
        return this.debugSessionHandler.resolveAppRouteUrl(scope, appName);
      }
      public async resolveTargetBranches(targets: DebugTarget[], org: string, fallbackConfig: CapDebugConfig | null): Promise<ServiceBranchInfo[]> {
        return this.branchPrepHandler.resolveTargetBranches(targets, org, fallbackConfig);
      }
      public async runBranchPreparation(targets: DebugTarget[], branchInfos: ServiceBranchInfo[]): Promise<DebugTarget[]> {
        return this.branchPrepHandler.runBranchPreparation(targets, branchInfos);
      }
      public async handleSelectGroupFolder(): Promise<void> {
        return this.settingsHandler.handleSelectGroupFolder();
      }
      public async handleSaveMappings(mappings: OrgGroupMapping[]): Promise<void> {
        return this.settingsHandler.handleSaveMappings(mappings);
      }
      public async handleSaveAppWatchdogConfig(payload: AppWatchdogConfig): Promise<void> {
        return this.settingsHandler.handleSaveAppWatchdogConfig(payload);
      }
      public postAppWatchdogConfig(): void {
        this.settingsHandler.postAppWatchdogConfig();
      }
      public handleOpenAppUrl(rawUrl: string, source: 'manual' | 'auto'): void {
        this.settingsHandler.handleOpenAppUrl(rawUrl, source);
      }
      public async handleSaveSshProxySettings(payload: SaveSshProxySettingsPayload): Promise<void> {
        return this.settingsHandler.handleSaveSshProxySettings(payload);
      }
      public async handleClearSshProxySettings(): Promise<void> {
        return this.settingsHandler.handleClearSshProxySettings();
      }
      public postActiveSessionProxyError(): boolean {
        return this.settingsHandler.postActiveSessionProxyError();
      }
      public async postSshProxyError(message: string): Promise<void> {
        return this.settingsHandler.postSshProxyError(message);
      }
}
