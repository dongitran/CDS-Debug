import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { cfLogin, cfOrgs, cfTarget, cfApps } from './cfClient';
import { saveCachedApps, saveCachedOrgs, getSyncProgress, saveSyncProgress, getCacheSettings } from '../storage/cacheStore';
import { logInfo, logWarn, logError } from './logger';
import type { SyncProgress } from '../types/index';

// Regions scanned sequentially. Order: most-likely-used first to populate cache quickly.
const SCAN_REGIONS = [
  { code: 'eu10', name: 'Europe (Frankfurt)' },
  { code: 'eu20', name: 'Europe (Amsterdam)' },
  { code: 'us10', name: 'US East (VA)' },
  { code: 'us20', name: 'US West (WA)' },
  { code: 'ap10', name: 'Australia (Sydney)' },
  { code: 'ap11', name: 'Singapore' },
  { code: 'br10', name: 'Brazil (São Paulo)' },
  { code: 'ca10', name: 'Canada (Montreal)' },
] as const;

export const cacheSyncEvents = new EventEmitter();

const INITIAL_DELAY_MS = 5_000;

function syncIntervalMs(): number {
  return getCacheSettings().syncIntervalHours * 60 * 60 * 1000;
}

// Isolated CF config dir for background sync so it does not disturb the user's
// interactive CF session stored in the default ~/.cf directory.
const SYNC_CF_HOME = path.join(os.tmpdir(), 'cds-debug-sync');

// Object wrapper prevents TypeScript/ESLint from narrowing these booleans as literal
// false — property access is not subject to control-flow narrowing, so checks like
// `if (shouldAbort())` remain valid even after an assignment to false earlier.
const _sync = { isSyncing: false, abortRequested: false };
let _timer: ReturnType<typeof setInterval> | undefined;

function pushStatus(progress: SyncProgress): void {
  cacheSyncEvents.emit('progress', progress);
}

// Indirection makes the return type boolean (not narrowed to false), preventing
// the lint rule from flagging abort checks as always-false inside doSync().
// disposeCacheSync() sets _sync.abortRequested=true across an async boundary.
function shouldAbort(): boolean {
  return _sync.abortRequested;
}

