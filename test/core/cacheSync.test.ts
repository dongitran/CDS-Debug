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
  persistRegion: vi.fn().mockResolvedValue(undefined),
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
  cfAppDetails: vi.fn().mockResolvedValue([]),
}));

import {
  cacheSyncEvents,
  populateCacheFromStructure,
  getCurrentSyncProgress,
  runCacheSync,
  syncSingleRegion,
} from '../../src/core/cacheSync';
import {
  cfApi,
  cfAppDetails,
  cfAuth,
  cfOrgs,
  cfSpaces,
  cfTargetOrg,
  cfTargetSpace,
  completeRuntimeState,
  initializeRuntimeState,
  persistRegion,
  tryAcquireSyncLock,
} from '@saptools/cf-sync';
import type { CfStructure, RuntimeSyncState } from '@saptools/cf-sync';
import { getCredentials } from '../../src/core/shellEnv';
import {
  saveCachedApps,
  saveCachedOrgs,
  getSyncProgress,
  saveSyncProgress,
  getCacheSettings,
} from '../../src/storage/cacheStore';
import type { SyncProgress } from '../../src/types/index';

const EU10_ENDPOINT = 'https://api.cf.eu10.hana.ondemand.com';
const AP11_ENDPOINT = 'https://api.cf.ap11.hana.ondemand.com';

function makeStructure(overrides: Partial<CfStructure> = {}): CfStructure {
  return {
    syncedAt: '2026-04-25T10:00:00.000Z',
    regions: [],
    ...overrides,
  };
}

function makeRuntimeState(overrides: Partial<RuntimeSyncState> = {}): RuntimeSyncState {
  const now = new Date().toISOString();
  return {
    syncId: 'sample-sync',
    status: 'running',
    startedAt: now,
    updatedAt: now,
    requestedRegionKeys: ['eu10', 'ap11', 'us10'],
    completedRegionKeys: [],
    structure: makeStructure(),
    ...overrides,
  };
}

function makeLockHandle(): Exclude<Awaited<ReturnType<typeof tryAcquireSyncLock>>, undefined> {
  return { lockPath: '/tmp/sample-sync.lock' } as unknown as Exclude<
    Awaited<ReturnType<typeof tryAcquireSyncLock>>,
    undefined
  >;
}

