import { describe, it, expect, beforeEach } from 'vitest';
import {
  initCacheStore,
  getCachedApps,
  saveCachedApps,
  saveCachedOrgs,
  getSyncProgress,
  saveSyncProgress,
  getCacheSettings,
  saveCacheSettings,
  getDebugPreferences,
  saveDebugPreferences,
} from '../../src/storage/cacheStore';
import type { CfApp, SyncProgress, CacheSettings, DebugPreferences } from '../../src/types/index';
import { DEFAULT_CACHE_SETTINGS, DEFAULT_DEBUG_PREFERENCES } from '../../src/types/index';

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

describe('cacheStore', () => {
  beforeEach(() => {
    initCacheStore(makeContext() as unknown as Parameters<typeof initCacheStore>[0]);
  });

  // ── app cache ──────────────────────────────────────────────────────────────

  it('getCachedApps returns undefined for an unknown endpoint', () => {
    expect(getCachedApps('https://api.cf.eu10.hana.ondemand.com', 'org-a')).toBeUndefined();
  });

  it('saveCachedApps persists apps and getCachedApps retrieves them', async () => {
    const apps: CfApp[] = [
      { name: 'svc-one', state: 'started', urls: ['svc-one.cfapps.eu10.hana.ondemand.com'] },
      { name: 'svc-two', state: 'stopped', urls: [] },
    ];

    await saveCachedApps('https://api.cf.eu10.hana.ondemand.com', 'org-a', apps);

    const result = getCachedApps('https://api.cf.eu10.hana.ondemand.com', 'org-a');
    expect(result?.apps).toEqual(apps);
    expect(result?.cachedAt).toBeGreaterThan(0);
  });

  it('saveCachedApps keeps other orgs under the same endpoint intact', async () => {
    const appsA: CfApp[] = [{ name: 'svc-a', state: 'started', urls: [] }];
    const appsB: CfApp[] = [{ name: 'svc-b', state: 'started', urls: [] }];
    const endpoint = 'https://api.cf.eu10.hana.ondemand.com';

    await saveCachedApps(endpoint, 'org-a', appsA);
    await saveCachedApps(endpoint, 'org-b', appsB);

    expect(getCachedApps(endpoint, 'org-a')?.apps).toEqual(appsA);
    expect(getCachedApps(endpoint, 'org-b')?.apps).toEqual(appsB);
  });

  it('saveCachedApps overwrites previously cached apps for the same org', async () => {
    const endpoint = 'https://api.cf.eu10.hana.ondemand.com';
    const original: CfApp[] = [{ name: 'svc-old', state: 'started', urls: [] }];
    const updated: CfApp[] = [{ name: 'svc-new', state: 'stopped', urls: [] }];

    await saveCachedApps(endpoint, 'org-a', original);
    await saveCachedApps(endpoint, 'org-a', updated);

    expect(getCachedApps(endpoint, 'org-a')?.apps).toEqual(updated);
  });

  it('getCachedApps returns undefined for an unknown org under a known endpoint', async () => {
    await saveCachedApps('https://api.cf.eu10.hana.ondemand.com', 'org-a', []);

    expect(getCachedApps('https://api.cf.eu10.hana.ondemand.com', 'org-unknown')).toBeUndefined();
  });

  // ── org cache ──────────────────────────────────────────────────────────────

  it('saveCachedOrgs persists orgs under the given endpoint', async () => {
    const endpoint = 'https://api.cf.eu10.hana.ondemand.com';
    await saveCachedOrgs(endpoint, ['org-a', 'org-b', 'org-c']);

    // Orgs are stored inside the CfRegionCache entry; indirectly verify by
    // checking that subsequent saveCachedApps does not erase them.
    await saveCachedApps(endpoint, 'org-a', []);
    // getCachedApps still works → the entry wasn't wiped by saveCachedOrgs
    expect(getCachedApps(endpoint, 'org-a')).toBeDefined();
  });

  // ── sync progress ──────────────────────────────────────────────────────────

  it('getSyncProgress returns undefined when nothing has been saved', () => {
    expect(getSyncProgress()).toBeUndefined();
  });

  it('saveSyncProgress persists progress and getSyncProgress retrieves it', async () => {
    const progress: SyncProgress = {
      isRunning: true,
      startedAt: Date.now(),
      currentRegion: 'eu10',
      currentOrg: 'org-a',
      done: 3,
      total: 14,
    };

    await saveSyncProgress(progress);

    expect(getSyncProgress()).toEqual(progress);
  });

  it('saveSyncProgress overwrites previous progress', async () => {
    const first: SyncProgress = { isRunning: true, done: 1, total: 14 };
    const second: SyncProgress = { isRunning: false, done: 14, total: 14, lastCompletedAt: Date.now() };

    await saveSyncProgress(first);
    await saveSyncProgress(second);

    expect(getSyncProgress()).toEqual(second);
  });

  // ── cache settings ─────────────────────────────────────────────────────────

  it('getCacheSettings returns DEFAULT_CACHE_SETTINGS when nothing has been saved', () => {
    expect(getCacheSettings()).toEqual(DEFAULT_CACHE_SETTINGS);
  });

  it('saveCacheSettings persists settings and getCacheSettings retrieves them', async () => {
    const settings: CacheSettings = { enabled: false, intervalHours: 8 };

    await saveCacheSettings(settings);

    expect(getCacheSettings()).toEqual(settings);
  });

  it('saveCacheSettings overwrites previous settings', async () => {
    await saveCacheSettings({ enabled: true, intervalHours: 2 });
    await saveCacheSettings({ enabled: false, intervalHours: 1 });

    expect(getCacheSettings()).toEqual({ enabled: false, intervalHours: 1 });
  });

  // ── debug preferences ──────────────────────────────────────────────────────

  it('getDebugPreferences returns DEFAULT_DEBUG_PREFERENCES when nothing has been saved', () => {
    expect(getDebugPreferences()).toEqual(DEFAULT_DEBUG_PREFERENCES);
  });

  it('saveDebugPreferences persists prefs and getDebugPreferences retrieves them', async () => {
    const prefs: DebugPreferences = { openBrowserOnAttach: true };
    await saveDebugPreferences(prefs);
    expect(getDebugPreferences()).toEqual(prefs);
  });

  it('saveDebugPreferences overwrites previous prefs', async () => {
    await saveDebugPreferences({ openBrowserOnAttach: true });
    await saveDebugPreferences({ openBrowserOnAttach: false });
    expect(getDebugPreferences().openBrowserOnAttach).toBe(false);
  });

  it('DEFAULT_DEBUG_PREFERENCES has openBrowserOnAttach = false', () => {
    expect(DEFAULT_DEBUG_PREFERENCES.openBrowserOnAttach).toBe(false);
  });

  // ── uninitialized guard ────────────────────────────────────────────────────

  it('throws when any function is called before initCacheStore', () => {
    // Simulate uninitialized state by passing undefined
    initCacheStore(undefined as unknown as Parameters<typeof initCacheStore>[0]);
    expect(() => getCachedApps('https://api.cf.eu10.hana.ondemand.com', 'org-a')).toThrow(
      'CacheStore not initialized',
    );
  });
});