async function doSync(): Promise<void> {
  if (_sync.isSyncing) {
    logInfo('[CacheSync] Already running — skipping duplicate trigger.');
    return;
  }

  if (!getCacheSettings().enabled) {
    logInfo('[CacheSync] Cache sync disabled in settings — skipping.');
    return;
  }

  const email = process.env.SAP_EMAIL ?? '';
  const password = process.env.SAP_PASSWORD ?? '';
  if (!email || !password) {
    logWarn('[CacheSync] SAP_EMAIL/SAP_PASSWORD not set — skipping background sync.');
    return;
  }

  _sync.isSyncing = true;
  _sync.abortRequested = false;

  const total = SCAN_REGIONS.length;
  const startedAt = Date.now();
  let progress: SyncProgress = { isRunning: true, startedAt, done: 0, total };

  await saveSyncProgress(progress);
  pushStatus(progress);
  logInfo(`[CacheSync] Starting sync across ${total.toString()} regions…`);

  let aborted = false;
  for (const region of SCAN_REGIONS) {
    if (shouldAbort()) {
      logInfo('[CacheSync] Abort requested — stopping early.');
      aborted = true;
      break;
    }

    const endpoint = `https://api.cf.${region.code}.hana.ondemand.com`;
    progress = { ...progress, currentRegion: region.code, currentOrg: undefined };
    pushStatus(progress);
    logInfo(`[CacheSync] Scanning ${region.code} (${region.name})…`);

    try {
      await cfLogin(endpoint, email, password, SYNC_CF_HOME);
      const orgs = await cfOrgs(SYNC_CF_HOME);
      await saveCachedOrgs(endpoint, orgs);
      logInfo(`[CacheSync] ${region.code}: ${orgs.length.toString()} org(s) found.`);

      for (const org of orgs) {
        if (shouldAbort()) break;

        progress = { ...progress, currentOrg: org };
        pushStatus(progress);

        try {
          await cfTarget(org, undefined, SYNC_CF_HOME);
          const apps = await cfApps(SYNC_CF_HOME);
          await saveCachedApps(endpoint, org, apps);
          logInfo(`[CacheSync] ${region.code}/${org}: ${apps.length.toString()} app(s) cached.`);
        } catch (err: unknown) {
          logWarn(
            `[CacheSync] ${region.code}/${org}: apps fetch failed — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err: unknown) {
      logWarn(
        `[CacheSync] ${region.code}: login failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    progress = { ...progress, done: progress.done + 1, currentOrg: undefined };
    await saveSyncProgress(progress);
    pushStatus(progress);
  }

  // Only record lastCompletedAt when all regions were scanned. An aborted sync
  // must not update this timestamp — otherwise initCacheSync() would think the
  // cache is fresh on the next VS Code start and skip the auto-run.
  const final: SyncProgress = aborted
    ? { isRunning: false, startedAt, done: progress.done, total }
    : { isRunning: false, startedAt, lastCompletedAt: Date.now(), done: progress.done, total };
  await saveSyncProgress(final);
  pushStatus(final);
  _sync.isSyncing = false;
  logInfo(`[CacheSync] Sync complete — ${progress.done.toString()}/${total.toString()} regions.`);
}

export function runCacheSync(): void {
  void doSync().catch((err: unknown) => {
    _sync.isSyncing = false;
    logError(`[CacheSync] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    void saveSyncProgress({ isRunning: false, done: 0, total: SCAN_REGIONS.length });
    pushStatus({ isRunning: false, done: 0, total: SCAN_REGIONS.length });
  });
}

export function getCurrentSyncProgress(): SyncProgress {
  return getSyncProgress() ?? { isRunning: _sync.isSyncing, done: 0, total: SCAN_REGIONS.length };
}

export function initCacheSync(): void {
  // Ensure the isolated CF config directory exists before the first sync run.
  try {
    fs.mkdirSync(SYNC_CF_HOME, { recursive: true });
  } catch {
    // Ignore — if this fails, cfLogin will fail gracefully and log a warning.
  }

  // If VS Code was shut down while a sync was in progress, the persisted flag
  // will still say isRunning=true. Reset it so the next run starts cleanly.
  const prev = getSyncProgress();
  if (prev?.isRunning) {
    logInfo('[CacheSync] Previous sync was interrupted (VS Code shutdown) — resetting flag.');
    void saveSyncProgress({ ...prev, isRunning: false });
  }

  const intervalMs = syncIntervalMs();
  const lastCompleted = prev?.lastCompletedAt ?? 0;
  if (Date.now() - lastCompleted >= intervalMs) {
    // Cache is stale (or never populated). Run after a short delay so activation
    // finishes first and the extension is fully ready before CF CLI is invoked.
    setTimeout(() => { runCacheSync(); }, INITIAL_DELAY_MS);
  }

  // Recurring sync on configured interval.
  _timer = setInterval(() => { runCacheSync(); }, intervalMs);
}

// Called after the user saves cache settings. Restarts the periodic timer with the
// new interval. When the user disables caching, also signals any in-progress sync
// to abort at the next checkpoint — doSync() will not update lastCompletedAt so
// the next VS Code start correctly treats the cache as stale.
export function restartCacheSyncTimer(): void {
  if (_timer !== undefined) {
    clearInterval(_timer);
    _timer = undefined;
  }
  const settings = getCacheSettings();
  if (!settings.enabled) {
    // Abort the running sync if there is one. doSync() checks shouldAbort()
    // between orgs and resets _sync.abortRequested = false at its next start,
    // so re-enabling later works without any extra reset here.
    _sync.abortRequested = true;
    return;
  }
  _timer = setInterval(() => { runCacheSync(); }, settings.syncIntervalHours * 60 * 60 * 1000);
}

export function disposeCacheSync(): void {
  // Signal the running loop to exit at the next abort-check point.
  _sync.abortRequested = true;
  if (_timer !== undefined) {
    clearInterval(_timer);
    _timer = undefined;
  }
}
