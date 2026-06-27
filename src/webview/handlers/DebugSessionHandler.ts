import * as vscode from 'vscode';
import type { AppFolderMapping, BranchPrepService, CapDebugConfig, DebugTarget} from '../../types/index';
import { cfAppRoutes, cfTarget } from '../../core/cfClient';
import { isAppWatchdogInitialized, normalizeRouteUrl, registerWatchedApps, type WatchedAppRegistration } from '../../core/appWatchdog';
import { findRepoFolder } from '../../core/folderScanner';
import { buildDebugTargets, buildFallbackTargets, getFolderNameCandidates, resolveOverrideFolder } from '../../core/appMapper';
import { getAppFolderMappings } from '../../core/appFolderMappingSettings';
import { getExistingLaunchConfigs, mergeLaunchJson, readCapDebugConfig } from '../../core/launchConfigurator';
import { resolveSharedCapDebugConfig } from '../../core/capDebugConfig';
import { parseRemoteRootSetting, type RemoteRootResolution } from '../../core/remoteRootResolver';
import { getConfig, mappingMatchesTarget } from '../../storage/configStore';
import { getCachedApps, getDebugPreferences } from '../../storage/cacheStore';
import { regionCodeFromApiEndpoint } from '../../storage/scopeSync';
import { getAppsFromTopologySync } from '../../core/cfTopology';
import { logError, logInfo, logWarn, showLogChannel } from '../../core/logger';
import { startTunnelAndAttach, stopProcess, getSessionParams } from '../../core/processManager';
import type { DebugLauncherViewProvider } from '../debugPanel';
import type { CfTargetScope} from "../webviewUtils";
import { extractErrorMessage, firstMappedRoute, apiEndpointHost, describeRemoteRootResolution } from "../webviewUtils";

export class DebugSessionHandler {
  constructor(public provider: DebugLauncherViewProvider) {}

