import { describe, it, expect, beforeEach } from 'vitest';
import { initConfigStore, getConfig, saveConfig, clearConfig, upsertOrgMappings } from '../../src/storage/configStore';
import type { ExtensionConfig, OrgGroupMapping } from '../../src/types/index';

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

function makeDeferredContext() {
  const store = new Map<string, unknown>();
  let resolveUpdate: (() => void) | undefined;
  const updateStarted = new Promise<void>((resolve) => {
    resolveUpdate = resolve;
  });

  return {
    context: {
      globalState: {
        get: (key: string): unknown => store.get(key),
        update: async (key: string, value: unknown): Promise<void> => {
          await updateStarted;
          if (value === undefined) {
            store.delete(key);
          } else {
            store.set(key, value);
          }
        },
      },
    },
    resolveUpdate: (): void => resolveUpdate?.(),
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

  it('saveConfig updates the in-memory config before persistence resolves', async () => {
    const deferred = makeDeferredContext();
    initConfigStore(deferred.context as unknown as Parameters<typeof initConfigStore>[0]);

    const config: ExtensionConfig = {
      apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
      orgs: ['org-a'],
      orgGroupMappings: [{ cfOrg: 'org-a', groupFolderPath: '/projects/group' }],
    };

    const savePromise = saveConfig(config);

    expect(getConfig()).toEqual(config);

    deferred.resolveUpdate();
    await savePromise;
    expect(getConfig()).toEqual(config);
  });

  it('throws when getConfig is called before initConfigStore', () => {
    // Simulate uninitialized state by passing undefined.
    initConfigStore(undefined);
    expect(() => getConfig()).toThrow('ConfigStore not initialized');
  });

  it('throws when saveConfig is called before initConfigStore', async () => {
    initConfigStore(undefined);
    const config: ExtensionConfig = { apiEndpoint: '', orgs: [], orgGroupMappings: [] };
    await expect(saveConfig(config)).rejects.toThrow('ConfigStore not initialized');
  });
});

describe('upsertOrgMappings', () => {
  it('returns incoming mapping when existing list is empty', () => {
    const incoming: OrgGroupMapping[] = [{ cfOrg: 'org-a', groupFolderPath: '/projects/a' }];
    const result = upsertOrgMappings([], incoming);
    expect(result).toEqual([{ cfOrg: 'org-a', groupFolderPath: '/projects/a' }]);
  });

  it('preserves existing mapping when adding a different org', () => {
    const existing: OrgGroupMapping[] = [{ cfOrg: 'org-a', groupFolderPath: '/projects/a' }];
    const incoming: OrgGroupMapping[] = [{ cfOrg: 'org-b', groupFolderPath: '/projects/b' }];
    const result = upsertOrgMappings(existing, incoming);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ cfOrg: 'org-a', groupFolderPath: '/projects/a' });
    expect(result).toContainEqual({ cfOrg: 'org-b', groupFolderPath: '/projects/b' });
  });

  it('updates folder path when same org is re-saved with a new folder', () => {
    const existing: OrgGroupMapping[] = [{ cfOrg: 'org-a', groupFolderPath: '/projects/a-old' }];
    const incoming: OrgGroupMapping[] = [{ cfOrg: 'org-a', groupFolderPath: '/projects/a-new' }];
    const result = upsertOrgMappings(existing, incoming);
    expect(result).toEqual([{ cfOrg: 'org-a', groupFolderPath: '/projects/a-new' }]);
  });

  it('preserves mappings for different spaces in the same org', () => {
    const existing: OrgGroupMapping[] = [{ cfOrg: 'org-a', cfSpace: 'app', groupFolderPath: '/projects/app' }];
    const incoming: OrgGroupMapping[] = [{ cfOrg: 'org-a', cfSpace: 'dev', groupFolderPath: '/projects/dev' }];
    const result = upsertOrgMappings(existing, incoming);

    expect(result).toEqual([
      { cfOrg: 'org-a', cfSpace: 'app', groupFolderPath: '/projects/app' },
      { cfOrg: 'org-a', cfSpace: 'dev', groupFolderPath: '/projects/dev' },
    ]);
  });

  it('treats legacy org-only mappings as the default app space', () => {
    const existing: OrgGroupMapping[] = [{ cfOrg: 'org-a', groupFolderPath: '/projects/legacy' }];
    const incoming: OrgGroupMapping[] = [{ cfOrg: 'org-a', cfSpace: 'app', groupFolderPath: '/projects/app' }];
    const result = upsertOrgMappings(existing, incoming);

    expect(result).toEqual([{ cfOrg: 'org-a', cfSpace: 'app', groupFolderPath: '/projects/app' }]);
  });

  it('handles multi-org round-trip: org-A → org-B → org-A preserves both folders', () => {
    // Simulate: user picks org-A + folder-A, then org-B + folder-B, then org-A + folder-A again
    const afterFirst = upsertOrgMappings([], [{ cfOrg: 'org-a', groupFolderPath: '/folder-a' }]);
    const afterSecond = upsertOrgMappings(afterFirst, [{ cfOrg: 'org-b', groupFolderPath: '/folder-b' }]);
    const afterThird = upsertOrgMappings(afterSecond, [{ cfOrg: 'org-a', groupFolderPath: '/folder-a' }]);

    expect(afterThird).toHaveLength(2);
    expect(afterThird.find(m => m.cfOrg === 'org-a')?.groupFolderPath).toBe('/folder-a');
    expect(afterThird.find(m => m.cfOrg === 'org-b')?.groupFolderPath).toBe('/folder-b');
  });

  it('handles multiple incoming mappings at once', () => {
    const existing: OrgGroupMapping[] = [{ cfOrg: 'org-a', groupFolderPath: '/a' }];
    const incoming: OrgGroupMapping[] = [
      { cfOrg: 'org-a', groupFolderPath: '/a-updated' },
      { cfOrg: 'org-b', groupFolderPath: '/b' },
    ];
    const result = upsertOrgMappings(existing, incoming);
    expect(result).toHaveLength(2);
    expect(result.find(m => m.cfOrg === 'org-a')?.groupFolderPath).toBe('/a-updated');
    expect(result.find(m => m.cfOrg === 'org-b')?.groupFolderPath).toBe('/b');
  });

  it('does not mutate the input arrays', () => {
    const existing: OrgGroupMapping[] = [{ cfOrg: 'org-a', groupFolderPath: '/a' }];
    const incoming: OrgGroupMapping[] = [{ cfOrg: 'org-b', groupFolderPath: '/b' }];
    const existingSnapshot = JSON.stringify(existing);
    const incomingSnapshot = JSON.stringify(incoming);
    upsertOrgMappings(existing, incoming);
    expect(JSON.stringify(existing)).toBe(existingSnapshot);
    expect(JSON.stringify(incoming)).toBe(incomingSnapshot);
  });

  it('returns empty array when both inputs are empty', () => {
    expect(upsertOrgMappings([], [])).toEqual([]);
  });
});
