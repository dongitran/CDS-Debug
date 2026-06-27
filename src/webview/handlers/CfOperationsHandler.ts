import type { CfApp} from '../../types/index';
import { cfTarget, cfTargetAndApps, cfTargetOrgAndSpaces, cfScaleAppInstances, isCfAuthError } from '../../core/cfClient';
import { refreshCfSyncSpace } from '../../core/cfSpaceRefresh';
import { getConfig, mappingMatchesTarget } from '../../storage/configStore';
import { getCredentials } from '../../core/shellEnv';
import { getCachedApps, getCacheSettings, getLastSpaceRefreshAt, saveCachedApps, saveLastSpaceRefreshAt } from '../../storage/cacheStore';
import { getAppsFromTopologySync } from '../../core/cfTopology';
import { logError, logInfo, logWarn } from '../../core/logger';
import { getActiveAppNames } from '../../core/processManager';
import type { DebugLauncherViewProvider} from '../debugPanel';
import { extractErrorMessage, MIN_BADGE_SCALE_INSTANCES, validateBadgeScaleRequest } from "../webviewUtils";

export class CfOperationsHandler {
  constructor(public provider: DebugLauncherViewProvider) {}

    public async handleLoadSpaces(org: string): Promise<void> {
        const config = getConfig();
        if (!config) {
          // No config (e.g. reset while the webview retained old state) — a silent return
          // would leave the webview on its loading screen forever.
          this.provider.postMessage({
            type: 'SPACES_ERROR',
            payload: { org, message: 'Extension configuration is missing. Please log in again.' },
          });
          return;
        }

        logInfo(`Loading spaces for org: ${org} …`);
        try {
          const spaces = await this.provider.loadLiveSpaces(config.apiEndpoint, org);
          logInfo(`Spaces loaded for ${org}: ${spaces.join(', ')}`);
          this.provider.postMessage({ type: 'SPACES_LOADED', payload: { org, spaces } });
        } catch (err: unknown) {
          const msg = extractErrorMessage(err);
          logError(`Failed to load spaces for ${org}: ${msg}`);
          const revoked = await this.provider.handleAuthFailure(err);
          if (!revoked) {
            this.provider.postMessage({ type: 'SPACES_ERROR', payload: { org, message: msg } });
          }
        }
    }

    public async handleLoadApps(org: string, space: string, forceRefresh = false): Promise<void> {
        const config = getConfig();
        if (!config) {
          this.provider.postMessage({
            type: 'APPS_ERROR',
            payload: { message: 'Extension configuration is missing. Please log in again.' },
          });
          return;
        }

        const mapping = config.orgGroupMappings.find((m) => mappingMatchesTarget(m, org, space));
        if (!mapping) {
          const msg = `No local folder mapped for org/space: ${org}/${space}`;
          logWarn(msg);
          this.provider.postMessage({ type: 'APPS_ERROR', payload: { message: msg } });
          return;
        }

        const cacheSettings = getCacheSettings();
        if (forceRefresh) {
          const credentialsRevoked = await this.provider.refreshCfSyncSpaceCache(config.apiEndpoint, org, space);
          if (credentialsRevoked) return;
          const served = await this.provider.tryServeTopologyApps(config.apiEndpoint, org, space);
          if (served) {
            void this.provider.pushCfTopology();
            return;
          }
        }

        const topologyServed = !forceRefresh
                  && await this.provider.tryServeTopologyApps(config.apiEndpoint, org, space);
        if (topologyServed) return;
        if (!forceRefresh && cacheSettings.enabled) {
          const cached = getCachedApps(config.apiEndpoint, org, space);
          if (cached) {
            const ageMs = Date.now() - cached.cachedAt;
            const ttlMs = cacheSettings.intervalHours * 60 * 60 * 1000;
            if (ageMs < ttlMs) {
              logInfo(`Apps served from cache for target: ${org}/${space} (${Math.floor(ageMs / 60_000).toString()}m old).`);
              this.provider.postMessage({ type: 'APPS_LOADED', payload: { apps: cached.apps } });
              await this.provider.writeScopeAfterAppsLoaded(org, space);
              // Refresh the CF token in the background. Avoids an expired-token
              // pause the first time Start Debug runs after restoring from cache.
              // Per-app remote folder discovery is deferred to Start Debug click.
              void this.provider.keepCfSessionAliveTracked(config.apiEndpoint, org, space);
              return;
            }
          }
        }

        logInfo(`Loading apps for target: ${org}/${space} …`);
        try {
          const apps = await this.provider.loadLiveApps(config.apiEndpoint, org, space);
          await saveCachedApps(config.apiEndpoint, org, apps, space);
          const started = apps.filter((a) => a.state === 'started').length;
          logInfo(`Apps loaded: ${apps.length.toString()} total, ${started.toString()} started.`);
          this.provider.postMessage({ type: 'APPS_LOADED', payload: { apps } });
          await this.provider.writeScopeAfterAppsLoaded(org, space);
          void this.provider.keepCfSessionAliveTracked(config.apiEndpoint, org, space);
        } catch (err: unknown) {
          const msg = extractErrorMessage(err);
          logError(`Failed to load apps for ${org}/${space}: ${msg}`);
          const revoked = await this.provider.handleAuthFailure(err);
          if (!revoked) {
            this.provider.postMessage({ type: 'APPS_ERROR', payload: { message: msg } });
          }
        }
    }

