import * as vscode from 'vscode';
import type {
  CacheSettings,
  CfApp,
  CfRegionCache,
  DebugPreferences,
  DebugSessionPackagePreferences,
  SyncProgress,
} from '../types/index';
import {
  DEFAULT_CACHE_SETTINGS,
  DEFAULT_DEBUG_PREFERENCES,
  DEFAULT_DEBUG_SESSION_PACKAGE_PREFERENCES,
} from '../types/index';

const CACHE_KEY = 'cds-debug.appCache';
const SYNC_KEY = 'cds-debug.syncProgress';
const SETTINGS_KEY = 'cds-debug.cacheSettings';
const DEBUG_PREFS_KEY = 'cds-debug.debugPrefs';
const DEBUG_SESSION_PACKAGE_PREFS_KEY = 'cds-debug.debugSessionPackagePrefs';
const SPACE_REFRESH_KEY = 'cds-debug.lastSpaceRefreshAt';

let _context: vscode.ExtensionContext | undefined;

export function initCacheStore(context: vscode.ExtensionContext): void {
  _context = context;
}

function ctx(): vscode.ExtensionContext {
  if (_context === undefined) throw new Error('CacheStore not initialized.');
  return _context;
}

type CacheMap = Record<string, CfRegionCache>;
type SpaceRefreshMap = Record<string, number>;

function readCacheMap(): CacheMap {
  return ctx().globalState.get<CacheMap>(CACHE_KEY) ?? {};
}

export function getCachedApps(
  apiEndpoint: string,
  org: string,
  space?: string,
): { apps: CfApp[]; cachedAt: number } | undefined {
  return readCacheMap()[apiEndpoint]?.appsByOrg[cacheTargetKey(org, space)];
}

export async function saveCachedApps(
  apiEndpoint: string,
  org: string,
  apps: CfApp[],
  space?: string,
): Promise<void> {
  const map = readCacheMap();
  const entry = map[apiEndpoint] ?? { apiEndpoint, orgs: [], appsByOrg: {}, lastSyncedAt: 0 };
  entry.appsByOrg[cacheTargetKey(org, space)] = { apps, cachedAt: Date.now() };
  map[apiEndpoint] = entry;
  await ctx().globalState.update(CACHE_KEY, map);
}

function cacheTargetKey(org: string, space: string | undefined): string {
  return space === undefined ? org : JSON.stringify([org, space]);
}

function spaceRefreshKey(apiEndpoint: string, org: string, space: string): string {
  return JSON.stringify([apiEndpoint, org, space]);
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

export function getLastSpaceRefreshAt(
  apiEndpoint: string,
  org: string,
  space: string,
): number | undefined {
  const map = ctx().globalState.get<SpaceRefreshMap>(SPACE_REFRESH_KEY) ?? {};
  return map[spaceRefreshKey(apiEndpoint, org, space)];
}

export async function saveLastSpaceRefreshAt(
  apiEndpoint: string,
  org: string,
  space: string,
): Promise<void> {
  const map = ctx().globalState.get<SpaceRefreshMap>(SPACE_REFRESH_KEY) ?? {};
  map[spaceRefreshKey(apiEndpoint, org, space)] = Date.now();
  await ctx().globalState.update(SPACE_REFRESH_KEY, map);
}

function readDebugPreferences(value: unknown): Partial<DebugPreferences> {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const parsed: Partial<DebugPreferences> = {};
  if (typeof record.openBrowserOnAttach === 'boolean') {
    parsed.openBrowserOnAttach = record.openBrowserOnAttach;
  }
  if (typeof record.enableBranchPrep === 'boolean') {
    parsed.enableBranchPrep = record.enableBranchPrep;
  }
  if (typeof record.enableBreakpointSnapshotHandling === 'boolean') {
    parsed.enableBreakpointSnapshotHandling = record.enableBreakpointSnapshotHandling;
  }
  return parsed;
}

export function getDebugPreferences(): DebugPreferences {
  const stored = ctx().globalState.get<unknown>(DEBUG_PREFS_KEY);
  return {
    ...DEFAULT_DEBUG_PREFERENCES,
    ...readDebugPreferences(stored),
  };
}

export async function saveDebugPreferences(prefs: DebugPreferences): Promise<void> {
  const normalized: DebugPreferences = {
    ...DEFAULT_DEBUG_PREFERENCES,
    ...readDebugPreferences(prefs),
  };
  await ctx().globalState.update(DEBUG_PREFS_KEY, normalized);
}

function readDebugSessionPackagePreferences(value: unknown): Partial<DebugSessionPackagePreferences> {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const parsed: Partial<DebugSessionPackagePreferences> = {};
  if (typeof record.packageNameFilterRegex === 'string') {
    parsed.packageNameFilterRegex = record.packageNameFilterRegex;
  }
  return parsed;
}

export function getDebugSessionPackagePreferences(): DebugSessionPackagePreferences {
  const stored = ctx().globalState.get<unknown>(DEBUG_SESSION_PACKAGE_PREFS_KEY);
  const prefs = {
    ...DEFAULT_DEBUG_SESSION_PACKAGE_PREFERENCES,
    ...readDebugSessionPackagePreferences(stored),
  };

  const config = vscode.workspace.getConfiguration('cdsDebug');
  const inspect = config.inspect<string>('packageRegexFilter');
  
  const lastVsCodeValue = ctx().globalState.get<string>('cdsDebug.lastVsCodePackageRegexFilter');
  const currentVsCodeValue = inspect?.workspaceValue ?? inspect?.globalValue ?? '';

  // If the VS Code setting changed from outside since our last sync, take it.
  if (currentVsCodeValue !== lastVsCodeValue) {
    void ctx().globalState.update('cdsDebug.lastVsCodePackageRegexFilter', currentVsCodeValue);
    
    // Only take it if it was actually explicitly set in workspace or user settings
    if (inspect?.workspaceValue !== undefined || inspect?.globalValue !== undefined) {
      prefs.packageNameFilterRegex = currentVsCodeValue;
      void saveDebugSessionPackagePreferences(prefs, true);
    }
  }

  return prefs;
}

export async function saveDebugSessionPackagePreferences(
  prefs: DebugSessionPackagePreferences,
  skipVsCodeSync = false
): Promise<void> {
  const normalized: DebugSessionPackagePreferences = {
    ...DEFAULT_DEBUG_SESSION_PACKAGE_PREFERENCES,
    ...readDebugSessionPackagePreferences(prefs),
  };
  await ctx().globalState.update(DEBUG_SESSION_PACKAGE_PREFS_KEY, normalized);

  if (!skipVsCodeSync) {
    const config = vscode.workspace.getConfiguration('cdsDebug');
    const inspect = config.inspect<string>('packageRegexFilter');

    if (inspect?.workspaceValue !== undefined) {
      await config.update('packageRegexFilter', normalized.packageNameFilterRegex, vscode.ConfigurationTarget.Workspace);
      await ctx().globalState.update('cdsDebug.lastVsCodePackageRegexFilter', normalized.packageNameFilterRegex);
    } else if (inspect?.globalValue !== undefined) {
      await config.update('packageRegexFilter', normalized.packageNameFilterRegex, vscode.ConfigurationTarget.Global);
      await ctx().globalState.update('cdsDebug.lastVsCodePackageRegexFilter', normalized.packageNameFilterRegex);
    }
  }
}
