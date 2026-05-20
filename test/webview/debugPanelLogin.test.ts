import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CfClientModule from '../../src/core/cfClient';
import type * as BreakpointSnapshotManagerModule from '../../src/core/breakpointSnapshotManager';
import type * as ProcessManagerModule from '../../src/core/processManager';
import type * as ScopeSyncModule from '../../src/storage/scopeSync';
import type * as ShellEnvModule from '../../src/core/shellEnv';
import type { CfApp, CfTopology, ExtensionConfig, SharedCfScope } from '../../src/types/index';
import type {
  CfSyncRegionOrgRefreshResult,
  CfSyncSpaceRefreshResult,
} from '../../src/core/cfSpaceRefresh';

const cfClientMock = vi.hoisted(() => ({
  cfLogin: vi.fn<(apiEndpoint: string, email: string, password: string) => Promise<void>>(
    () => Promise.resolve(),
  ),
  cfLogout: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  cfOrgs: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  cfTarget: vi.fn<(org: string, space?: string) => Promise<void>>(() => Promise.resolve()),
  cfTargetAndApps: vi.fn<(org: string, space?: string) => Promise<CfApp[]>>(() => Promise.resolve([])),
}));

const cacheSyncMock = vi.hoisted(() => {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const cacheSyncEvents = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return cacheSyncEvents;
    }),
    emit: vi.fn((event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
      return true;
    }),
  };
  return {
    cacheSyncEvents,
  getCurrentSyncProgress: vi.fn(() => ({ isRunning: false, done: 0, total: 0 })),
  requestCacheSyncStop: vi.fn<() => void>(),
  restartCacheSyncTimer: vi.fn<() => void>(),
  runCacheSync: vi.fn<() => void>(),
  syncSingleRegion: vi.fn<() => Promise<{ status: 'synced' | 'failed' | 'skipped'; error?: string }>>(
      () => Promise.resolve({ status: 'synced' }),
    ),
  };
});

const cfTopologyMock = vi.hoisted(() => ({
  getAppsFromTopologySync: vi.fn<() => CfApp[] | undefined>(() => undefined),
  getTopologySnapshot: vi.fn<() => Promise<CfTopology>>(
    () => Promise.resolve({ ready: false, accounts: [] }),
  ),
  getTopologySnapshotSync: vi.fn<() => CfTopology>(() => ({ ready: false, accounts: [] })),
}));

const cfSpaceRefreshMock = vi.hoisted(() => ({
  refreshCfSyncRegionOrgs: vi.fn<
    (input: { apiEndpoint: string; email?: string; password?: string }) => Promise<CfSyncRegionOrgRefreshResult>
  >(() => Promise.resolve({ status: 'skipped', reason: 'unknown-region' })),
  refreshCfSyncSpace: vi.fn<
    (
      input: {
        apiEndpoint: string;
        orgName: string;
        spaceName?: string;
        email?: string;
        password?: string;
      },
    ) => Promise<CfSyncSpaceRefreshResult>
  >(() => Promise.resolve({ status: 'skipped', reason: 'unknown-region' })),
  resolveRegionKeyForEndpoint: vi.fn((apiEndpoint: string) => {
    if (apiEndpoint.includes('eu10')) return 'eu10';
    if (apiEndpoint.includes('us10')) return 'us10';
    return undefined;
  }),
}));

const loggerMock = vi.hoisted(() => ({
  logError: vi.fn<(message: string) => void>(),
  logInfo: vi.fn<(message: string) => void>(),
  logWarn: vi.fn<(message: string) => void>(),
  showLogChannel: vi.fn<() => void>(),
}));

const scopeSyncMock = vi.hoisted(() => ({
  writeScopeIfChanged: vi.fn<(
    scope: { regionCode: string; orgName: string; spaceName: string },
  ) => Promise<void>>(() => Promise.resolve()),
}));