    public async handleStartDebug(appNames: string[], org: string, space: string): Promise<void> {
        const config = getConfig();
        if (!config) {
          // The webview optimistically added PENDING session cards on click — a silent
          // return would leave them spinning forever.
          this.provider.postMessage({
            type: 'DEBUG_ERROR',
            payload: { message: 'Extension configuration is missing. Please log in again.' },
          });
          return;
        }

        const mapping = config.orgGroupMappings.find((m) => mappingMatchesTarget(m, org, space));
        if (!mapping) {
          const msg = `No mapping found for org/space: ${org}/${space}`;
          logError(msg);
          this.provider.postMessage({ type: 'DEBUG_ERROR', payload: { message: msg } });
          return;
        }

        logInfo(`Starting debug for ${appNames.length.toString()} app(s): ${appNames.join(', ')}`);
        await this.provider.awaitWarmupIfRunning(config.apiEndpoint, org, space);
        logInfo(`[StartDebug] Targeting CF org/space: ${org}/${space}…`);
        try {
          await cfTarget(org, space);
          logInfo(`[StartDebug] CF org/space targeted successfully.`);
        } catch {
          logInfo(`cfTarget failed — attempting re-login before starting debug for ${org}/${space}.`);
          try {
            logInfo(`[StartDebug] Re-authenticating to ${config.apiEndpoint}…`);
            await this.provider.reLogin(config.apiEndpoint);
            logInfo(`[StartDebug] Re-authentication successful. Targeting org/space again…`);
            await cfTarget(org, space);
            logInfo(`[StartDebug] CF org/space targeted after re-login.`);
          } catch (retryErr: unknown) {
            const msg = extractErrorMessage(retryErr);
            logError(`Failed to target org/space ${org}/${space} after re-login: ${msg}`);
            // Auth failure → clear stale keychain creds and redirect to credential setup.
            const revoked = await this.provider.handleAuthFailure(retryErr);
            if (!revoked) {
              this.provider.postMessage({ type: 'DEBUG_ERROR', payload: { message: `CF target failed: ${msg}` } });
            }
            return;
          }
        }

        const groupPath = mapping.groupFolderPath;
        const appFolderMappings = getAppFolderMappings();
        logInfo(`[StartDebug] Resolving local folders under: ${groupPath}`);
        const resolvedPaths: string[] = [];
        for (const appName of appNames) {
          const folderPath = await this.provider.resolveLocalFolderPath(groupPath, appName, appFolderMappings);

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
          this.provider.postDiscoveringRemoteRoot(fallbackTargets);
          const resolvedRemoteRoots = await this.provider.resolveRemoteRootsForTargets(
            fallbackTargets,
            config.apiEndpoint,
            org,
            space,
            sharedCapConfig,
          );
          await this.provider.launchDebugSessions(
            fallbackTargets,
            workspaceRoot,
            [],
            sharedCapConfig,
            resolvedRemoteRoots,
            { apiEndpoint: config.apiEndpoint, org, space },
          );
          return;
        }

        const debugPrefs = getDebugPreferences();
        let finalTargets: DebugTarget[];
        if (debugPrefs.enableBranchPrep) {
          // Resolve target branches: config lookup + optional QuickPick for unconfigured repos
          const branchInfos = await this.provider.resolveTargetBranches(targets, org, sharedCapConfig);

          // Services with a target branch go through preparation; others proceed directly
          const servicesNeedingPrep = branchInfos.filter((b) => b.targetBranch !== null);
          const targetsSkippingPrep = targets.filter((t) => !branchInfos.find((b) => b.appName === t.appName)?.targetBranch);

          if (servicesNeedingPrep.length > 0) {
            const prepServices: BranchPrepService[] = servicesNeedingPrep.map((b) => ({
              appName: b.appName,
              targetBranch: b.targetBranch ?? '',
              currentBranch: b.currentBranch ?? 'unknown',
            }));
            this.provider.postMessage({ type: 'BRANCH_PREP_START', payload: { services: prepServices } });

            const prepSuccessful = await this.provider.runBranchPreparation(targets, branchInfos);
            finalTargets = [...targetsSkippingPrep, ...prepSuccessful];
          } else {
            finalTargets = targets;
          }
        } else {
          finalTargets = targets;
        }

        if (finalTargets.length === 0) {
          this.provider.postMessage({ type: 'DEBUG_ERROR', payload: { message: 'Branch preparation failed for all services.' } });
          return;
        }

        this.provider.postDiscoveringRemoteRoot(finalTargets);
        const resolvedRemoteRoots = await this.provider.resolveRemoteRootsForTargets(
                  finalTargets,
                  config.apiEndpoint,
                  org,
                  space,
                  sharedCapConfig,
                );
        await this.provider.launchDebugSessions(
          finalTargets,
          workspaceRoot,
          unmapped,
          sharedCapConfig,
          resolvedRemoteRoots,
          { apiEndpoint: config.apiEndpoint, org, space },
        );
    }