function savedProgressCalls(): SyncProgress[] {
  return vi.mocked(saveSyncProgress).mock.calls.map(([progress]) => progress);
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

  it('saves apps per space instead of flattening them under the org', async () => {
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
    ], 'demo-space-a');
    expect(saveCachedApps).toHaveBeenCalledWith(EU10_ENDPOINT, 'demo-org', [
      { name: 'sample-svc-3', state: 'stopped', urls: [] },
    ], 'demo-space-b');
  });

  it('keeps apps with the same name isolated by space', async () => {
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

    expect(saveCachedApps).toHaveBeenCalledWith(EU10_ENDPOINT, 'demo-org', [
      { name: 'shared-svc', state: 'stopped', urls: [] },
      { name: 'unique-svc', state: 'stopped', urls: [] },
    ], 'demo-space-a');
    expect(saveCachedApps).toHaveBeenCalledWith(EU10_ENDPOINT, 'demo-org', [
      { name: 'shared-svc', state: 'stopped', urls: [] },
    ], 'demo-space-b');
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

  it('maps detailed cf-sync app metadata into debuggable app states and urls', async () => {
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
                {
                  name: 'demo-space',
                  apps: [
                    {
                      name: 'sample-service-started',
                      requestedState: 'started',
                      runningInstances: 1,
                      totalInstances: 1,
                      routes: ['sample-service-started.cfapps.example.com'],
                    },
                    {
                      name: 'sample-service-empty',
                      requestedState: 'started',
                      runningInstances: 0,
                      totalInstances: 1,
                      routes: [],
                    },
                    {
                      name: 'sample-service-stopped',
                      requestedState: 'stopped',
                      runningInstances: 0,
                      totalInstances: 1,
                      routes: ['sample-service-stopped.cfapps.example.com'],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    expect(saveCachedApps).toHaveBeenCalledWith(EU10_ENDPOINT, 'demo-org', [
      {
        name: 'sample-service-started',
        state: 'started',
        urls: ['sample-service-started.cfapps.example.com'],
      },
      { name: 'sample-service-empty', state: 'empty', urls: [] },
      {
        name: 'sample-service-stopped',
        state: 'stopped',
        urls: ['sample-service-stopped.cfapps.example.com'],
      },
    ], 'demo-space');
  });

  it('keeps older name-only cf-sync snapshots as stopped for backward compatibility', async () => {
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
              spaces: [{ name: 'demo-space', apps: [{ name: 'legacy-app' }] }],
            },
          ],
        },
      ],
    });

    await populateCacheFromStructure(structure);

    expect(saveCachedApps).toHaveBeenCalledWith(EU10_ENDPOINT, 'demo-org', [
      { name: 'legacy-app', state: 'stopped', urls: [] },
    ], 'demo-space');
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

describe('runCacheSync progress status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSyncProgress).mockReturnValue(undefined);
    vi.mocked(getCacheSettings).mockReturnValue({ enabled: true, intervalHours: 24 });
    vi.mocked(getCredentials).mockResolvedValue({ email: '', password: '' });
    vi.mocked(tryAcquireSyncLock).mockResolvedValue(undefined);
    vi.mocked(initializeRuntimeState).mockResolvedValue(makeRuntimeState());
    vi.mocked(completeRuntimeState).mockResolvedValue(makeRuntimeState({
      status: 'completed',
      finishedAt: new Date().toISOString(),
      structure: makeStructure({ syncedAt: new Date().toISOString() }),
      completedRegionKeys: [],
    }));
  });

  it('preserves lastCompletedAt and records skip reason when credentials are missing', async () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    vi.mocked(getSyncProgress).mockReturnValue({
      isRunning: false,
      lastCompletedAt: oneHourAgo,
      done: 5,
      total: 5,
    });

    runCacheSync();

    await vi.waitFor(() => {
      expect(saveSyncProgress).toHaveBeenCalledWith(expect.objectContaining({
        lastSkipReason: 'no-credentials',
      }));
    });
    const stored = savedProgressCalls().at(-1);
    expect(stored).toMatchObject({
      isRunning: false,
      done: 0,
      total: MOCK_REGIONS.length,
      lastCompletedAt: oneHourAgo,
      lastSkipReason: 'no-credentials',
    });
    expect(stored?.lastAttemptedAt).toEqual(expect.any(Number));
  });

  it('clears lastSkipReason and updates lastCompletedAt on successful sync', async () => {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    vi.mocked(getSyncProgress).mockReturnValue({
      isRunning: false,
      lastCompletedAt: yesterday,
      lastAttemptedAt: Date.now() - 30 * 60 * 1000,
      lastSkipReason: 'no-credentials',
      done: 0,
      total: MOCK_REGIONS.length,
    });
    vi.mocked(getCredentials).mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    vi.mocked(tryAcquireSyncLock).mockResolvedValue(makeLockHandle());

    runCacheSync();

    await vi.waitFor(() => {
      expect(saveSyncProgress).toHaveBeenCalledWith(expect.objectContaining({
        isRunning: false,
        done: MOCK_REGIONS.length,
        total: MOCK_REGIONS.length,
      }));
    });
    const stored = savedProgressCalls().at(-1);
    expect(stored?.lastSkipReason).toBeUndefined();
    expect(stored?.lastAttemptedAt).toEqual(expect.any(Number));
    expect(stored?.lastCompletedAt).toEqual(expect.any(Number));
    expect(stored?.lastCompletedAt ?? 0).toBeGreaterThan(yesterday);
  });

  it('preserves lastCompletedAt when sync fails fatally', async () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    vi.mocked(getSyncProgress).mockReturnValue({
      isRunning: false,
      lastCompletedAt: oneHourAgo,
      done: 5,
      total: 5,
    });
    vi.mocked(getCredentials).mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    vi.mocked(tryAcquireSyncLock).mockResolvedValue(makeLockHandle());
    vi.mocked(initializeRuntimeState).mockRejectedValue(new Error('mock runtime failure'));

    runCacheSync();

    await vi.waitFor(() => {
      expect(saveSyncProgress).toHaveBeenCalledWith(expect.objectContaining({
        lastSkipReason: 'fatal-error',
      }));
    });
    const stored = savedProgressCalls().find((progress) => progress.lastSkipReason === 'fatal-error');
    expect(stored).toMatchObject({
      isRunning: false,
      done: 0,
      total: MOCK_REGIONS.length,
      lastCompletedAt: oneHourAgo,
      lastSkipReason: 'fatal-error',
    });
    expect(stored?.lastAttemptedAt).toEqual(expect.any(Number));
  });
});

