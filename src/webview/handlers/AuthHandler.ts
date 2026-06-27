import type { CredentialStatus} from '../../types/index';
import { cfLogin, cfLogout, cfOrgs, isCfAuthError } from '../../core/cfClient';
import { refreshCfSyncRegionOrgs, resolveRegionKeyForEndpoint } from '../../core/cfSpaceRefresh';
import { getConfig, saveConfig } from '../../storage/configStore';
import { clearCredentialsFromSecretStorage, getCredentialSource, getCredentials, maskEmail, saveCredentialsToSecretStorage } from '../../core/shellEnv';
import { getCacheSettings } from '../../storage/cacheStore';
import { getCurrentSyncProgress, runCacheSync, syncSingleRegion } from '../../core/cacheSync';
import { getTopologySnapshotSync } from '../../core/cfTopology';
import { logError, logInfo, logWarn } from '../../core/logger';
import { getE2eCredentialStatusOverride } from '../../testing/e2eBridge';
import { type DebugLauncherViewProvider } from '../debugPanel';
import { buildLoginConfig, extractErrorMessage, normalizeEndpoint } from "../webviewUtils";

export class AuthHandler {
  constructor(public provider: DebugLauncherViewProvider) {}

    public async handleLogin(apiEndpoint: string, topologyOrgName?: string): Promise<void> {
        const { email, password } = await getCredentials();
        if (!email || !password) {
          const msg = 'No SAP credentials found. Please set your credentials in the extension setup screen.';
          logError(msg);
          this.provider.postMessage({ type: 'LOGIN_ERROR', payload: { message: msg } });
          return;
        }

        if (!apiEndpoint.startsWith('https://')) {
          const msg = 'API endpoint must start with https://';
          logError(msg);
          this.provider.postMessage({ type: 'LOGIN_ERROR', payload: { message: msg } });
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
            ? this.provider.loadTopologyShortcutLoginOrgs(apiEndpoint, topologyOrgName)
            : undefined;
          const loginOrgs = topologyShortcut ?? await this.provider.loadLoginOrgs(apiEndpoint, email, password);
          const orgs = loginOrgs.orgs;

          const existing = getConfig();
          await saveConfig(buildLoginConfig(apiEndpoint, orgs, existing));
          this.provider.postMessage({ type: 'LOGIN_SUCCESS', payload: { orgs, apiEndpoint } });
          this.provider.applyPendingExternalScopeIfAny(orgs);
          this.provider.startSingleRegionSyncAfterLogin(apiEndpoint, email, password, loginOrgs.topologyAlreadyAvailable);
        } catch (err: unknown) {
          const msg = extractErrorMessage(err);
          logError(`Login failed: ${msg}`);
          // Auth failure with keychain credentials → clear stale creds and redirect
          // to SETUP_CREDENTIALS (posting CREDENTIALS_REVOKED). Skip LOGIN_ERROR to
          // avoid a conflicting screen transition.
          const revoked = await this.provider.handleAuthFailure(err);
          if (!revoked) {
            this.provider.postMessage({ type: 'LOGIN_ERROR', payload: { message: msg } });
          }
        }
    }

    public loadTopologyShortcutLoginOrgs(apiEndpoint: string, orgName: string): { orgs: string[]; topologyAlreadyAvailable: boolean } | undefined {
        const topologyOrgs = this.provider.getTopologyOrgsForEndpoint(apiEndpoint);
        if (!topologyOrgs?.includes(orgName)) return undefined;
        logInfo(`[Topology] Continuing with synced org ${orgName}; skipped region org refresh for ${apiEndpoint}.`);
        return { orgs: topologyOrgs, topologyAlreadyAvailable: true };
    }