    public async handleWarmupCfSession(org: string, space: string): Promise<void> {
        const config = getConfig();
        if (!config) return;
        const mapping = config.orgGroupMappings.find((m) => mappingMatchesTarget(m, org, space));
        if (!mapping) return;
        const hasTopology = getAppsFromTopologySync(config.apiEndpoint, org, space) !== undefined;
        if (!hasTopology) return;
        await this.provider.writeScopeAfterAppsLoaded(org, space);
        await this.provider.keepCfSessionAliveTracked(config.apiEndpoint, org, space);
        this.provider.refreshStaleTopologySpaceInBackground(config.apiEndpoint, org, space);
    }

    public keepCfSessionAlive(apiEndpoint: string, org: string, space: string): Promise<void> {
        return this.provider.ensureCfSession(apiEndpoint, org, space);
    }

    public keepCfSessionAliveTracked(apiEndpoint: string, org: string, space: string): Promise<void> {
        const key = this.provider.warmupKey(apiEndpoint, org, space);
        const existing = this.provider.warmupPromises.get(key);
        if (existing) return existing;
        const warmup = this.provider.keepCfSessionAlive(apiEndpoint, org, space)
                  .finally(() => {
                    this.provider.warmupPromises.delete(key);
                  });
        this.provider.warmupPromises.set(key, warmup);
        return warmup;
    }

    public async awaitWarmupIfRunning(apiEndpoint: string, org: string, space: string): Promise<void> {
        const warmup = this.provider.warmupPromises.get(this.provider.warmupKey(apiEndpoint, org, space));
        if (warmup) await warmup;
    }

    public warmupKey(apiEndpoint: string, org: string, space: string): string {
        return JSON.stringify([apiEndpoint, org, space]);
    }

    public async refreshCfSyncSpaceCache(apiEndpoint: string, org: string, space: string): Promise<boolean> {
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

        const revoked = await this.provider.handleAuthFailure(result.error);
        if (revoked) return true;
        logWarn(`[Reload] cf-sync space refresh failed: ${extractErrorMessage(result.error)}`);
        return false;
    }

    public async tryServeTopologyApps(apiEndpoint: string, org: string, space: string): Promise<boolean> {
        const apps = getAppsFromTopologySync(apiEndpoint, org, space);
        if (apps === undefined || apps.length === 0) return false;
        logInfo(`[Topology] Skipped live cf apps for ${org}/${space} — using topology cache.`);
        await saveCachedApps(apiEndpoint, org, apps, space);
        this.provider.postMessage({ type: 'APPS_LOADED', payload: { apps } });
        await this.provider.writeScopeAfterAppsLoaded(org, space);
        void this.provider.keepCfSessionAliveTracked(apiEndpoint, org, space);
        this.provider.refreshStaleTopologySpaceInBackground(apiEndpoint, org, space);
        return true;
    }

    public refreshStaleTopologySpaceInBackground(apiEndpoint: string, org: string, space: string): void {
        const settings = getCacheSettings();
        if (!settings.enabled) return;
        const lastRefresh = getLastSpaceRefreshAt(apiEndpoint, org, space) ?? 0;
        const ttlMs = settings.intervalHours * 60 * 60 * 1000;
        if (Date.now() - lastRefresh <= ttlMs) return;
        void this.provider.refreshSingleSpaceInBackground(apiEndpoint, org, space);
    }

