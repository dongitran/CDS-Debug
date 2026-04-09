import * as vscode from 'vscode';
import { join } from 'node:path';
import type { BranchPrepService, BranchPrepStep, CacheSettings, CapDebugConfig, CredentialStatus, DebugTarget, ExtensionMessage, OrgGroupMapping, SyncProgress, WebviewMessage } from '../types/index';
import { DEBUG_BASE_PORT, DEFAULT_CACHE_SETTINGS } from '../types/index';
import { CfCliError, cfLogin, cfLogout, cfOrgs, cfTarget, cfTargetAndApps } from '../core/cfClient';
import { findRepoFolder } from '../core/folderScanner';
import { buildDebugTargets, getFolderNameCandidates } from '../core/appMapper';
import { getExistingLaunchConfigs, mergeLaunchJson, readCapDebugConfig } from '../core/launchConfigurator';
import { getConfig, saveConfig } from '../storage/configStore';
import {
  clearCredentialsFromSecretStorage,
  getCredentialSource,
  getCredentials,
  maskEmail,
  saveCredentialsToSecretStorage,
} from '../core/shellEnv';
import { getCachedApps, getCacheSettings, getDebugPreferences, saveCacheSettings, saveDebugPreferences } from '../storage/cacheStore';
import { cacheSyncEvents, runCacheSync, getCurrentSyncProgress, restartCacheSyncTimer } from '../core/cacheSync';
import { logError, logInfo, logWarn } from '../core/logger';
import { getWebviewContent } from './getWebviewContent';
import { startTunnelAndAttach, stopProcess, stopAllProcesses, debugProcessEvents, getActiveSessions } from '../core/processManager';
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
        const credentialStatus = await this.buildCredentialStatus();
        this.post({
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
        this.post({ type: 'DEBUG_PREFS', payload: getDebugPreferences() });
        break;
      }

      case 'SAVE_CREDENTIALS':
        await this.handleSaveCredentials(raw.payload.email, raw.payload.password);
        break;

      case 'GET_CREDENTIALS_STATUS': {
        const status = await this.buildCredentialStatus();
        this.post({ type: 'CREDENTIALS_STATUS', payload: status });
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

      case 'LOAD_APPS':
        await this.handleLoadApps(raw.payload.org);
        break;

      case 'START_DEBUG':
        await this.handleStartDebug(raw.payload.appNames, raw.payload.org);
        break;

      case 'STOP_DEBUG':
        stopProcess(raw.payload.appName);
        break;

      case 'STOP_ALL_DEBUG': {
        stopAllProcesses();
        break;
      }
        
      case 'OPEN_APP_URL':
        this.handleOpenAppUrl(raw.payload.url, raw.payload.source);
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

      case 'REQUEST_CHANGE_MAPPING': {
        // "Keep Running & Change" was intentionally removed: switching orgs while
        // SSH tunnels are active leaves orphaned processes and stale CF targets.
        // User must explicitly stop all sessions before remapping.
        const confirmed = await vscode.window.showWarningMessage(
          'You have active debug sessions running. All sessions will be stopped before changing the organization mapping.',
          { modal: true },
          'Stop Sessions & Change'
        );
        if (confirmed === 'Stop Sessions & Change') {
          stopAllProcesses();
          this.post({ type: 'PROCEED_CHANGE_MAPPING' });
        }
        // Cancel does nothing
        break;
      }

      case 'GET_DEBUG_PREFS':
        this.post({ type: 'DEBUG_PREFS', payload: getDebugPreferences() });
        break;

      case 'SAVE_DEBUG_PREFS':
        await saveDebugPreferences(raw.payload);
        this.post({ type: 'DEBUG_PREFS', payload: raw.payload });
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
        this.post({ type: 'CACHE_CONFIG', payload: settings });
        break;
      }
    }
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
    this.post({ type: 'GROUP_FOLDER_SELECTED', payload: { path: selected.fsPath } });
  }

  private async handleLogin(apiEndpoint: string): Promise<void> {
    const { email, password } = await getCredentials();

    if (!email || !password) {
      const msg = 'No SAP credentials found. Please set your credentials in the extension setup screen.';
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
      this.post({ type: 'LOGIN_SUCCESS', payload: { orgs } });
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`Login failed: ${msg}`);
      // Auth failure with keychain credentials → clear stale creds and redirect
      // to SETUP_CREDENTIALS (posting CREDENTIALS_REVOKED). Skip LOGIN_ERROR to
      // avoid a conflicting screen transition.
      const revoked = await this.handleAuthFailure(err);
      if (!revoked) {
        this.post({ type: 'LOGIN_ERROR', payload: { message: msg } });
      }
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
        const ttlMs = cacheSettings.intervalHours * 60 * 60 * 1000;
        if (ageMs < ttlMs) {
          logInfo(`Apps served from cache for org: ${org} (${Math.floor(ageMs / 60_000).toString()}m old).`);
          this.post({ type: 'APPS_LOADED', payload: { apps: cached.apps } });
          // Warm up the CF session in the background so that handleStartDebug
          // never hits an expired token when the app list came from cache.
          // Failures are silently retried with a full re-login.
          void this.ensureCfSession(config.apiEndpoint, org);
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

    // Always target the org before opening the cf ssh tunnel. handleLoadApps may have
    // served apps from cache without calling cfTarget, leaving ~/.cf untargeted.
    // If the token has expired in the meantime, re-login automatically.
    try {
      await cfTarget(org);
    } catch {
      logInfo(`cfTarget failed — attempting re-login before starting debug for ${org}.`);
      try {
        await this.reLogin(config.apiEndpoint);
        await cfTarget(org);
      } catch (retryErr: unknown) {
        const msg = extractErrorMessage(retryErr);
        logError(`Failed to target org ${org} after re-login: ${msg}`);
        // Auth failure → clear stale keychain creds and redirect to credential setup.
        const revoked = await this.handleAuthFailure(retryErr);
        if (!revoked) {
          this.post({ type: 'DEBUG_ERROR', payload: { message: `CF target failed: ${msg}` } });
        }
        return;
      }
    }

    const groupPath = mapping.groupFolderPath;

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

    if (targets.length === 0) {
      // All apps unmapped — build fallback targets using workspaceRoot so debug can still proceed.
      // Source maps won't resolve, but the SSH tunnel and debug console will work.
      logWarn(`No local folder found for any selected app. Starting debug in console-only mode (no source maps).`);
      let port = DEBUG_BASE_PORT;
      const fallbackTargets: DebugTarget[] = [];
      for (const appName of unmapped) {
        const existingPort = existingPorts[appName];
        if (existingPort !== undefined) {
          fallbackTargets.push({ appName, folderPath: workspaceRoot, port: existingPort, noLocalFolder: true });
          usedPorts.add(existingPort);
        } else {
          while (usedPorts.has(port)) port++;
          fallbackTargets.push({ appName, folderPath: workspaceRoot, port, noLocalFolder: true });
          usedPorts.add(port);
          port++;
        }
      }
      await this.launchDebugSessions(fallbackTargets, workspaceRoot, []);
      return;
    }

    // Branch preparation is an experimental feature — only run when explicitly enabled.
    const debugPrefs = getDebugPreferences();
    let finalTargets: DebugTarget[];

    if (debugPrefs.enableBranchPrep) {
      // Read workspace-level config for orgBranchMap fallback
      const workspaceCapConfig = await readCapDebugConfig(join(workspaceRoot, '.vscode'));

      // Resolve target branches: config lookup + optional QuickPick for unconfigured repos
      const branchInfos = await this.resolveTargetBranches(targets, org, workspaceCapConfig);

      // Services with a target branch go through preparation; others proceed directly
      const servicesNeedingPrep = branchInfos.filter((b) => b.targetBranch !== null);
      const targetsSkippingPrep = targets.filter((t) => !branchInfos.find((b) => b.appName === t.appName)?.targetBranch);

      if (servicesNeedingPrep.length > 0) {
        const prepServices: BranchPrepService[] = servicesNeedingPrep.map((b) => ({
          appName: b.appName,
          targetBranch: b.targetBranch ?? '',
          currentBranch: b.currentBranch ?? 'unknown',
        }));
        this.post({ type: 'BRANCH_PREP_START', payload: { services: prepServices } });

        const prepSuccessful = await this.runBranchPreparation(targets, branchInfos);
        finalTargets = [...targetsSkippingPrep, ...prepSuccessful];
      } else {
        finalTargets = targets;
      }
    } else {
      finalTargets = targets;
    }

    if (finalTargets.length === 0) {
      this.post({ type: 'DEBUG_ERROR', payload: { message: 'Branch preparation failed for all services.' } });
      return;
    }

    await this.launchDebugSessions(finalTargets, workspaceRoot, unmapped);
  }

  /**
   * Determines the target branch for each debug target.
   * Priority: per-app `branch` field > workspace `orgBranchMap` > per-app `orgBranchMap` > QuickPick.
   * QuickPick is shown once per git repo root to avoid duplicate prompts in monorepos.
   */
  private async resolveTargetBranches(
    targets: DebugTarget[],
    org: string,
    workspaceConfig: CapDebugConfig | null,
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
        const orgMap = workspaceConfig?.orgBranchMap ?? appConfig?.orgBranchMap;
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
      this.post({ type: 'BRANCH_PREP_STATUS', payload });
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
  private async launchDebugSessions(targets: DebugTarget[], workspaceRoot: string, unmapped: string[]): Promise<void> {
    await mergeLaunchJson(workspaceRoot, targets);
    logInfo(`Updated .vscode/launch.json with ${targets.length.toString()} config(s).`);

    const ports: Record<string, number> = {};
    for (const target of targets) {
      ports[target.appName] = target.port;
    }
    const noLocalFolderApps = targets.filter((t) => t.noLocalFolder).map((t) => t.appName);
    this.post({
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
      this.post({ type: 'DEBUG_ERROR', payload: { message: msg } });
      return;
    }
    void vscode.env.openExternal(safeUri);
  }

  /** Builds a CredentialStatus snapshot for the current session. */
  private async buildCredentialStatus(): Promise<CredentialStatus> {
    const { email } = await getCredentials();
    const source = await getCredentialSource();
    return {
      hasCredentials: !!(email),
      maskedEmail: maskEmail(email),
      source,
    };
  }

  private async handleSaveCredentials(email: string, password: string): Promise<void> {
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0 || !trimmedEmail.includes('@')) {
      this.post({ type: 'CREDENTIALS_ERROR', payload: { message: 'Please enter a valid email address.' } });
      return;
    }
    if (!password) {
      this.post({ type: 'CREDENTIALS_ERROR', payload: { message: 'Password is required.' } });
      return;
    }
    try {
      await saveCredentialsToSecretStorage(trimmedEmail, password);
      logInfo(`[Credentials] Saved credentials for ${maskEmail(trimmedEmail)} to SecretStorage.`);
      this.post({
        type: 'CREDENTIALS_SAVED',
        payload: { maskedEmail: maskEmail(trimmedEmail), source: 'keychain' },
      });
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`[Credentials] Failed to save credentials: ${msg}`);
      this.post({ type: 'CREDENTIALS_ERROR', payload: { message: `Could not save credentials: ${msg}` } });
    }
  }

  private async handleClearCredentials(): Promise<void> {
    await clearCredentialsFromSecretStorage();
    const status = await this.buildCredentialStatus();
    logInfo('[Credentials] Credentials cleared from SecretStorage.');
    this.post({ type: 'CREDENTIALS_STATUS', payload: status });
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
    this.post({
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
  private async ensureCfSession(apiEndpoint: string, org: string): Promise<void> {
    try {
      await cfTarget(org);
      logInfo(`[Session] CF session refreshed — org ${org} targeted.`);
    } catch {
      logInfo(`[Session] cfTarget failed — attempting silent re-login for org ${org}.`);
      try {
        await this.reLogin(apiEndpoint);
        await cfTarget(org);
        logInfo(`[Session] Silent re-login successful — org ${org} targeted.`);
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
