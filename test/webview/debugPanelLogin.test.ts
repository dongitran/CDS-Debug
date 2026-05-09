import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CfClientModule from '../../src/core/cfClient';
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

interface DebugPanelInternals {
  lastWrittenScope: SharedCfScope | undefined;
  handleExternalRegionChange(scope: SharedCfScope): Promise<void>;
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
  });

  it('ignores a scope matching the last scope written by this provider', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    const scope: SharedCfScope = {
      regionCode: 'eu10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    };
    getInternals(provider).lastWrittenScope = scope;
    await saveSessionConfig();

    provider.handleExternalScopeChange(scope);

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

    expect(handleExternalRegionChange).toHaveBeenCalledWith(scope);
    expect(postMessage).not.toHaveBeenCalledWith({
      type: 'SCOPE_SYNCED',
      payload: { orgName: 'sample-org-alpha', spaceName: 'app' },
    });
  });

  it('does not login or post messages for a cross-region scope when credentials are missing', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    });

    await vi.waitFor(() => {
      expect(shellEnvMock.getCredentials).toHaveBeenCalled();
    });
    expect(cfClientMock.cfLogin).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('posts LOGIN_SUCCESS and SCOPE_SYNCED after a cross-region login when the target org exists', async () => {
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
  });

  it('does not post messages and logs a warning when cross-region login fails', async () => {
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
      expect(loggerMock.logWarn).toHaveBeenCalledWith(
        '[ScopeSync] Cross-region auto-login failed: mock login failed',
      );
    });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ignores an external scope for an org outside the active session', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-gamma',
      spaceName: 'app',
    });

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('sends SCOPE_SYNCED for a compatible external scope', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-beta',
      spaceName: 'dev',
    });

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
