import * as vscode from 'vscode';
import { join } from 'node:path';
import type { BranchPrepService, BranchPrepStep, CacheSettings, CapDebugConfig, DebugTarget, ExtensionMessage, OrgGroupMapping, SyncProgress, WebviewMessage } from '../types/index';
import { DEFAULT_CACHE_SETTINGS } from '../types/index';
import { cfLogin, cfLogout, cfOrgs, cfTarget, cfTargetAndApps } from '../core/cfClient';
import { findRepoFolder } from '../core/folderScanner';
import { buildDebugTargets, getFolderNameCandidates } from '../core/appMapper';
import { mergeLaunchJson, readCapDebugConfig, removeLaunchConfigs } from '../core/launchConfigurator';
import { getConfig, saveConfig } from '../storage/configStore';
import { getCredentials } from '../core/shellEnv';
import { getCachedApps, getCacheSettings, saveCacheSettings } from '../storage/cacheStore';
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
  runPnpmBuild,
  runPnpmInstall,
  stashChanges,
} from '../core/gitOperations';

interface ServiceBranchInfo {
  appName: string;
  folderPath: string;
  repoRoot: string | null;
  targetBranch: string | null;
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
        this.post({
          type: 'CONFIG_LOADED',
          payload: {
            config: config ?? null,
            activeSessions: getActiveSessions(),
          },
        });
        break;
      }

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
        await this.cleanupLaunchConfig([raw.payload.appName]);
        break;

      case 'STOP_ALL_DEBUG': {
        const activeAppNames = Object.keys(getActiveSessions());
        stopAllProcesses();
        await this.cleanupLaunchConfig(activeAppNames);
        break;
      }
        
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
        const VALID_INTERVALS: readonly number[] = [1, 2, 4, 8];
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
        const ttlMs = cacheSettings.intervalHours * 60 * 60 * 1000;
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

    // Always target the org before spawning cds debug. handleLoadApps may have
    // served apps from cache without calling cfTarget, leaving ~/.cf untargeted.
    // cds debug uses cf ssh internally which requires an active org/space target.
    try {
      await cfTarget(org);
    } catch (err: unknown) {
      const msg = extractErrorMessage(err);
      logError(`Failed to target org ${org}: ${msg}`);
      this.post({ type: 'DEBUG_ERROR', payload: { message: `CF target failed: ${msg}` } });
      return;
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
      const existingConfigs = await import('../core/launchConfigurator').then((m) => m.getExistingLaunchConfigs(workspaceRoot));
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
      const msg = `Could not map any app to a local folder. Unmapped: ${unmapped.join(', ')}`;
      logError(msg);
      this.post({ type: 'DEBUG_ERROR', payload: { message: msg } });
      return;
    }

    // Read workspace-level config for orgBranchMap fallback
    const workspaceCapConfig = await readCapDebugConfig(join(workspaceRoot, '.vscode'));

    // Resolve target branches: config lookup + optional QuickPick for unconfigured repos
    const branchInfos = await this.resolveTargetBranches(targets, org, workspaceCapConfig);

    // Services with a target branch go through preparation; others proceed directly
    const servicesNeedingPrep = branchInfos.filter((b) => b.targetBranch !== null);
    const targetsSkippingPrep = targets.filter((t) => !branchInfos.find((b) => b.appName === t.appName)?.targetBranch);

    let finalTargets: DebugTarget[];

    if (servicesNeedingPrep.length > 0) {
      // Build list for webview prep screen (targetBranch is non-null for servicesNeedingPrep)
      const prepServices: BranchPrepService[] = await Promise.all(
        servicesNeedingPrep.map(async (b) => ({
          appName: b.appName,
          targetBranch: b.targetBranch ?? '',
          currentBranch: (await getCurrentBranch(b.repoRoot ?? b.folderPath)) ?? 'unknown',
        })),
      );
      this.post({ type: 'BRANCH_PREP_START', payload: { services: prepServices } });

      const prepSuccessful = await this.runBranchPreparation(targets, branchInfos);
      finalTargets = [...targetsSkippingPrep, ...prepSuccessful];
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
    const results: ServiceBranchInfo[] = [];
    const repoRoots = new Map<string, string | null>(); // folderPath → repoRoot
    const resolvedBranches = new Map<string, string | null>(); // appName → targetBranch

    // Repos that need a QuickPick: repoRoot → appNames
    const reposNeedingPrompt = new Map<string, string[]>();

    for (const target of targets) {
      let repoRoot = repoRoots.get(target.folderPath);
      if (repoRoot === undefined) {
        repoRoot = await getGitRepoRoot(target.folderPath);
        repoRoots.set(target.folderPath, repoRoot);
      }

      const appConfig = await readCapDebugConfig(target.folderPath);

      if (appConfig?.branch) {
        // Highest priority: per-app branch override
        resolvedBranches.set(target.appName, appConfig.branch);
      } else {
        const orgMap = workspaceConfig?.orgBranchMap ?? appConfig?.orgBranchMap;
        if (orgMap?.[org]) {
          resolvedBranches.set(target.appName, orgMap[org]);
        } else if (repoRoot) {
          // Queue for QuickPick (grouped by repo root to avoid duplicate prompts)
          if (!reposNeedingPrompt.has(repoRoot)) reposNeedingPrompt.set(repoRoot, []);
          const queuedNames = reposNeedingPrompt.get(repoRoot);
          if (queuedNames) queuedNames.push(target.appName);
        } else {
          // Not a git repo — skip branch ops
          resolvedBranches.set(target.appName, null);
        }
      }
    }

    // Show one QuickPick per repo that has no configured branch
    for (const [repoRoot, appNamesForRepo] of reposNeedingPrompt) {
      const branches = await listBranches(repoRoot);
      const currentBranch = await getCurrentBranch(repoRoot);
      const serviceLabel = appNamesForRepo.join(', ');

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
        title: `Select branch to debug: ${serviceLabel}`,
        placeHolder: `Current branch: ${currentBranch ?? 'unknown'}`,
        matchOnDescription: true,
      });

      const chosenBranch = selected ? selected.branch : null;
      for (const appName of appNamesForRepo) {
        resolvedBranches.set(appName, chosenBranch);
      }
    }

    for (const target of targets) {
      results.push({
        appName: target.appName,
        folderPath: target.folderPath,
        repoRoot: repoRoots.get(target.folderPath) ?? null,
        targetBranch: resolvedBranches.get(target.appName) ?? null,
      });
    }

    return results;
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
          const currentBranch = await getCurrentBranch(repoRoot);

          if (currentBranch === info.targetBranch) {
            // Already on the correct branch — no checkout needed
            logInfo(`[${info.appName}] Already on branch ${info.targetBranch}, skipping git ops.`);
            postStatus(info.appName, 'skipped', `Already on branch ${info.targetBranch}`);
            repoCheckedOut.set(repoRoot, false);
            successfulTargets.push(target);
            continue;
          }

          // Stash uncommitted changes if any
          const dirty = await hasUncommittedChanges(repoRoot);
          if (dirty) {
            logInfo(`[${info.appName}] Stashing uncommitted changes in ${repoRoot}`);
            postStatus(info.appName, 'stashing');
            await stashChanges(repoRoot);
          }

          // Checkout target branch
          logInfo(`[${info.appName}] Checking out branch ${info.targetBranch} in ${repoRoot}`);
          postStatus(info.appName, 'checking-out');
          await checkoutBranch(repoRoot, info.targetBranch);
          repoCheckedOut.set(repoRoot, true);
        } else if (!repoCheckedOut.get(repoRoot)) {
          // Shared repo that was already-on-right-branch — skip this service too
          logInfo(`[${info.appName}] Shared repo already on correct branch, skipping git ops.`);
          postStatus(info.appName, 'skipped', `Already on branch ${info.targetBranch}`);
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
    this.post({ type: 'DEBUG_CONNECTING', payload: { appNames: targets.map((t) => t.appName), ports } });

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

  private async cleanupLaunchConfig(appNames: string[]): Promise<void> {
    if (appNames.length === 0) return;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      logWarn('Cannot clean launch.json: no workspace folder open.');
      return;
    }
    try {
      await removeLaunchConfigs(workspaceRoot, appNames);
      logInfo(`Removed ${appNames.length.toString()} debug config(s) from launch.json.`);
    } catch (err: unknown) {
      logWarn(`Failed to clean launch.json: ${err instanceof Error ? err.message : String(err)}`);
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