    public async refreshSingleSpaceInBackground(apiEndpoint: string, org: string, space: string): Promise<void> {
        const credentialsRevoked = await this.provider.refreshCfSyncSpaceCache(apiEndpoint, org, space);
        if (credentialsRevoked) return;
        void this.provider.pushCfTopology();
    }

    public async loadLiveSpaces(apiEndpoint: string, org: string): Promise<string[]> {
        try {
          return await cfTargetOrgAndSpaces(org);
        } catch (err: unknown) {
          if (!isCfAuthError(err)) throw err;
          logInfo(`cfTargetOrgAndSpaces auth failed — attempting re-login before loading spaces for ${org}.`);
          await this.provider.reLogin(apiEndpoint);
          return await cfTargetOrgAndSpaces(org);
        }
    }

    public async loadLiveApps(apiEndpoint: string, org: string, space: string): Promise<CfApp[]> {
        try {
          return await cfTargetAndApps(org, space);
        } catch (err: unknown) {
          if (!isCfAuthError(err)) throw err;
          logInfo(`cfTargetAndApps auth failed — attempting re-login before loading apps for ${org}/${space}.`);
          await this.provider.reLogin(apiEndpoint);
          return await cfTargetAndApps(org, space);
        }
    }

    public async handleScaleAppInstances(appName: string, org: string, space: string, targetInstances: number): Promise<void> {
        const config = getConfig();
        if (!config) return;
        const fail = (message: string): void => {
                  this.provider.postMessage({ type: 'APP_SCALE_ERROR', payload: { appName, message } });
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
          await this.provider.awaitWarmupIfRunning(config.apiEndpoint, org, space);
          const currentApps = await this.provider.loadLiveApps(config.apiEndpoint, org, space);
          const app = currentApps.find((candidate) => candidate.name === appName);
          const validationError = validateBadgeScaleRequest(app, targetInstances);
          if (validationError) {
            fail(validationError);
            return;
          }

          logInfo(`[Scale] Scaling ${appName} in ${org}/${space} to ${targetInstances.toString()} instance(s).`);
          await this.provider.scaleAppInstancesWithAuthRetry(config.apiEndpoint, org, space, appName, targetInstances);
          const apps = await this.provider.loadLiveApps(config.apiEndpoint, org, space);
          await saveCachedApps(config.apiEndpoint, org, apps, space);
          this.provider.postMessage({ type: 'APPS_LOADED', payload: { apps } });
          void this.provider.keepCfSessionAliveTracked(config.apiEndpoint, org, space);
        } catch (err: unknown) {
          const msg = extractErrorMessage(err);
          logError(`[Scale] Failed to scale ${appName} in ${org}/${space}: ${msg}`);
          const revoked = await this.provider.handleAuthFailure(err);
          if (!revoked) fail(`Failed to scale ${appName}: ${msg}`);
        }
    }

    public async scaleAppInstancesWithAuthRetry(apiEndpoint: string, org: string, space: string, appName: string, targetInstances: number): Promise<void> {
        try {
          await cfScaleAppInstances(appName, targetInstances);
        } catch (err: unknown) {
          if (!isCfAuthError(err)) throw err;
          logInfo(`cfScaleAppInstances auth failed — attempting re-login before scaling ${appName}.`);
          await this.provider.reLogin(apiEndpoint);
          await cfTarget(org, space);
          await cfScaleAppInstances(appName, targetInstances);
        }
    }

    /**
     * Targets the given CF org in the background to keep ~/.cf warmed up.
     * Called after serving apps from cache so that handleStartDebug never
     * encounters an expired token as the very first CF CLI invocation.
     */
    public async ensureCfSession(apiEndpoint: string, org: string, space: string): Promise<void> {
        try {
          await cfTarget(org, space);
          logInfo(`[Session] CF session refreshed — target ${org}/${space} selected.`);
        } catch {
          logInfo(`[Session] cfTarget failed — attempting silent re-login for ${org}/${space}.`);
          try {
            await this.provider.reLogin(apiEndpoint);
            await cfTarget(org, space);
            logInfo(`[Session] Silent re-login successful — target ${org}/${space} selected.`);
          } catch (err: unknown) {
            logWarn(`[Session] Silent re-login failed: ${err instanceof Error ? err.message : String(err)}`);
            // Proactively clear stale keychain credentials so the user is redirected to
            // the setup screen before they attempt to start a debug session and hit the
            // same auth failure again.
            await this.provider.handleAuthFailure(err);
          }
        }
    }

















}
