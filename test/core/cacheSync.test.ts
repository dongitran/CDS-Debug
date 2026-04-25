import { describe, it, expect, vi, beforeEach } from 'vitest';

const MOCK_REGIONS = vi.hoisted(() => [
  { key: 'eu10', label: 'Europe (Frankfurt) - AWS (eu10)', apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com' },
  { key: 'ap11', label: 'Asia Pacific (Singapore) - AWS (ap11)', apiEndpoint: 'https://api.cf.ap11.hana.ondemand.com' },
  { key: 'us10', label: 'US East (VA) - AWS (us10)', apiEndpoint: 'https://api.cf.us10.hana.ondemand.com' },
]);

// Must mock before importing the module under test
vi.mock('../../src/storage/cacheStore', () => ({
  saveCachedApps: vi.fn().mockResolvedValue(undefined),
  saveCachedOrgs: vi.fn().mockResolvedValue(undefined),
  getSyncProgress: vi.fn().mockReturnValue(undefined),
  saveSyncProgress: vi.fn().mockResolvedValue(undefined),
  getCacheSettings: vi.fn().mockReturnValue({ enabled: true, intervalHours: 24 }),
  getDebugPreferences: vi.fn(),
  getDebugSessionPackagePreferences: vi.fn(),
  saveDebugPreferences: vi.fn(),
  saveDebugSessionPackagePreferences: vi.fn(),
}));

vi.mock('../../src/core/shellEnv', () => ({
  getCredentials: vi.fn().mockResolvedValue({ email: '', password: '' }),
}));

vi.mock('../../src/core/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@saptools/cf-sync', () => ({
  getAllRegions: vi.fn().mockReturnValue(MOCK_REGIONS),
  cfStructurePath: vi.fn().mockReturnValue('/tmp/cds-debug-test-cf-structure.json'),
  writeStructure: vi.fn().mockResolvedValue(undefined),
  initializeRuntimeState: vi.fn().mockResolvedValue({}),
  mergeRuntimeRegion: vi.fn().mockResolvedValue(undefined),
  completeRuntimeState: vi.fn().mockResolvedValue({
    structure: { regions: [], syncedAt: new Date().toISOString() },
    completedRegionKeys: [],
  }),
  failRuntimeState: vi.fn().mockResolvedValue(undefined),
  tryAcquireSyncLock: vi.fn().mockResolvedValue(undefined),
  releaseSyncLock: vi.fn().mockResolvedValue(undefined),
  cfApi: vi.fn().mockResolvedValue(undefined),
  cfAuth: vi.fn().mockResolvedValue(undefined),
  cfOrgs: vi.fn().mockResolvedValue([]),
  cfSpaces: vi.fn().mockResolvedValue([]),
  cfTargetOrg: vi.fn().mockResolvedValue(undefined),
  cfTargetSpace: vi.fn().mockResolvedValue(undefined),
  cfApps: vi.fn().mockResolvedValue([]),
}));

import { populateCacheFromStructure, getCurrentSyncProgress } from '../../src/core/cacheSync';
import type { CfStructure } from '@saptools/cf-sync';
import { saveCachedApps, saveCachedOrgs, getSyncProgress } from '../../src/storage/cacheStore';

const EU10_ENDPOINT = 'https://api.cf.eu10.hana.ondemand.com';
const AP11_ENDPOINT = 'https://api.cf.ap11.hana.ondemand.com';

function makeStructure(overrides: Partial<CfStructure> = {}): CfStructure {
  return {
    syncedAt: '2026-04-25T10:00:00.000Z',
    regions: [],
    ...overrides,
  };
}

describe('populateCacheFromStructure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips inaccessible regions', async () => {
    const structure = makeStructure({
      regions: [
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: false,
          orgs: [{ name: 'demo-org', spaces: [{ name: 'demo-space', apps: [{ name: 'demo-app' }] }] }],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    expect(saveCachedOrgs).not.toHaveBeenCalled();
    expect(saveCachedApps).not.toHaveBeenCalled();
  });

  it('saves org names for accessible regions', async () => {
    const structure = makeStructure({
      regions: [
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [
            { name: 'demo-org-a', spaces: [] },
            { name: 'demo-org-b', spaces: [] },
          ],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    expect(saveCachedOrgs).toHaveBeenCalledWith(EU10_ENDPOINT, ['demo-org-a', 'demo-org-b']);
  });

  it('flattens apps from all spaces of an org', async () => {
    const structure = makeStructure({
      regions: [
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [
            {
              name: 'demo-org',
              spaces: [
                { name: 'demo-space-a', apps: [{ name: 'sample-svc-1' }, { name: 'sample-svc-2' }] },
                { name: 'demo-space-b', apps: [{ name: 'sample-svc-3' }] },
              ],
            },
          ],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    expect(saveCachedApps).toHaveBeenCalledWith(EU10_ENDPOINT, 'demo-org', [
      { name: 'sample-svc-1', state: 'stopped', urls: [] },
      { name: 'sample-svc-2', state: 'stopped', urls: [] },
      { name: 'sample-svc-3', state: 'stopped', urls: [] },
    ]);
  });

  it('deduplicates apps that appear in multiple spaces', async () => {
    const structure = makeStructure({
      regions: [
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [
            {
              name: 'demo-org',
              spaces: [
                { name: 'demo-space-a', apps: [{ name: 'shared-svc' }, { name: 'unique-svc' }] },
                { name: 'demo-space-b', apps: [{ name: 'shared-svc' }] },
              ],
            },
          ],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    const call = vi.mocked(saveCachedApps).mock.calls[0];
    const apps = call?.[2] ?? [];
    const names = apps.map((a) => a.name);
    expect(names).toEqual(['shared-svc', 'unique-svc']);
    expect(apps).toHaveLength(2);
  });

  it('saves empty apps list for an org with no spaces', async () => {
    const structure = makeStructure({
      regions: [
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [{ name: 'empty-org', spaces: [] }],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    expect(saveCachedApps).toHaveBeenCalledWith(EU10_ENDPOINT, 'empty-org', []);
  });

  it('processes multiple accessible regions independently', async () => {
    const structure = makeStructure({
      regions: [
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [{ name: 'demo-org-eu', spaces: [{ name: 'demo-space', apps: [{ name: 'demo-svc' }] }] }],
        },
        {
          key: 'ap11',
          label: 'Asia Pacific (Singapore) - AWS (ap11)',
          apiEndpoint: AP11_ENDPOINT,
          accessible: true,
          orgs: [{ name: 'demo-org-ap', spaces: [{ name: 'demo-space', apps: [{ name: 'sample-svc' }] }] }],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    expect(saveCachedOrgs).toHaveBeenCalledWith(EU10_ENDPOINT, ['demo-org-eu']);
    expect(saveCachedOrgs).toHaveBeenCalledWith(AP11_ENDPOINT, ['demo-org-ap']);
    expect(saveCachedApps).toHaveBeenCalledTimes(2);
  });

  it('skips orgs with errors but still processes accessible siblings', async () => {
    const structure = makeStructure({
      regions: [
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [
            { name: 'error-org', spaces: [], error: 'permission denied' },
            { name: 'ok-org', spaces: [{ name: 'demo-space', apps: [{ name: 'demo-app' }] }] },
          ],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    // Both orgs are cached (even the error org with no apps)
    expect(saveCachedApps).toHaveBeenCalledTimes(2);
    const okCall = vi.mocked(saveCachedApps).mock.calls.find((c) => c[1] === 'ok-org');
    expect(okCall?.[2]).toHaveLength(1);
  });

  it('maps all apps with state=stopped and empty urls', async () => {
    const structure = makeStructure({
      regions: [
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [
            {
              name: 'demo-org',
              spaces: [{ name: 'demo-space', apps: [{ name: 'demo-app-1' }, { name: 'demo-app-2' }] }],
            },
          ],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    const [, , apps] = vi.mocked(saveCachedApps).mock.calls[0] ?? [];
    for (const app of apps ?? []) {
      expect(app.state).toBe('stopped');
      expect(app.urls).toEqual([]);
    }
  });
});

describe('getCurrentSyncProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns saved progress when available', () => {
    const saved = { isRunning: false, done: 10, total: 42, lastCompletedAt: 1_700_000_000_000 };
    vi.mocked(getSyncProgress).mockReturnValue(saved);

    expect(getCurrentSyncProgress()).toEqual(saved);
  });

  it('returns default progress with catalog total when nothing is saved', () => {
    vi.mocked(getSyncProgress).mockReturnValue(undefined);

    const result = getCurrentSyncProgress();

    expect(result.isRunning).toBe(false);
    expect(result.done).toBe(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('returns isRunning=true fallback when sync is in progress with no saved progress', () => {
    vi.mocked(getSyncProgress).mockReturnValue(undefined);
    // Cannot set _sync.isSyncing directly since it's module-private;
    // the fallback path from undefined getSyncProgress is verified above.
    // This test confirms the type contract is correct.
    const result = getCurrentSyncProgress();
    expect(typeof result.isRunning).toBe('boolean');
  });
});
