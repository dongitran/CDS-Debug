import * as vscode from 'vscode';
import type { SharedCfScope} from '../../types/index';
import { cfLogin, cfLogout, cfOrgs } from '../../core/cfClient';
import { getConfig, mappingMatchesTarget, saveConfig } from '../../storage/configStore';
import { getCredentials } from '../../core/shellEnv';
import { buildCfApiEndpoint, regionCodeFromApiEndpoint, writeScopeIfChanged } from '../../storage/scopeSync';
import { getTopologySnapshot } from '../../core/cfTopology';
import { logError, logInfo, logWarn } from '../../core/logger';
import { stopAllProcesses, getActiveAppNames } from '../../core/processManager';
import { clearBreakpointSnapshots } from '../../core/breakpointSnapshotManager';
import { type DebugLauncherViewProvider } from '../debugPanel';
import { buildLoginConfig, extractErrorMessage } from "../webviewUtils";

export class ScopeSyncHandler {
  constructor(public provider: DebugLauncherViewProvider) {}

    public handleExternalScopeChange(scope: SharedCfScope): void {
        if (this.provider.isLastWrittenScope(scope)) {
          return;
        }

        this.provider.scopeChangeQueue = this.provider.scopeChangeQueue
        .catch(() => undefined)
        .then(async () => {
        if (this.provider.isLastWrittenScope(scope)) return;
        await this.provider.handleScopeChangeInternal(scope);
        })
        .catch((err: unknown) => {
        logWarn(`[ScopeSync] Scope change handling failed: ${extractErrorMessage(err)}`);
        });
    }

    public isLastWrittenScope(scope: SharedCfScope): boolean {
        return this.provider.lastWrittenScope?.regionCode === scope.regionCode
        && this.provider.lastWrittenScope.orgName === scope.orgName
        && this.provider.lastWrittenScope.spaceName === scope.spaceName;
    }

    public async handleScopeChangeInternal(scope: SharedCfScope): Promise<void> {
        await this.provider.stopActiveSessionsForScopeChange();
        const config = getConfig();
        const activeRegionCode = config ? regionCodeFromApiEndpoint(config.apiEndpoint) : undefined;
        if (config && activeRegionCode === scope.regionCode) {
          this.provider.postScopeSyncForMapping(scope);
          return;
        }

        await this.provider.handleExternalRegionChange(scope);
    }

    public async stopActiveSessionsForScopeChange(): Promise<void> {
        const activeApps = getActiveAppNames();
        if (activeApps.length === 0) return;
        const appList = activeApps.join(', ');
        logInfo(
          `[ScopeSync] Stopping ${activeApps.length.toString()} active debug session(s) due to external scope change: ${appList}`,
        );
        await stopAllProcesses();
        clearBreakpointSnapshots();
        this.provider.postMessage({ type: 'BREAKPOINT_SNAPSHOTS', payload: { snapshots: [] } });
        void vscode.window.showInformationMessage(
          `CDS Debug: stopped debug session(s) for ${appList} due to CF scope change.`,
        );
    }

    public async handleExternalRegionChange(scope: SharedCfScope): Promise<void> {
        const newApiEndpoint = buildCfApiEndpoint(scope.regionCode);
        const { email, password } = await getCredentials();
        if (!email || !password) {
          this.provider.pendingExternalScope = scope;
          this.provider.postMessage({
            type: 'REGION_PREFILL',
            payload: { regionCode: scope.regionCode, apiEndpoint: newApiEndpoint },
          });
          logWarn('[ScopeSync] No stored credentials — pre-filled region endpoint for manual login.');
          return;
        }

        this.provider.pendingExternalScope = undefined;
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
          this.provider.postMessage({ type: 'LOGIN_SUCCESS', payload: { orgs, apiEndpoint: newApiEndpoint } });

          if (!orgs.includes(scope.orgName)) return;
          this.provider.postScopeSyncForMapping(scope);
        } catch (err: unknown) {
          const msg = extractErrorMessage(err);
          logError(`[ScopeSync] Cross-region auto-login failed: ${msg}`);
          const revoked = await this.provider.handleAuthFailure(err);
          if (!revoked) {
            this.provider.postMessage({ type: 'LOGIN_ERROR', payload: { message: msg } });
          }
        }
    }

    public applyPendingExternalScopeIfAny(orgs: string[]): void {
        const scope = this.provider.pendingExternalScope;
        if (!scope) return;
        this.provider.pendingExternalScope = undefined;
        if (!orgs.includes(scope.orgName)) return;
        this.provider.postScopeSyncForMapping(scope);
    }

    public postScopeSyncForMapping(scope: SharedCfScope): void {
        const config = getConfig();
        const hasMapping = config?.orgGroupMappings.some((mapping) => (
                  mappingMatchesTarget(mapping, scope.orgName, scope.spaceName)
                )) ?? false;
        this.provider.postMessage({
          type: hasMapping ? 'SCOPE_SYNCED' : 'SCOPE_SYNCED_NO_MAPPING',
          payload: { orgName: scope.orgName, spaceName: scope.spaceName },
        });
    }

    public async pushCfTopology(): Promise<void> {
        try {
          const topology = await getTopologySnapshot();
          this.provider.postMessage({ type: 'CF_TOPOLOGY', payload: topology });
        } catch (err: unknown) {
          logWarn(`[CfTopology] Failed to read cf-sync topology: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    public async writeScopeAfterAppsLoaded(org: string, space: string): Promise<void> {
        const config = getConfig();
        if (!config) return;
        const regionCode = regionCodeFromApiEndpoint(config.apiEndpoint);
        if (!regionCode) return;
        const scope: SharedCfScope = { regionCode, orgName: org, spaceName: space };
        const previousScope = this.provider.lastWrittenScope;
        this.provider.lastWrittenScope = scope;
        try {
          await writeScopeIfChanged(scope);
        } catch (err: unknown) {
          this.provider.lastWrittenScope = previousScope;
          logWarn(`[ScopeSync] Failed to write shared CF scope: ${extractErrorMessage(err)}`);
        }
    }










}