    public async loadLoginOrgs(apiEndpoint: string, email: string, password: string): Promise<{ orgs: string[]; topologyAlreadyAvailable: boolean }> {
        const topologyOrgs = this.provider.getTopologyOrgsForEndpoint(apiEndpoint);
        const topologyAlreadyAvailable = topologyOrgs !== undefined;
        const refreshed = await refreshCfSyncRegionOrgs({ apiEndpoint, email, password });
        if (refreshed.status === 'refreshed') {
          logInfo(`[cf-sync] Refreshed ${refreshed.orgNames.length.toString()} org(s) for ${refreshed.regionKey}.`);
          void this.provider.pushCfTopology();
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

    public getTopologyOrgsForEndpoint(apiEndpoint: string): string[] | undefined {
        const normalized = normalizeEndpoint(apiEndpoint);
        const orgs = getTopologySnapshotSync().accounts
                  .filter((account) => normalizeEndpoint(account.apiEndpoint) === normalized)
                  .map((account) => account.orgName);
        return orgs.length > 0 ? [...new Set(orgs)] : undefined;
    }

    public startSingleRegionSyncAfterLogin(apiEndpoint: string, email: string, password: string, topologyAlreadyAvailable: boolean): void {
        if (topologyAlreadyAvailable) return;
        if (process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC === '1') return;
        if (!getCacheSettings().enabled) return;
        const regionKey = resolveRegionKeyForEndpoint(apiEndpoint);
        if (regionKey === undefined) return;
        void syncSingleRegion(regionKey, email, password).catch((err: unknown) => {
          logWarn(`[Bootstrap] Single-region sync failed: ${extractErrorMessage(err)}`);
        });
    }

    public async handleSaveCredentials(email: string, password: string): Promise<void> {
        const trimmedEmail = email.trim();
        if (trimmedEmail.length === 0 || !trimmedEmail.includes('@')) {
          this.provider.postMessage({ type: 'CREDENTIALS_ERROR', payload: { message: 'Please enter a valid email address.' } });
          return;
        }

        if (!password) {
          this.provider.postMessage({ type: 'CREDENTIALS_ERROR', payload: { message: 'Password is required.' } });
          return;
        }

        try {
          await saveCredentialsToSecretStorage(trimmedEmail, password);
          logInfo(`[Credentials] Saved credentials for ${maskEmail(trimmedEmail)} to SecretStorage.`);
          this.provider.postMessage({
            type: 'CREDENTIALS_SAVED',
            payload: { email: trimmedEmail, source: 'keychain' },
          });
          this.provider.triggerCacheSync('[CacheSync] Triggered immediate sync after credentials saved.');
        } catch (err: unknown) {
          const msg = extractErrorMessage(err);
          logError(`[Credentials] Failed to save credentials: ${msg}`);
          this.provider.postMessage({ type: 'CREDENTIALS_ERROR', payload: { message: `Could not save credentials: ${msg}` } });
        }
    }

    public async handleClearCredentials(): Promise<void> {
        await clearCredentialsFromSecretStorage();
        const status = await this.provider.buildCredentialStatus();
        logInfo('[Credentials] Credentials cleared from SecretStorage.');
        this.provider.postMessage({ type: 'CREDENTIALS_STATUS', payload: status });
    }

    /** Builds a CredentialStatus snapshot for the current session. */
    public async buildCredentialStatus(): Promise<CredentialStatus> {
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
    public async handleAuthFailure(err: unknown): Promise<boolean> {
        if (!isCfAuthError(err)) return false;
        const source = await getCredentialSource();
        if (source !== 'keychain') return false;
        await clearCredentialsFromSecretStorage();
        logInfo('[Credentials] Auth failure with keychain credentials — cleared and prompting for new credentials.');
        this.provider.postMessage({
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
    public async reLogin(apiEndpoint: string): Promise<void> {
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

    public bootstrapCacheSyncForExistingCredentials(status: CredentialStatus): void {
        if (!status.hasCredentials) return;
        if (getCurrentSyncProgress().lastCompletedAt !== undefined) return;
        this.provider.triggerCacheSync('[CacheSync] Triggered initial sync for existing credentials.');
    }

    public triggerCacheSync(message: string): void {
        if (process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC === '1') return;
        runCacheSync();
        logInfo(message);
    }













}
