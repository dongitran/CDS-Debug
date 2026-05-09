import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CfClientModule from '../../src/core/cfClient';
import type * as BreakpointSnapshotManagerModule from '../../src/core/breakpointSnapshotManager';
import type * as ProcessManagerModule from '../../src/core/processManager';
import type * as ScopeSyncModule from '../../src/storage/scopeSync';
import type * as ShellEnvModule from '../../src/core/shellEnv';
import type { ExtensionConfig, SharedCfScope } from '../../src/types/index';

const cfClientMock = vi.hoisted(() => ({
  cfLogin: vi.fn<(apiEndpoint: string, email: string, password: string) => Promise<void>>(
    () => Promise.resolve(),
  ),
  cfLogout: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  cfOrgs: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
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
  };
});

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
import { getConfig, initConfigStore, saveConfig } from '../../src/storage/configStore';
import * as vscode from 'vscode';

type ShowInformationMessageMock = ReturnType<
  typeof vi.fn<(message: string) => Promise<string | undefined>>
>;

interface DebugPanelInternals {
  lastWrittenScope: SharedCfScope | undefined;
  pendingExternalScope: SharedCfScope | undefined;
  applyPendingExternalScopeIfAny(orgs: string[]): void;
  handleLogin(apiEndpoint: string): Promise<void>;
  handleScopeChangeInternal(scope: SharedCfScope): Promise<void>;
  handleExternalRegionChange(scope: SharedCfScope): Promise<void>;
  stopActiveSessionsForScopeChange(): Promise<void>;
  writeScopeAfterAppsLoaded(org: string, space: string): Promise<void>;
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
  beforeEach(() => {
    initConfigStore(makeContext() as unknown as Parameters<typeof initConfigStore>[0]);
    cfClientMock.cfLogin.mockReset();
    cfClientMock.cfLogin.mockResolvedValue(undefined);
    cfClientMock.cfLogout.mockReset();
    cfClientMock.cfLogout.mockResolvedValue(undefined);
    cfClientMock.cfOrgs.mockReset();
    cfClientMock.cfOrgs.mockResolvedValue([]);
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
