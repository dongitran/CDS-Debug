import * as vscode from 'vscode';
import type { AppWatchdogConfig, OrgGroupMapping, SaveSshProxySettingsPayload} from '../../types/index';
import { clampNumber, DEFAULT_PING_INTERVAL_SECONDS, getAppWatchdogConfig, PING_INTERVAL_BOUNDS } from '../../core/appWatchdog';
import { getConfig, saveConfig, upsertOrgMappings } from '../../storage/configStore';
import { getDebugPreferences } from '../../storage/cacheStore';
import { logInfo, logWarn } from '../../core/logger';
import { getActiveAppNames } from '../../core/processManager';
import { clearSshProxySettings, getSshProxyPublicSettings, saveSshProxySettings } from '../../storage/sshProxyStore';
import { ensureSshProxy, refreshSshProxyStatus, stopSshProxy } from '../../core/sshProxyTunnel';
import type { DebugLauncherViewProvider} from '../debugPanel';
import { toSafeHttpUri, SSH_PROXY_PAYLOAD_SCHEMA } from "../webviewUtils";

export class SettingsHandler {
  constructor(public provider: DebugLauncherViewProvider) {}

    public async handleSelectGroupFolder(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
                  canSelectFiles: false,
                  canSelectFolders: true,
                  canSelectMany: false,
                  title: 'Select local group folder for this org',
                });
        const selected = uris?.[0];
        if (!selected) return;
        logInfo(`Group folder selected: ${selected.fsPath}`);
        this.provider.postMessage({ type: 'GROUP_FOLDER_SELECTED', payload: { path: selected.fsPath } });
    }

    public async handleSaveMappings(mappings: OrgGroupMapping[]): Promise<void> {
        const existing = getConfig();
        if (!existing) return;
        logInfo(`Saving ${mappings.length.toString()} org mapping(s).`);
        await saveConfig({
          ...existing,
          orgGroupMappings: upsertOrgMappings(existing.orgGroupMappings, mappings),
        });
    }

    public async handleSaveAppWatchdogConfig(payload: AppWatchdogConfig): Promise<void> {
        const config = vscode.workspace.getConfiguration('cdsDebug');
        const enabled = payload.enabled;
        const pingIntervalSeconds = clampNumber(
                  payload.pingIntervalSeconds,
                  PING_INTERVAL_BOUNDS.min,
                  PING_INTERVAL_BOUNDS.max,
                  DEFAULT_PING_INTERVAL_SECONDS,
                );
        await config.update('appWatchdog.enabled', enabled, vscode.ConfigurationTarget.Global);
        await config.update('appWatchdog.pingIntervalSeconds', pingIntervalSeconds, vscode.ConfigurationTarget.Global);
        this.provider.postAppWatchdogConfig();
    }

    public postAppWatchdogConfig(): void {
        const config = getAppWatchdogConfig();
        this.provider.postMessage({
          type: 'APP_WATCHDOG_CONFIG',
          payload: { enabled: config.enabled, pingIntervalSeconds: config.pingIntervalSeconds },
        });
    }

    public handleOpenAppUrl(rawUrl: string, source: 'manual' | 'auto'): void {
        if (source === 'auto' && !getDebugPreferences().openBrowserOnAttach) {
          logInfo('Auto-open blocked: openBrowserOnAttach is disabled in preferences.');
          return;
        }

        const safeUri = toSafeHttpUri(rawUrl);
        if (!safeUri) {
          const msg = 'Blocked unsafe or malformed app URL.';
          logWarn(msg);
          this.provider.postMessage({ type: 'DEBUG_ERROR', payload: { message: msg } });
          return;
        }

        void vscode.env.openExternal(safeUri);
    }

    public async handleSaveSshProxySettings(payload: SaveSshProxySettingsPayload): Promise<void> {
        if (this.provider.postActiveSessionProxyError()) return;
        const parsed = SSH_PROXY_PAYLOAD_SCHEMA.safeParse(payload);
        if (!parsed.success) {
          await this.provider.postSshProxyError(parsed.error.issues[0]?.message ?? 'Invalid SSH proxy settings.');
          return;
        }

        const existing = await getSshProxyPublicSettings();
        if (parsed.data.enabled && !parsed.data.password && !existing.hasPassword) {
          await this.provider.postSshProxyError('Password is required the first time the SSH proxy is enabled.');
          return;
        }

        const settings: SaveSshProxySettingsPayload = parsed.data.password === undefined
                  ? {
                    enabled: parsed.data.enabled,
                    host: parsed.data.host,
                    port: parsed.data.port,
                    username: parsed.data.username,
                  }
                  : { ...parsed.data, password: parsed.data.password };
        await saveSshProxySettings(settings);
        await stopSshProxy();
        if (parsed.data.enabled) {
          try {
            await ensureSshProxy();
          } catch {
            // The tunnel manager already emitted a sanitized error status.
          }
        }

        this.provider.postMessage({ type: 'SSH_PROXY_STATUS', payload: await refreshSshProxyStatus() });
    }

    public async handleClearSshProxySettings(): Promise<void> {
        if (this.provider.postActiveSessionProxyError()) return;
        await stopSshProxy();
        await clearSshProxySettings();
        this.provider.postMessage({ type: 'SSH_PROXY_STATUS', payload: await refreshSshProxyStatus() });
    }

    public postActiveSessionProxyError(): boolean {
        if (getActiveAppNames().length === 0) return false;
        void this.provider.postSshProxyError('Stop all active debug sessions before changing SSH proxy settings.');
        return true;
    }

    public async postSshProxyError(message: string): Promise<void> {
        const settings = await getSshProxyPublicSettings();
        this.provider.postMessage({
          type: 'SSH_PROXY_STATUS',
          payload: { ...settings, connection: 'error', message },
        });
    }










}