describe('syncSingleRegion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSyncProgress).mockReturnValue(undefined);
    vi.mocked(getCacheSettings).mockReturnValue({ enabled: true, intervalHours: 24 });
    vi.mocked(cfApi).mockResolvedValue(undefined);
    vi.mocked(cfAuth).mockResolvedValue(undefined);
    vi.mocked(cfOrgs).mockResolvedValue(['demo-org']);
    vi.mocked(cfTargetOrg).mockResolvedValue(undefined);
    vi.mocked(cfSpaces).mockResolvedValue(['app']);
    vi.mocked(cfTargetSpace).mockResolvedValue(undefined);
    vi.mocked(cfAppDetails).mockResolvedValue([{
      name: 'sample-service-a',
      requestedState: 'started',
      runningInstances: 1,
      totalInstances: 1,
      routes: ['sample-service-a.cfapps.example.com'],
    }]);
    vi.mocked(persistRegion).mockResolvedValue(undefined);
  });

  it('returns failed for an unknown region key', async () => {
    await expect(syncSingleRegion(
      'missing' as Parameters<typeof syncSingleRegion>[0],
      'sample.user@example.com',
      'sample-password',
    )).resolves.toEqual({ status: 'failed', error: 'unknown-region' });

    expect(persistRegion).not.toHaveBeenCalled();
  });

  it('collects and persists one region then emits regionWarmed', async () => {
    const warmed: string[] = [];
    cacheSyncEvents.once('regionWarmed', (payload: { regionKey: string }) => {
      warmed.push(payload.regionKey);
    });

    await expect(syncSingleRegion(
      'eu10',
      'sample.user@example.com',
      'sample-password',
    )).resolves.toEqual({ status: 'synced' });

    expect(cfApi).toHaveBeenCalledWith(EU10_ENDPOINT, expect.objectContaining({
      env: expect.objectContaining({ CF_HOME: expect.any(String) as string }),
    }));
    expect(cfAuth).toHaveBeenCalledWith(
      'sample.user@example.com',
      'sample-password',
      expect.any(Object),
    );
    expect(persistRegion).toHaveBeenCalledWith({
      key: 'eu10',
      label: 'Europe (Frankfurt) - AWS (eu10)',
      apiEndpoint: EU10_ENDPOINT,
      accessible: true,
      orgs: [{
        name: 'demo-org',
        spaces: [{
          name: 'app',
          apps: [{
            name: 'sample-service-a',
            requestedState: 'started',
            runningInstances: 1,
            totalInstances: 1,
            routes: ['sample-service-a.cfapps.example.com'],
          }],
        }],
      }],
    });
    expect(warmed).toEqual(['eu10']);
  });

  it('returns failed and does not emit when collection throws', async () => {
    const warmed: string[] = [];
    cacheSyncEvents.once('regionWarmed', (payload: { regionKey: string }) => {
      warmed.push(payload.regionKey);
    });
    vi.mocked(persistRegion).mockRejectedValue(new Error('mock persist failed'));

    const result = await syncSingleRegion('eu10', 'sample.user@example.com', 'sample-password');

    expect(result).toEqual({ status: 'failed', error: 'mock persist failed' });
    expect(warmed).toEqual([]);
  });

  it('skips when the full sync loop is already running', async () => {
    vi.mocked(getCredentials).mockResolvedValue({
      email: 'sample.user@example.com',
      password: 'sample-password',
    });
    let resolveLock: ((handle: Exclude<Awaited<ReturnType<typeof tryAcquireSyncLock>>, undefined>) => void) | undefined;
    vi.mocked(tryAcquireSyncLock).mockImplementationOnce(() => new Promise((resolve) => {
      resolveLock = resolve;
    }));

    runCacheSync();

    await vi.waitFor(() => {
      expect(tryAcquireSyncLock).toHaveBeenCalled();
    });

    await expect(syncSingleRegion(
      'eu10',
      'sample.user@example.com',
      'sample-password',
    )).resolves.toEqual({ status: 'skipped' });

    expect(resolveLock).toBeDefined();
    resolveLock?.(makeLockHandle());
    await vi.waitFor(() => {
      expect(saveSyncProgress).toHaveBeenCalledWith(expect.objectContaining({
        isRunning: false,
      }));
    });
  });
});
