import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtensionConfig, SharedCfScope } from '../../src/types/index';

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

import { buildLoginConfig } from '../../src/webview/debugPanel';
import { DebugLauncherViewProvider } from '../../src/webview/debugPanel';
import { initConfigStore, saveConfig } from '../../src/storage/configStore';

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
  });

  it('ignores a scope matching the last scope written by this provider', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    const scope: SharedCfScope = {
      regionCode: 'eu10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    };
    (provider as unknown as { lastWrittenScope: SharedCfScope | undefined }).lastWrittenScope = scope;
    await saveSessionConfig();

    provider.handleExternalScopeChange(scope);

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ignores an external scope when no session config exists', () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);

    provider.handleExternalScopeChange({
      regionCode: 'eu10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
    });

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ignores an external scope for a different region', async () => {
    const provider = makeProvider();
    const postMessage = vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveSessionConfig();

    provider.handleExternalScopeChange({
      regionCode: 'us10',
      orgName: 'sample-org-alpha',
      spaceName: 'app',
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
});