    public async handleRetryDebug(appName: string): Promise<void> {
        const params = getSessionParams(appName);
        if (!params) {
          // Params cleared (e.g. extension restarted) — cannot retry automatically.
          this.provider.postMessage({ type: 'DEBUG_ERROR', payload: { message: `Cannot retry ${appName}: session parameters lost. Please start the debug session again.` } });
          return;
        }

        logInfo(`[Retry] Restarting tunnel for ${appName} on port ${params.port.toString()}`);
        await stopProcess(appName, /* skipConfigCleanup */ true, /* silent */ true);
        void startTunnelAndAttach(appName, params.folderPath, params.port, params.launchConfigName).catch((err: unknown) => {
          logError(`[Retry] Tunnel restart failed for ${appName}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    public async handleBeforeReconnect(appName: string, params: { folderPath: string; port: number; launchConfigName: string }): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot === undefined) return;
        const target: DebugTarget = { appName, folderPath: params.folderPath, port: params.port };
        const fallbackConfig = await resolveSharedCapDebugConfig(workspaceRoot);
        const cachedRemoteRoot = this.provider.resolvedRemoteRootByApp.get(appName);
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

    public postDiscoveringRemoteRoot(targets: readonly DebugTarget[]): void {
        if (targets.length === 0) return;
        this.provider.postMessage({
          type: 'DEBUG_DISCOVERING_REMOTE_ROOT',
          payload: { appNames: targets.map((target) => target.appName) },
        });
    }

    public async resolveLocalFolderPath(groupPath: string, appName: string, overrides: readonly AppFolderMapping[]): Promise<string | null> {
        for (const candidate of getFolderNameCandidates(appName, overrides)) {
          const folderPath = await findRepoFolder(groupPath, candidate);
          if (folderPath !== null) return folderPath;
        }

        return null;
    }

    public async getConfiguredRemoteRoot(target: DebugTarget, fallbackConfig: CapDebugConfig | null): Promise<string | undefined> {
        const appConfig = target.noLocalFolder === true ? null : await readCapDebugConfig(target.folderPath);
        return appConfig?.remoteRoot ?? fallbackConfig?.remoteRoot;
    }

    public async resolveRemoteRootsForTargets(targets: readonly DebugTarget[], apiEndpoint: string, org: string, space: string, fallbackConfig: CapDebugConfig | null): Promise<Map<string, string>> {
        const resolved = new Map<string, string>();
        await Promise.allSettled(
          targets.map(async (target) => {
            const configuredRemoteRoot = await this.provider.getConfiguredRemoteRoot(target, fallbackConfig);
            await this.provider.resolveRemoteRootForTarget(target, apiEndpoint, org, space, configuredRemoteRoot, resolved);
          }),
        );
        return resolved;
    }

    public async resolveRemoteRootForTarget(target: DebugTarget, apiEndpoint: string, org: string, space: string, configuredRemoteRoot: string | undefined, resolved: Map<string, string>): Promise<void> {
        if (configuredRemoteRoot === undefined) return;
        const setting = parseRemoteRootSetting(configuredRemoteRoot);
        if (setting.kind === 'invalid-regex') {
          logWarn(`[RemoteRoot] ${target.appName}: invalid regex (${setting.error})`);
          return;
        }

        if (setting.kind !== 'regex') return;
        const cacheKey = this.provider.remoteRootCacheKey(apiEndpoint, org, space, target.appName, configuredRemoteRoot);
        const cached = this.provider.resolvedRemoteRoots.get(cacheKey);
        if (cached !== undefined) {
          resolved.set(target.appName, cached);
          return;
        }

        try {
          const result = await this.provider.remoteRootLookupCoordinator.resolve(cacheKey, target.appName, configuredRemoteRoot);
          this.provider.storeResolvedRemoteRoot(apiEndpoint, org, space, target.appName, configuredRemoteRoot, result);
          if (result.status === 'resolved') {
            resolved.set(target.appName, result.remoteRoot);
          } else if (result.status === 'unmatched' || result.status === 'invalid-regex') {
            this.provider.notifyUnmatchedRemoteRoot(target.appName, cacheKey, result, target.folderPath);
          }
        } catch (err: unknown) {
          logWarn(`[RemoteRoot] ${target.appName}: on-demand lookup failed (${extractErrorMessage(err)})`);
        }
    }

    public notifyUnmatchedRemoteRoot(appName: string, cacheKey: string, result: RemoteRootResolution, folderPath: string): void {
        if (this.provider.notifiedUnmatchedRemoteRoots.has(cacheKey)) return;
        this.provider.notifiedUnmatchedRemoteRoots.add(cacheKey);
        const detail = describeRemoteRootResolution(result);
        const message = `CDS Debug: remoteRoot for "${appName}" — ${detail}. Breakpoints may not bind until cap-debug-config.json is corrected.`;
        void vscode.window.showWarningMessage(message, 'Open cap-debug-config.json', 'Open Output Channel', 'Continue Anyway')
        .then((choice) => {
        if (choice === 'Open cap-debug-config.json') {
          return this.provider.openCapDebugConfig(folderPath);
        }
        if (choice === 'Open Output Channel') {
          showLogChannel();
        }
        return undefined;
        });
    }

    public async openCapDebugConfig(folderPath: string): Promise<void> {
        const configUri = vscode.Uri.joinPath(vscode.Uri.file(folderPath), 'cap-debug-config.json');
        try {
          const doc = await vscode.workspace.openTextDocument(configUri);
          await vscode.window.showTextDocument(doc);
        } catch {
          // No per-service file — fall back to the user-level setting that controls the same field.
          await vscode.commands.executeCommand('workbench.action.openSettings', 'cdsDebug.sharedCapDebugConfig');
        }
    }

    public storeResolvedRemoteRoot(apiEndpoint: string, org: string, space: string, appName: string, configuredRemoteRoot: string, result: RemoteRootResolution): void {
        if (result.status === 'resolved') {
          const cacheKey = this.provider.remoteRootCacheKey(apiEndpoint, org, space, appName, configuredRemoteRoot);
          this.provider.resolvedRemoteRoots.set(cacheKey, result.remoteRoot);
          this.provider.resolvedRemoteRootByApp.set(appName, result.remoteRoot);
          logInfo(`[RemoteRoot] ${appName} resolved to ${result.remoteRoot}`);
          return;
        }

        if (result.status !== 'literal' && result.status !== 'none') {
          logWarn(`[RemoteRoot] ${appName}: ${describeRemoteRootResolution(result)}`);
        }
    }

    public remoteRootCacheKey(apiEndpoint: string, org: string, space: string, appName: string, configuredRemoteRoot: string): string {
        return JSON.stringify([apiEndpoint, org, space, appName, configuredRemoteRoot]);
    }

    /** Merges launch.json, posts DEBUG_CONNECTING, and starts tunnel processes. */
    public async launchDebugSessions(targets: DebugTarget[], workspaceRoot: string, unmapped: string[], fallbackConfig: CapDebugConfig | null, resolvedRemoteRoots: ReadonlyMap<string, string>, scope: CfTargetScope): Promise<void> {
        logInfo(`[StartDebug] Merging launch.json for ${targets.length.toString()} target(s)…`);
        await mergeLaunchJson(workspaceRoot, targets, fallbackConfig, { resolvedRemoteRoots });
        logInfo(`Updated .vscode/launch.json with ${targets.length.toString()} config(s).`);
        const ports: Record<string, number> = {};
        for (const target of targets) {
          ports[target.appName] = target.port;
        }

        const noLocalFolderApps = targets.filter((t) => t.noLocalFolder).map((t) => t.appName);
        this.provider.postMessage({
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

        void this.provider.registerWatchdogForTargets(targets, scope).catch((err: unknown) => {
          logWarn(`[AppWatchdog] Failed to register watched apps: ${err instanceof Error ? err.message : String(err)}`);
        });
        if (unmapped.length > 0) {
          logWarn(`${unmapped.length.toString()} app(s) not mapped: ${unmapped.join(', ')}`);
          void vscode.window.showWarningMessage(
            `${unmapped.length.toString()} app(s) could not be mapped to a local folder: ${unmapped.join(', ')}`,
          );
        }
    }

    /**
     * Records the started apps in the App Watchdog registry (~/.cds-debug) so their
     * mapped routes are pinged for the configured watch window — catching apps left
     * frozen on a breakpoint after this debug session ends badly.
     */
    public async registerWatchdogForTargets(targets: DebugTarget[], scope: CfTargetScope): Promise<void> {
        if (!isAppWatchdogInitialized()) return;
        const region = regionCodeFromApiEndpoint(scope.apiEndpoint) ?? apiEndpointHost(scope.apiEndpoint);
        const startedAt = Date.now();
        const entries: WatchedAppRegistration[] = [];
        for (const target of targets) {
          const url = await this.provider.resolveAppRouteUrl(scope, target.appName);
          if (url === undefined) {
            logWarn(`[AppWatchdog] No mapped route found for ${target.appName}; it will not be watched.`);
            continue;
          }
          entries.push({ appName: target.appName, org: scope.org, space: scope.space, region, url, startedAt });
        }

        await registerWatchedApps(entries);
    }

    /** Mapped-route lookup: synced topology → app cache → live `cf app` fallback. */
    public async resolveAppRouteUrl(scope: CfTargetScope, appName: string): Promise<string | undefined> {
        const fromTopology = firstMappedRoute(getAppsFromTopologySync(scope.apiEndpoint, scope.org, scope.space), appName);
        if (fromTopology !== undefined) return normalizeRouteUrl(fromTopology);
        const fromCache = firstMappedRoute(getCachedApps(scope.apiEndpoint, scope.org, scope.space)?.apps, appName);
        if (fromCache !== undefined) return normalizeRouteUrl(fromCache);
        const routes = await cfAppRoutes(appName).catch(() => [] as string[]);
        const first = routes.find((route) => route.trim().length > 0);
        return first === undefined ? undefined : normalizeRouteUrl(first);
    }
















}
