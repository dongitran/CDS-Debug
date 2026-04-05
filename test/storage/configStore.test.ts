import { describe, it, expect, beforeEach } from 'vitest';
import { initConfigStore, getConfig, saveConfig, clearConfig } from '../../src/storage/configStore';
import type { ExtensionConfig } from '../../src/types/index';

// Minimal in-memory mock that matches the shape of vscode.ExtensionContext.globalState
function makeContext() {
  const store = new Map<string, unknown>();
  return {
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

describe('configStore', () => {
  beforeEach(() => {
    initConfigStore(makeContext() as unknown as Parameters<typeof initConfigStore>[0]);
  });

  it('getConfig returns undefined when nothing has been saved', () => {
    expect(getConfig()).toBeUndefined();
  });

  it('saveConfig persists the config and getConfig retrieves it', async () => {
    const config: ExtensionConfig = {
      apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      orgs: ['org-a', 'org-b'],
      orgGroupMappings: [{ cfOrg: 'org-a', groupFolderPath: '/projects/group' }],
    };

    await saveConfig(config);

    expect(getConfig()).toEqual(config);
  });

  it('clearConfig removes the saved config', async () => {
    const config: ExtensionConfig = {
      apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      orgs: ['org-a'],
      orgGroupMappings: [],
    };
    await saveConfig(config);
    await clearConfig();

    expect(getConfig()).toBeUndefined();
  });

  it('saveConfig overwrites an existing config', async () => {
    const first: ExtensionConfig = {
      apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      orgs: ['org-a'],
      orgGroupMappings: [],
    };
    const second: ExtensionConfig = {
      apiEndpoint: 'https://api.cf.us10.hana.ondemand.com',
      orgs: ['org-b'],
      orgGroupMappings: [{ cfOrg: 'org-b', groupFolderPath: '/projects/b' }],
    };

    await saveConfig(first);
    await saveConfig(second);

    expect(getConfig()).toEqual(second);
  });

  it('throws when getConfig is called before initConfigStore', () => {
    // Simulate uninitialized state by passing undefined (cast through unknown)
    initConfigStore(undefined as unknown as Parameters<typeof initConfigStore>[0]);
    expect(() => getConfig()).toThrow('ConfigStore not initialized');
  });

  it('throws when saveConfig is called before initConfigStore', async () => {
    initConfigStore(undefined as unknown as Parameters<typeof initConfigStore>[0]);
    const config: ExtensionConfig = { apiEndpoint: '', orgs: [], orgGroupMappings: [] };
    await expect(saveConfig(config)).rejects.toThrow('ConfigStore not initialized');
  });
});