const processManagerMock = vi.hoisted(() => ({
  getActiveAppNames: vi.fn<() => string[]>(() => []),
  stopAllProcesses: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

const breakpointSnapshotManagerMock = vi.hoisted(() => ({
  clearBreakpointSnapshots: vi.fn<() => void>(),
}));

const shellEnvMock = vi.hoisted(() => ({
  clearCredentialsFromSecretStorage: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  getCredentialSource: vi.fn<() => Promise<'env' | 'keychain' | 'none'>>(() => Promise.resolve('none')),
  getCredentials: vi.fn<() => Promise<{ email: string; password: string }>>(
    () => Promise.resolve({ email: '', password: '' }),
  ),
  maskEmail: vi.fn<(email: string) => string>((email) => email),
  saveCredentialsToSecretStorage: vi.fn<(email: string, password: string) => Promise<void>>(
    () => Promise.resolve(),
  ),
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: vi.fn(() => ({
      inspect: vi.fn(() => undefined),
      get: vi.fn((_key: string, fallback: unknown) => fallback),
    })),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showInformationMessage: vi.fn<(
      message: string,
    ) => Promise<string | undefined>>(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(),
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, path: string) => ({ fsPath: `${base.fsPath}/${path}` }),
    parse: (value: string) => ({ toString: () => value }),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  env: {
    openExternal: vi.fn(),
  },
}));

vi.mock('../../src/core/cfClient', async (importOriginal) => {
  const actual = await importOriginal<typeof CfClientModule>();
  return {
    ...actual,
    cfLogin: cfClientMock.cfLogin,
    cfLogout: cfClientMock.cfLogout,
    cfOrgs: cfClientMock.cfOrgs,
    cfTarget: cfClientMock.cfTarget,
    cfTargetAndApps: cfClientMock.cfTargetAndApps,
  };
});

vi.mock('../../src/core/cacheSync', () => cacheSyncMock);

vi.mock('../../src/core/cfTopology', () => cfTopologyMock);

vi.mock('../../src/core/cfSpaceRefresh', () => cfSpaceRefreshMock);

vi.mock('../../src/core/processManager', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessManagerModule>();
  return {
    ...actual,
    getActiveAppNames: processManagerMock.getActiveAppNames,
    stopAllProcesses: processManagerMock.stopAllProcesses,
  };
});

vi.mock('../../src/core/breakpointSnapshotManager', async (importOriginal) => {
  const actual = await importOriginal<typeof BreakpointSnapshotManagerModule>();
  return {
    ...actual,
    clearBreakpointSnapshots: breakpointSnapshotManagerMock.clearBreakpointSnapshots,
  };
});

vi.mock('../../src/core/logger', () => loggerMock);

vi.mock('../../src/core/shellEnv', async (importOriginal) => {
  const actual = await importOriginal<typeof ShellEnvModule>();
  return {
    ...actual,
    clearCredentialsFromSecretStorage: shellEnvMock.clearCredentialsFromSecretStorage,
    getCredentialSource: shellEnvMock.getCredentialSource,
    getCredentials: shellEnvMock.getCredentials,
    maskEmail: shellEnvMock.maskEmail,
    saveCredentialsToSecretStorage: shellEnvMock.saveCredentialsToSecretStorage,
  };
});

vi.mock('../../src/storage/scopeSync', async (importOriginal) => {
  const actual = await importOriginal<typeof ScopeSyncModule>();
  return {
    ...actual,
    writeScopeIfChanged: scopeSyncMock.writeScopeIfChanged,
  };
});

import { buildLoginConfig } from '../../src/webview/debugPanel';
import { DebugLauncherViewProvider } from '../../src/webview/debugPanel';
import { getCacheSettings, initCacheStore, saveCacheSettings } from '../../src/storage/cacheStore';
import { getConfig, initConfigStore, saveConfig } from '../../src/storage/configStore';
import * as vscode from 'vscode';

type ShowInformationMessageMock = ReturnType<
  typeof vi.fn<(message: string) => Promise<string | undefined>>
>;

interface DebugPanelInternals {
  lastWrittenScope: SharedCfScope | undefined;
  pendingExternalScope: SharedCfScope | undefined;
  scopeChangeQueue: Promise<void>;
  applyPendingExternalScopeIfAny(orgs: string[]): void;
  handleSaveCredentials(email: string, password: string): Promise<void>;
  handleMessage(raw: unknown): Promise<void>;
  handleLogin(apiEndpoint: string): Promise<void>;
  handleWarmupCfSession(org: string, space: string): Promise<void>;
  handleScopeChangeInternal(scope: SharedCfScope): Promise<void>;
  handleExternalRegionChange(scope: SharedCfScope): Promise<void>;
  stopActiveSessionsForScopeChange(): Promise<void>;
  writeScopeAfterAppsLoaded(org: string, space: string): Promise<void>;
  keepCfSessionAlive(apiEndpoint: string, org: string, space: string): Promise<void>;
  keepCfSessionAliveTracked(apiEndpoint: string, org: string, space: string): Promise<void>;
  awaitWarmupIfRunning(apiEndpoint: string, org: string, space: string): Promise<void>;
}

function makeContext() {
  const store = new Map<string, unknown>();
  return {
    extensionUri: { fsPath: '/sample/extension' },
    subscriptions: [],
    globalState: {
      get: (key: string): unknown => store.get(key),
      update: (key: string, value: unknown): Promise<void> => {
        if (value === undefined) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
        return Promise.resolve();
      },
    },
  };
}

function makeProvider(): DebugLauncherViewProvider {
  return new DebugLauncherViewProvider(
    makeContext() as unknown as ConstructorParameters<typeof DebugLauncherViewProvider>[0],
  );
}

function getInternals(provider: DebugLauncherViewProvider): DebugPanelInternals {
  return provider as unknown as DebugPanelInternals;
}

function getShowInformationMessageMock(): ShowInformationMessageMock {
  return vscode.window.showInformationMessage as unknown as ShowInformationMessageMock;
}

async function saveSessionConfig(overrides?: Partial<ExtensionConfig>): Promise<void> {
  await saveConfig({
    apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
    orgs: ['sample-org-alpha', 'sample-org-beta'],
    orgGroupMappings: [],
    ...overrides,
  });
}

describe('DebugLauncherViewProvider login config', () => {
  it('preserves org mappings from other regions when saving a new login region', () => {
    const existing: ExtensionConfig = {
      apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      orgs: ['sample-org-eu'],
      orgGroupMappings: [
        {
          cfOrg: 'sample-org-eu',
          cfSpace: 'app',
          groupFolderPath: '/sample/eu',
          lastUsedAt: 100,
        },
        {
          cfOrg: 'sample-org-ap',
          cfSpace: 'app',
          groupFolderPath: '/sample/ap',
          lastUsedAt: 200,
        },
      ],
    };

    expect(buildLoginConfig(
      'https://api.cf.us10.hana.ondemand.com',
      ['sample-org-us'],
      existing,
    )).toEqual({
      apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
      orgs: ['sample-org-us'],
      orgGroupMappings: existing.orgGroupMappings,
    });
  });

  it('uses an empty mapping list on first login', () => {
    expect(buildLoginConfig(
      'https://api.cf.eu10.hana.ondemand.com',
      ['sample-org-eu'],
      undefined,
    )).toEqual({
      apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      orgs: ['sample-org-eu'],
      orgGroupMappings: [],
    });
  });
});

describe('DebugLauncherViewProvider external scope sync', () => {
  beforeEach(async () => {
    initConfigStore(makeContext() as unknown as Parameters<typeof initConfigStore>[0]);
    initCacheStore(makeContext() as unknown as Parameters<typeof initCacheStore>[0]);
    await saveCacheSettings({ enabled: true, intervalHours: 24 });
    cfClientMock.cfLogin.mockReset();
    cfClientMock.cfLogin.mockResolvedValue(undefined);
    cfClientMock.cfLogout.mockReset();
    cfClientMock.cfLogout.mockResolvedValue(undefined);
    cfClientMock.cfOrgs.mockReset();
    cfClientMock.cfOrgs.mockResolvedValue([]);
    cfClientMock.cfTarget.mockReset();
    cfClientMock.cfTarget.mockResolvedValue(undefined);
    cfClientMock.cfTargetAndApps.mockReset();
    cfClientMock.cfTargetAndApps.mockResolvedValue([]);
    cacheSyncMock.getCurrentSyncProgress.mockClear();
    cacheSyncMock.restartCacheSyncTimer.mockClear();
    cacheSyncMock.runCacheSync.mockClear();
    cacheSyncMock.syncSingleRegion.mockReset();
    cacheSyncMock.syncSingleRegion.mockResolvedValue({ status: 'synced' });
    cfTopologyMock.getAppsFromTopologySync.mockReset();
    cfTopologyMock.getAppsFromTopologySync.mockReturnValue(undefined);
    cfTopologyMock.getTopologySnapshot.mockClear();
    cfTopologyMock.getTopologySnapshot.mockResolvedValue({ ready: false, accounts: [] });
    cfTopologyMock.getTopologySnapshotSync.mockClear();
    cfTopologyMock.getTopologySnapshotSync.mockReturnValue({ ready: false, accounts: [] });
    cfSpaceRefreshMock.refreshCfSyncRegionOrgs.mockReset();
    cfSpaceRefreshMock.refreshCfSyncRegionOrgs.mockResolvedValue({
      status: 'skipped',
      reason: 'unknown-region',
    });
    cfSpaceRefreshMock.refreshCfSyncSpace.mockReset();
    cfSpaceRefreshMock.refreshCfSyncSpace.mockResolvedValue({
      status: 'skipped',
      reason: 'unknown-region',
    });
    cfSpaceRefreshMock.resolveRegionKeyForEndpoint.mockReset();
    cfSpaceRefreshMock.resolveRegionKeyForEndpoint.mockImplementation((apiEndpoint: string) => {
      if (apiEndpoint.includes('eu10')) return 'eu10';
      if (apiEndpoint.includes('us10')) return 'us10';
      return undefined;
    });
    loggerMock.logError.mockClear();
    loggerMock.logInfo.mockClear();
    loggerMock.logWarn.mockClear();
    loggerMock.showLogChannel.mockClear();
    processManagerMock.getActiveAppNames.mockReset();
    processManagerMock.getActiveAppNames.mockReturnValue([]);
    processManagerMock.stopAllProcesses.mockReset();
    processManagerMock.stopAllProcesses.mockResolvedValue(undefined);
    breakpointSnapshotManagerMock.clearBreakpointSnapshots.mockReset();
    scopeSyncMock.writeScopeIfChanged.mockReset();
    scopeSyncMock.writeScopeIfChanged.mockResolvedValue(undefined);
    shellEnvMock.clearCredentialsFromSecretStorage.mockReset();
    shellEnvMock.clearCredentialsFromSecretStorage.mockResolvedValue(undefined);
    shellEnvMock.getCredentialSource.mockReset();
    shellEnvMock.getCredentialSource.mockResolvedValue('none');
    shellEnvMock.getCredentials.mockReset();
    shellEnvMock.getCredentials.mockResolvedValue({ email: '', password: '' });
    shellEnvMock.maskEmail.mockReset();
    shellEnvMock.maskEmail.mockImplementation((email) => email);
    shellEnvMock.saveCredentialsToSecretStorage.mockReset();
    shellEnvMock.saveCredentialsToSecretStorage.mockResolvedValue(undefined);
    getShowInformationMessageMock().mockClear();
  });

  it('ignores a scope matching the last scope written by this provider', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    const handleScopeChangeInternal = vi.spyOn(getInternals(provider), 'handleScopeChangeInternal');
    const scope: SharedCfScope = {
      regionCode: 'eu10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    };
    getInternals(provider).lastWrittenScope = scope;
    processManagerMock.getActiveAppNames.mockReturnValue(['sample-service-a']);
    await saveSessionConfig();

    provider.handleExternalScopeChange(scope);

    expect(handleScopeChangeInternal).not.toHaveBeenCalled();
    expect(processManagerMock.stopAllProcesses).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('serializes rapid external scope changes before cross-region login', async () => {
    const provider = makeProvider();
    vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    let resolveFirstLogin: (() => void) | undefined;
    cfClientMock.cfLogin
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstLogin = resolve;
      }))
      .mockResolvedValue(undefined);
    cfClientMock.cfOrgs
      .mockResolvedValueOnce(['sample-org-us'])
      .mockResolvedValueOnce(['sample-org-eu']);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    await saveSessionConfig({
      orgs: ['sample-org-eu'],
    });

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-us',
      spaceName: 'app',
    });
    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-eu',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(cfClientMock.cfLogin).toHaveBeenCalledTimes(1);
    });
    expect(cfClientMock.cfLogin).toHaveBeenLastCalledWith(
      'https://api.cf.us10.hana.ondemand.com',
      'sample.user@example.com',
      'sample-password',
    );

    if (!resolveFirstLogin) throw new Error('First login was not started.');
    resolveFirstLogin();

    await vi.waitFor(() => {
      expect(cfClientMock.cfLogin).toHaveBeenCalledTimes(2);
    });
    expect(cfClientMock.cfLogin).toHaveBeenLastCalledWith(
      'https://api.cf.eu10.hana.ondemand.com',
      'sample.user@example.com',
      'sample-password',
    );
  });

  it('continues processing queued external scopes after a handler throws', async () => {
    const provider = makeProvider();
    vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    const handleScopeChangeInternal = vi
      .spyOn(getInternals(provider), 'handleScopeChangeInternal')
      .mockRejectedValueOnce(new Error('mock scope failure'))
      .mockResolvedValue(undefined);

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-us',
      spaceName: 'app',
    });
    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-eu',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(handleScopeChangeInternal).toHaveBeenCalledTimes(2);
    });
    expect(loggerMock.logWarn).toHaveBeenCalledWith(
      '[ScopeSync] Scope change handling failed: mock scope failure',
    );
  });

  it('auto-logins for an external scope when no session config exists', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-alpha']);

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'LOGIN_SUCCESS',
        payload: {
          orgs: ['sample-org-alpha'],
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
        },
      });
    });
    expect(cfClientMock.cfLogin).toHaveBeenCalledWith(
      'https://api.cf.eu10.hana.ondemand.com',
      'sample.user@example.com',
      'sample-password',
    );
    expect(getConfig()).toMatchObject({
      apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      orgs: ['sample-org-alpha'],
    });
  });

  it('uses cf-sync region org refresh instead of stale topology orgs during login', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfTopologyMock.getTopologySnapshotSync.mockReturnValue({
      ready: true,
      accounts: [{
        regionKey: 'eu10',
        regionLabel: 'Europe (Frankfurt)',
        apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
        orgName: 'sample-org-stale',
        spaces: [{ name: 'app', apps: [] }],
      }],
    });
    cfSpaceRefreshMock.refreshCfSyncRegionOrgs.mockResolvedValue({
      status: 'refreshed',
      regionKey: 'eu10',
      orgNames: ['sample-org-fresh'],
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-live']);

    await getInternals(provider).handleLogin('https://api.cf.eu10.hana.ondemand.com');

    expect(cfSpaceRefreshMock.refreshCfSyncRegionOrgs).toHaveBeenCalledWith({
      apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    expect(cfClientMock.cfOrgs).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'LOGIN_SUCCESS',
      payload: {
        orgs: ['sample-org-fresh'],
        apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      },
    });
  });

  it('falls back to live cf orgs when cf-sync cannot refresh the selected endpoint', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfSpaceRefreshMock.refreshCfSyncRegionOrgs.mockResolvedValue({
      status: 'skipped',
      reason: 'unknown-region',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-live']);

    await getInternals(provider).handleLogin('https://api.cf.custom.example.com');

    expect(cfClientMock.cfOrgs).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'LOGIN_SUCCESS',
      payload: {
        orgs: ['sample-org-live'],
        apiEndpoint: 'https://api.cf.custom.example.com',
      },
    });
  });

  it('falls back to live cf orgs when cf-sync region org refresh fails', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfSpaceRefreshMock.refreshCfSyncRegionOrgs.mockResolvedValue({
      status: 'failed',
      regionKey: 'eu10',
      error: new Error('org refresh failed'),
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-live']);

    await getInternals(provider).handleLogin('https://api.cf.eu10.hana.ondemand.com');

    expect(cfClientMock.cfOrgs).toHaveBeenCalledTimes(1);
    expect(loggerMock.logWarn).toHaveBeenCalledWith(
      '[cf-sync] Region org refresh failed for eu10: org refresh failed. Falling back to live cf orgs.',
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: 'LOGIN_SUCCESS',
      payload: {
        orgs: ['sample-org-live'],
        apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      },
    });
  });

  it('delegates a cross-region external scope without posting SCOPE_SYNCED synchronously', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    const handleExternalRegionChange = vi
      .spyOn(getInternals(provider), 'handleExternalRegionChange')
      .mockResolvedValue(undefined);
    await saveSessionConfig();
    const scope: SharedCfScope = {
      regionCode: 'us10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    };

    provider.handleExternalScopeChange(scope);

    await vi.waitFor(() => {
      expect(handleExternalRegionChange).toHaveBeenCalledWith(scope);
    });
    expect(postMessage).not.toHaveBeenCalledWith({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-alpha', spaceName: 'app' },
    });
  });

  it('prefills region and stores a pending external scope when cross-region credentials are missing', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    const scope: SharedCfScope = {
      regionCode: 'us10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    };
    await saveSessionConfig();

    provider.handleExternalScopeChange(scope);

    await vi.waitFor(() => {
      expect(shellEnvMock.getCredentials).toHaveBeenCalled();
    });
    expect(cfClientMock.cfLogin).not.toHaveBeenCalled();
    expect(getInternals(provider).pendingExternalScope).toEqual(scope);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'REGION_PREFILL',
      payload: {
        regionCode: 'us10',
        apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
      },
    });
  });

  it('posts LOGIN_SUCCESS and SCOPE_SYNCED after a cross-region login when the target org has a mapping', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-beta', 'sample-org-gamma']);
    await saveSessionConfig({
      orgGroupMappings: [{
        cfOrg: 'sample-org-beta',
        cfSpace: 'dev',
        groupFolderPath: '/sample/beta-dev',
      }],
    });

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledTimes(2);
    });
    expect(cfClientMock.cfLogout).toHaveBeenCalledTimes(1);
    expect(cfClientMock.cfLogin).toHaveBeenCalledWith(
      'https://api.cf.us10.hana.ondemand.com',
      'sample.user@example.com',
      'sample-password',
    );
    expect(postMessage.mock.calls.map((call) => call[0])).toEqual([
      {
        type: 'LOGIN_SUCCESS',
        payload: {
          orgs: ['sample-org-beta', 'sample-org-gamma'],
          apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
        },
      },
      {
        type: 'SCOPE_SYNCED',
        payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
      },
    ]);
  });

  it('posts LOGIN_SUCCESS and SCOPE_SYNCED_NO_MAPPING after a cross-region login when the target org has no mapping', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-beta', 'sample-org-gamma']);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledTimes(2);
    });
    expect(postMessage.mock.calls.map((call) => call[0])).toEqual([
      {
        type: 'LOGIN_SUCCESS',
        payload: {
          orgs: ['sample-org-beta', 'sample-org-gamma'],
          apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
        },
      },
      {
        type: 'SCOPE_SYNCED_NO_MAPPING',
        payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
      },
    ]);
  });

  it('posts only LOGIN_SUCCESS after a cross-region login when the target org is absent', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-gamma']);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'LOGIN_SUCCESS',
        payload: {
          orgs: ['sample-org-gamma'],
          apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
        },
      });
    });
    expect(postMessage).not.toHaveBeenCalledWith({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-beta', spaceName: 'app' },
    });
    expect(postMessage).not.toHaveBeenCalledWith({
      type: 'SCOPE_SYNCED_NO_MAPPING',
      payload: { orgName: 'sample-org-beta', spaceName: 'app' },
    });
  });

  it('posts LOGIN_ERROR and logs an error when cross-region login fails', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfLogin.mockRejectedValue(new Error('mock login failed'));
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'LOGIN_ERROR',
        payload: { message: 'mock login failed' },
      });
    });
    expect(loggerMock.logError).toHaveBeenCalledWith(
      '[ScopeSync] Cross-region auto-login failed: mock login failed',
    );
    expect(loggerMock.logWarn).not.toHaveBeenCalledWith(
      '[ScopeSync] Scope change handling failed: mock login failed',
    );
  });

  it('posts LOGIN_ERROR after stopping active sessions when cross-region login fails', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    processManagerMock.getActiveAppNames.mockReturnValue(['sample-service-a']);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfLogin.mockRejectedValue(new Error('mock login failed'));
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'LOGIN_ERROR',
        payload: { message: 'mock login failed' },
      });
    });
    expect(processManagerMock.stopAllProcesses).toHaveBeenCalledTimes(1);
    expect(processManagerMock.stopAllProcesses.mock.invocationCallOrder[0])
      .toBeLessThan(cfClientMock.cfLogin.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    expect(postMessage).not.toHaveBeenCalledWith({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-beta', spaceName: 'app' },
    });
    expect(postMessage).not.toHaveBeenCalledWith({
      type: 'SCOPE_SYNCED_NO_MAPPING',
      payload: { orgName: 'sample-org-beta', spaceName: 'app' },
    });
  });

  it('revokes keychain credentials instead of posting LOGIN_ERROR when cross-region auth fails', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    shellEnvMock.getCredentialSource.mockResolvedValue('keychain');
    cfClientMock.cfLogin.mockRejectedValue(new Error('authentication failed for sample user'));
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'CREDENTIALS_REVOKED',
        payload: { message: 'Credentials rejected by Cloud Foundry. Please enter your updated credentials.' },
      });
    });
    expect(shellEnvMock.clearCredentialsFromSecretStorage).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalledWith({
      type: 'LOGIN_ERROR',
      payload: { message: 'authentication failed for sample user' },
    });
  });

  it('posts LOGIN_ERROR when cross-region org loading fails after login', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockRejectedValue(new Error('mock org load failed'));
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'LOGIN_ERROR',
        payload: { message: 'mock org load failed' },
      });
    });
    expect(cfClientMock.cfLogin).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalledWith({
      type: 'LOGIN_SUCCESS',
      payload: {
        orgs: expect.any(Array) as string[],
        apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
      },
    });
  });

  it('clears a stale pending external scope when a newer scope change has credentials', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    const pendingScope: SharedCfScope = {
      regionCode: 'us10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    };

    provider.handleExternalScopeChange(pendingScope);

    await vi.waitFor(() => {
      expect(getInternals(provider).pendingExternalScope).toEqual(pendingScope);
    });
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-beta']);

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'LOGIN_SUCCESS',
        payload: {
          orgs: ['sample-org-beta'],
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
        },
      });
    });
    expect(getInternals(provider).pendingExternalScope).toBeUndefined();
  });

  it('does not apply a stale pending external scope on later manual login after credential-backed scope change', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(getInternals(provider).pendingExternalScope?.orgName).toBe('sample-org-alpha');
    });
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-alpha', 'sample-org-beta']);

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(getInternals(provider).pendingExternalScope).toBeUndefined();
    });
    postMessage.mockClear();

    await getInternals(provider).handleLogin('https://api.cf.eu10.hana.ondemand.com');

    expect(postMessage.mock.calls.map((call) => call[0])).toEqual([{
      type: 'LOGIN_SUCCESS',
      payload: {
        orgs: ['sample-org-alpha', 'sample-org-beta'],
        apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      },
    }]);
  });

  it('does not stop sessions or clear snapshots when an external scope arrives with no active sessions', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveSessionConfig({
      orgGroupMappings: [{
        cfOrg: 'sample-org-beta',
        cfSpace: 'dev',
        groupFolderPath: '/sample/beta-dev',
      }],
    });

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'SCOPE_SYNCED',
        payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
      });
    });
    expect(processManagerMock.stopAllProcesses).not.toHaveBeenCalled();
    expect(breakpointSnapshotManagerMock.clearBreakpointSnapshots).not.toHaveBeenCalled();
  });

  it('stops active sessions before posting a same-region mapped scope sync', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    processManagerMock.getActiveAppNames.mockReturnValue(['sample-service-a']);
    await saveSessionConfig({
      orgGroupMappings: [{
        cfOrg: 'sample-org-beta',
        cfSpace: 'dev',
        groupFolderPath: '/sample/beta-dev',
      }],
    });

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'SCOPE_SYNCED',
        payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
      });
    });
    expect(processManagerMock.stopAllProcesses).toHaveBeenCalledTimes(1);
    expect(breakpointSnapshotManagerMock.clearBreakpointSnapshots).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'BREAKPOINT_SNAPSHOTS',
      payload: { snapshots: [] },
    });
    expect(getShowInformationMessageMock().mock.calls[0]?.[0]).toContain('sample-service-a');
  });

  it('stops active sessions before posting a same-region unmapped scope sync', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    processManagerMock.getActiveAppNames.mockReturnValue(['sample-service-a', 'sample-service-b']);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'SCOPE_SYNCED_NO_MAPPING',
        payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
      });
    });
    expect(processManagerMock.stopAllProcesses).toHaveBeenCalledTimes(1);
    const message = getShowInformationMessageMock().mock.calls[0]?.[0] ?? '';
    expect(message).toContain('sample-service-a, sample-service-b');
  });

  it('stops active sessions before cf logout for a cross-region scope with credentials', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    processManagerMock.getActiveAppNames.mockReturnValue(['sample-service-a']);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-beta']);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'LOGIN_SUCCESS',
        payload: {
          orgs: ['sample-org-beta'],
          apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
        },
      });
    });
    expect(processManagerMock.stopAllProcesses).toHaveBeenCalledTimes(1);
    expect(processManagerMock.stopAllProcesses.mock.invocationCallOrder[0])
      .toBeLessThan(cfClientMock.cfLogout.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });

  it('stops active sessions before prefilling region when cross-region credentials are missing', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    processManagerMock.getActiveAppNames.mockReturnValue(['sample-service-a']);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'REGION_PREFILL',
        payload: {
          regionCode: 'us10',
          apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
        },
      });
    });
    expect(processManagerMock.stopAllProcesses).toHaveBeenCalledTimes(1);
    expect(cfClientMock.cfLogin).not.toHaveBeenCalled();
  });

  it('returns immediately when stopping sessions for scope change and no sessions are active', async () => {
    const provider = makeProvider();

    await getInternals(provider).stopActiveSessionsForScopeChange();

    expect(processManagerMock.getActiveAppNames).toHaveBeenCalledTimes(1);
    expect(processManagerMock.stopAllProcesses).not.toHaveBeenCalled();
    expect(breakpointSnapshotManagerMock.clearBreakpointSnapshots).not.toHaveBeenCalled();
    expect(getShowInformationMessageMock()).not.toHaveBeenCalled();
  });

  it('stops processes then clears snapshots when active sessions exist', async () => {
    const provider = makeProvider();
    const callOrder: string[] = [];
    processManagerMock.getActiveAppNames.mockImplementation(() => {
      callOrder.push('getActiveAppNames');
      return ['sample-service-a'];
    });
    processManagerMock.stopAllProcesses.mockImplementation(() => {
      callOrder.push('stopAllProcesses');
      return Promise.resolve();
    });
    breakpointSnapshotManagerMock.clearBreakpointSnapshots.mockImplementation(() => {
      callOrder.push('clearBreakpointSnapshots');
    });

    await getInternals(provider).stopActiveSessionsForScopeChange();

    expect(callOrder).toEqual([
      'getActiveAppNames',
      'stopAllProcesses',
      'clearBreakpointSnapshots',
    ]);
  });

  it('notifies the user with stopped app names when active sessions are stopped', async () => {
    const provider = makeProvider();
    processManagerMock.getActiveAppNames.mockReturnValue(['sample-service-a', 'sample-service-b']);

    await getInternals(provider).stopActiveSessionsForScopeChange();

    const message = getShowInformationMessageMock().mock.calls[0]?.[0] ?? '';
    expect(message).toContain('sample-service-a');
    expect(message).toContain('sample-service-b');
  });

  it('logs a warning when stopping active sessions fails during external scope handling', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    processManagerMock.getActiveAppNames.mockReturnValue(['sample-service-a']);
    processManagerMock.stopAllProcesses.mockRejectedValue(new Error('mock stop failed'));
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    });

    await vi.waitFor(() => {
      expect(loggerMock.logWarn).toHaveBeenCalledWith(
        '[ScopeSync] Scope change handling failed: mock stop failed',
      );
    });
    expect(breakpointSnapshotManagerMock.clearBreakpointSnapshots).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('sends SCOPE_SYNCED_NO_MAPPING for a same-region external scope absent from stale orgs without a mapping', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveSessionConfig({ orgs: ['sample-org-alpha'] });

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-gamma',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'SCOPE_SYNCED_NO_MAPPING',
        payload: { orgName: 'sample-org-gamma', spaceName: 'app' },
      });
    });
  });

  it('sends SCOPE_SYNCED for a same-region external scope absent from stale orgs with a mapping', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveSessionConfig({
      orgs: ['sample-org-alpha'],
      orgGroupMappings: [{
        cfOrg: 'sample-org-gamma',
        cfSpace: 'app',
        groupFolderPath: '/sample/gamma',
      }],
    });

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-gamma',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'SCOPE_SYNCED',
        payload: { orgName: 'sample-org-gamma', spaceName: 'app' },
      });
    });
  });

  it('sends SCOPE_SYNCED for a same-region external scope with a mapping', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveSessionConfig({
      orgGroupMappings: [{
        cfOrg: 'sample-org-beta',
        cfSpace: 'dev',
        groupFolderPath: '/sample/beta-dev',
      }],
    });

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'SCOPE_SYNCED',
        payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
      });
    });
  });

  it('sends SCOPE_SYNCED_NO_MAPPING for a same-region external scope without a mapping', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'SCOPE_SYNCED_NO_MAPPING',
        payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
      });
    });
  });

  it('applies a pending external scope with mapping after manual login succeeds', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-beta']);
    getInternals(provider).pendingExternalScope = {
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    };
    await saveSessionConfig({
      orgGroupMappings: [{
        cfOrg: 'sample-org-beta',
        cfSpace: 'dev',
        groupFolderPath: '/sample/beta-dev',
      }],
    });

    await getInternals(provider).handleLogin('https://api.cf.eu10.hana.ondemand.com');

    expect(postMessage.mock.calls.map((call) => call[0])).toEqual([
      {
        type: 'LOGIN_SUCCESS',
        payload: {
          orgs: ['sample-org-beta'],
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
        },
      },
      {
        type: 'SCOPE_SYNCED',
        payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
      },
    ]);
  });

  it('applies a pending external scope without mapping after manual login succeeds', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-beta']);
    getInternals(provider).pendingExternalScope = {
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    };
    await saveSessionConfig();

    await getInternals(provider).handleLogin('https://api.cf.eu10.hana.ondemand.com');

    expect(postMessage.mock.calls.map((call) => call[0])).toEqual([
      {
        type: 'LOGIN_SUCCESS',
        payload: {
          orgs: ['sample-org-beta'],
          apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
        },
      },
      {
        type: 'SCOPE_SYNCED_NO_MAPPING',
        payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
      },
    ]);
  });

  it('does not post an extra scope message after manual login when no pending external scope exists', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-beta']);
    await saveSessionConfig();

    await getInternals(provider).handleLogin('https://api.cf.eu10.hana.ondemand.com');

    expect(postMessage.mock.calls.map((call) => call[0])).toEqual([{
      type: 'LOGIN_SUCCESS',
      payload: {
        orgs: ['sample-org-beta'],
        apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      },
    }]);
  });

  it('triggers immediate cache sync after saving keychain credentials', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);

    await getInternals(provider).handleSaveCredentials(' sample.user@example.com ', 'sample-password');

    expect(shellEnvMock.saveCredentialsToSecretStorage).toHaveBeenCalledWith(
      'sample.user@example.com',
      'sample-password',
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: 'CREDENTIALS_SAVED',
      payload: { email: 'sample.user@example.com', source: 'keychain' },
    });
    expect(cacheSyncMock.runCacheSync).toHaveBeenCalledTimes(1);
  });

  it('requests cache sync stop when changing mapping', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);

    await getInternals(provider).handleMessage({ type: 'REQUEST_CHANGE_MAPPING' });

    expect(cacheSyncMock.requestCacheSyncStop).toHaveBeenCalledTimes(1);
    expect(processManagerMock.stopAllProcesses).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'PROCEED_CHANGE_MAPPING' });
  });

  it('starts a single-region topology sync after login when cache sync is enabled', async () => {
    const provider = makeProvider();
    vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-alpha']);

    await getInternals(provider).handleLogin('https://api.cf.eu10.hana.ondemand.com');

    await vi.waitFor(() => {
      expect(cacheSyncMock.syncSingleRegion).toHaveBeenCalledWith(
        'eu10',
        'sample.user@example.com',
        'sample-password',
      );
    });
  });

  it('does not start single-region sync after login when background sync is disabled by environment', async () => {
    const previous = process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC;
    process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC = '1';
    const provider = makeProvider();
    vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-alpha']);

    try {
      await getInternals(provider).handleLogin('https://api.cf.eu10.hana.ondemand.com');
    } finally {
      if (previous === undefined) {
        delete process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC;
      } else {
        process.env.CDS_DEBUG_DISABLE_BACKGROUND_SYNC = previous;
      }
    }

    expect(cacheSyncMock.syncSingleRegion).not.toHaveBeenCalled();
  });

  it('does not start single-region sync after login when cache sync is disabled', async () => {
    const provider = makeProvider();
    vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    shellEnvMock.getCredentials.mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    cfClientMock.cfOrgs.mockResolvedValue(['sample-org-alpha']);
    await saveCacheSettings({ enabled: false, intervalHours: 24 });

    await getInternals(provider).handleLogin('https://api.cf.eu10.hana.ondemand.com');

    expect(getCacheSettings()).toEqual({ enabled: false, intervalHours: 24 });
    expect(cacheSyncMock.syncSingleRegion).not.toHaveBeenCalled();
  });

  it('refreshes only the CF session on topology warmup — no SSH probing of apps', async () => {
    const provider = makeProvider();
    const internals = getInternals(provider);
    const apps: CfApp[] = [{ name: 'sample-service-a', state: 'started', urls: [] }];
    const writeScope = vi.spyOn(internals, 'writeScopeAfterAppsLoaded').mockResolvedValue(undefined);
    const keepAlive = vi.spyOn(internals, 'keepCfSessionAlive').mockResolvedValue(undefined);
    cfTopologyMock.getAppsFromTopologySync.mockReturnValue(apps);
    await saveSessionConfig({
      orgGroupMappings: [{
        cfOrg: 'sample-org-alpha',
        cfSpace: 'app',
        groupFolderPath: '/sample/group',
      }],
    });

    await internals.handleWarmupCfSession('sample-org-alpha', 'app');

    expect(writeScope).toHaveBeenCalledWith('sample-org-alpha', 'app');
    expect(keepAlive).toHaveBeenCalledWith(
      'https://api.cf.eu10.hana.ondemand.com',
      'sample-org-alpha',
      'app',
    );
    expect(cfClientMock.cfTargetAndApps).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent topology warmups for the same target', async () => {
    const provider = makeProvider();
    const internals = getInternals(provider);
    const apps: CfApp[] = [{ name: 'sample-service-a', state: 'started', urls: [] }];
    let resolveSession: (() => void) | undefined;
    const keepAlive = vi.spyOn(internals, 'keepCfSessionAlive').mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveSession = resolve;
      }),
    );
    cfTopologyMock.getAppsFromTopologySync.mockReturnValue(apps);
    await saveSessionConfig({
      orgGroupMappings: [{
        cfOrg: 'sample-org-alpha',
        cfSpace: 'app',
        groupFolderPath: '/sample/group',
      }],
    });

    const first = internals.handleWarmupCfSession('sample-org-alpha', 'app');
    const second = internals.handleWarmupCfSession('sample-org-alpha', 'app');

    await vi.waitFor(() => {
      expect(keepAlive).toHaveBeenCalledTimes(1);
    });
    resolveSession?.();
    await Promise.all([first, second]);

    expect(keepAlive).toHaveBeenCalledTimes(1);
  });

  it('tracks extension-started CF-session keepalive so Start Debug can wait for it', async () => {
    const provider = makeProvider();
    const internals = getInternals(provider);
    let resolveSession: (() => void) | undefined;
    const keepAlive = vi.spyOn(internals, 'keepCfSessionAlive').mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveSession = resolve;
      }),
    );

    const tracked = internals.keepCfSessionAliveTracked(
      'https://api.cf.eu10.hana.ondemand.com',
      'sample-org-alpha',
      'app',
    );
    let waitFinished = false;
    const wait = internals.awaitWarmupIfRunning(
      'https://api.cf.eu10.hana.ondemand.com',
      'sample-org-alpha',
      'app',
    ).then(() => {
      waitFinished = true;
    });

    await Promise.resolve();
    expect(waitFinished).toBe(false);
    expect(keepAlive).toHaveBeenCalledTimes(1);

    resolveSession?.();
    await Promise.all([tracked, wait]);

    expect(waitFinished).toBe(true);
  });

  it('pushes a fresh topology snapshot after a single-region warmup event', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    cfTopologyMock.getTopologySnapshot.mockResolvedValue({
      ready: true,
      accounts: [],
    });

    cacheSyncMock.cacheSyncEvents.emit('regionWarmed', { regionKey: 'eu10' });

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'CF_TOPOLOGY',
        payload: { ready: true, accounts: [] },
      });
    });
  });

  it('clears a pending external scope after applying it', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    getInternals(provider).pendingExternalScope = {
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    };
    await saveSessionConfig({
      orgGroupMappings: [{
        cfOrg: 'sample-org-beta',
        cfSpace: 'dev',
        groupFolderPath: '/sample/beta-dev',
      }],
    });

    getInternals(provider).applyPendingExternalScopeIfAny(['sample-org-beta']);

    expect(getInternals(provider).pendingExternalScope).toBeUndefined();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-beta', spaceName: 'dev' },
    });
  });

  it('sets lastWrittenScope before writeScopeIfChanged resolves', async () => {
    const provider = makeProvider();
    await saveSessionConfig();
    const expectedScope: SharedCfScope = {
      regionCode: 'eu10',
      orgName: 'sample-org-alpha',
      spaceName: 'dev',
    };
    let scopeObservedDuringWrite: SharedCfScope | undefined;
    let resolveWrite: (() => void) | undefined;
    scopeSyncMock.writeScopeIfChanged.mockImplementation(() => new Promise<void>((resolve) => {
      scopeObservedDuringWrite = getInternals(provider).lastWrittenScope;
      resolveWrite = resolve;
    }));

    const writePromise = getInternals(provider).writeScopeAfterAppsLoaded('sample-org-alpha', 'dev');

    expect(scopeObservedDuringWrite).toEqual(expectedScope);
    if (resolveWrite === undefined) {
      throw new Error('writeScopeIfChanged was not called.');
    }
    resolveWrite();
    await writePromise;
    expect(getInternals(provider).lastWrittenScope).toEqual(expectedScope);
  });

  it('rolls back lastWrittenScope when writeScopeIfChanged fails', async () => {
    const provider = makeProvider();
    await saveSessionConfig();
    const previousScope: SharedCfScope = {
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'app',
    };
    getInternals(provider).lastWrittenScope = previousScope;
    scopeSyncMock.writeScopeIfChanged.mockRejectedValue(new Error('mock write failed'));

    await getInternals(provider).writeScopeAfterAppsLoaded('sample-org-alpha', 'dev');

    expect(getInternals(provider).lastWrittenScope).toEqual(previousScope);
    expect(loggerMock.logWarn).toHaveBeenCalledWith(
      '[ScopeSync] Failed to write shared CF scope: mock write failed',
    );
  });

});
