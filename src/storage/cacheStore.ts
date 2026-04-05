import type * as vscode from 'vscode';
import type { CacheSettings, CfApp, CfRegionCache, SyncProgress } from '../types/index';
import { DEFAULT_CACHE_SETTINGS } from '../types/index';

const CACHE_KEY = 'cds-debug.appCache';
const SYNC_KEY = 'cds-debug.syncProgress';
const SETTINGS_KEY = 'cds-debug.cacheSettings';

let _context: vscode.ExtensionContext | undefined;

export function initCacheStore(context: vscode.ExtensionContext): void {
  _context = context;
}

function ctx(): vscode.ExtensionContext {
  if (_context === undefined) throw new Error('CacheStore not initialized.');
  return _context;
}

type CacheMap = Record<string, CfRegionCache>;

function readCacheMap(): CacheMap {
  return ctx().globalState.get<CacheMap>(CACHE_KEY) ?? {};
}

export function getCachedApps(
  apiEndpoint: string,
  org: string,
): { apps: CfApp[]; cachedAt: number } | undefined {
  return readCacheMap()[apiEndpoint]?.appsByOrg[org];
}

export async function saveCachedApps(apiEndpoint: string, org: string, apps: CfApp[]): Promise<void> {
  const map = readCacheMap();
  const entry = map[apiEndpoint] ?? { apiEndpoint, orgs: [], appsByOrg: {}, lastSyncedAt: 0 };
  entry.appsByOrg[org] = { apps, cachedAt: Date.now() };
  map[apiEndpoint] = entry;
  await ctx().globalState.update(CACHE_KEY, map);
}

export async function saveCachedOrgs(apiEndpoint: string, orgs: string[]): Promise<void> {
  const map = readCacheMap();
  const entry = map[apiEndpoint] ?? { apiEndpoint, orgs: [], appsByOrg: {}, lastSyncedAt: 0 };
  entry.orgs = orgs;
  map[apiEndpoint] = entry;
  await ctx().globalState.update(CACHE_KEY, map);
}

export function getSyncProgress(): SyncProgress | undefined {
  return ctx().globalState.get<SyncProgress>(SYNC_KEY);
}

export async function saveSyncProgress(progress: SyncProgress): Promise<void> {
  await ctx().globalState.update(SYNC_KEY, progress);
}

export function getCacheSettings(): CacheSettings {
  return ctx().globalState.get<CacheSettings>(SETTINGS_KEY) ?? { ...DEFAULT_CACHE_SETTINGS };
}

export async function saveCacheSettings(settings: CacheSettings): Promise<void> {
  await ctx().globalState.update(SETTINGS_KEY, settings);
}
