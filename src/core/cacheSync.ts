import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  writeStructure,
  initializeRuntimeState,
  mergeRuntimeRegion,
  completeRuntimeState,
  failRuntimeState,
  persistRegion,
  tryAcquireSyncLock,
  releaseSyncLock,
  cfApi,
  cfAuth,
  cfOrgs,
  cfSpaces,
  cfTargetOrg,
  cfTargetSpace,
  cfAppDetails,
  getAllRegions,
  cfStructurePath,
} from '@saptools/cf-sync';
import type {
  AppNode,
  CfExecContext,
  CfStructure,
  OrgNode,
  Region,
  RegionKey,
  RegionNode,
  SpaceNode,
} from '@saptools/cf-sync';
import { getCredentials } from './shellEnv';
import {
  saveCachedApps,
  saveCachedOrgs,
  getSyncProgress,
  saveSyncProgress,
  getCacheSettings,
} from '../storage/cacheStore';
import type { SyncProgress, SyncSkipReason } from '../types/index';
import { toCachedApp } from './appNodeMapping';
import { logInfo, logWarn, logError } from './logger';

export const cacheSyncEvents = new EventEmitter();

const INITIAL_DELAY_MS = 5_000;

// Tracks in-process sync state. Object wrapper prevents TypeScript control-flow
// narrowing from treating the booleans as literal false after assignment.
const _sync = { isSyncing: false, abortRequested: false };
let _timer: ReturnType<typeof setInterval> | undefined;

function syncIntervalMs(): number {
  return getCacheSettings().intervalHours * 60 * 60 * 1000;
}

function pushStatus(progress: SyncProgress): void {
  cacheSyncEvents.emit('progress', progress);
}

function withLastCompleted(progress: SyncProgress, lastCompletedAt: number | undefined): SyncProgress {
  return lastCompletedAt === undefined ? progress : { ...progress, lastCompletedAt };
}

function buildRunningProgress(
  startedAt: number,
  lastAttemptedAt: number,
  done: number,
  total: number,
  lastCompletedAt: number | undefined,
  currentRegion?: string,
  currentOrg?: string,
): SyncProgress {
  return withLastCompleted({
    isRunning: true,
    startedAt,
    lastAttemptedAt,
    done,
    total,
    currentRegion,
    currentOrg,
  }, lastCompletedAt);
}

function buildSkippedProgress(
  reason: SyncSkipReason,
  total: number,
  lastCompletedAt: number | undefined,
  startedAt?: number,
  done = 0,
): SyncProgress {
  const progress: SyncProgress = {
    isRunning: false,
    lastAttemptedAt: Date.now(),
    lastSkipReason: reason,
    done,
    total,
  };
  if (startedAt !== undefined) progress.startedAt = startedAt;
  return withLastCompleted(progress, lastCompletedAt);
}

// Indirection prevents TypeScript from narrowing _sync.abortRequested as always-false.
function shouldAbort(): boolean {
  return _sync.abortRequested;
}

// Read the cf-sync stable structure file synchronously (used at init time to avoid
// an async gap before the timer is wired up).
function readStructureSync(): CfStructure | undefined {
  try {
    const raw = fs.readFileSync(cfStructurePath(), 'utf8');
    return JSON.parse(raw) as CfStructure;
  } catch {
    return undefined;
  }
}

// Creates a fresh isolated CF home directory per sync session so background syncs
// never clobber the user's interactive ~/.cf session.
async function withCfSession<T>(work: (ctx: CfExecContext) => Promise<T>): Promise<T> {
  const cfHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cds-debug-cf-'));
  const ctx: CfExecContext = { env: { CF_HOME: cfHome } };
  try {
    return await work(ctx);
  } finally {
    await fsPromises.rm(cfHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildAccessibleRegionNode(
  region: Region,
  orgs: readonly OrgNode[],
  error?: string,
): RegionNode {
  const base: RegionNode = {
    key: region.key,
    label: region.label,
    apiEndpoint: region.apiEndpoint,
    accessible: true,
    orgs,
  };
  if (error !== undefined) {
    return { ...base, error };
  }
  return base;
}

function buildInaccessibleRegionNode(region: Region, error: string): RegionNode {
  return {
    key: region.key,
    label: region.label,
    apiEndpoint: region.apiEndpoint,
    accessible: false,
    orgs: [],
    error,
  };
}

function buildOrgNode(name: string, spaces: readonly SpaceNode[], error?: string): OrgNode {
  if (error !== undefined) {
    return { name, spaces, error };
  }
  return { name, spaces };
}

function buildSpaceNode(name: string, apps: readonly AppNode[], error?: string): SpaceNode {
  if (error !== undefined) {
    return { name, apps, error };
  }
  return { name, apps };
}

async function collectSpace(
  regionKey: string,
  orgName: string,
  spaceName: string,
  ctx: CfExecContext,
): Promise<SpaceNode> {
  try {
    await cfTargetSpace(orgName, spaceName, ctx);
    const apps = await cfAppDetails(ctx);
    return buildSpaceNode(spaceName, apps);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`[CacheSync] ${regionKey}/${orgName}/${spaceName}: apps fetch failed — ${message}`);
    return buildSpaceNode(spaceName, [], message);
  }
}

async function collectOrg(
  regionKey: string,
  orgName: string,
  ctx: CfExecContext,
): Promise<OrgNode> {
  try {
    await cfTargetOrg(orgName, ctx);
    const spaceNames = await cfSpaces(ctx);
    const spaces: SpaceNode[] = [];
    for (const spaceName of spaceNames) {
      if (shouldAbort()) break;
      spaces.push(await collectSpace(regionKey, orgName, spaceName, ctx));
    }
    return buildOrgNode(orgName, spaces);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`[CacheSync] ${regionKey}/${orgName}: org collection failed — ${message}`);
    return buildOrgNode(orgName, [], message);
  }
}

async function collectRegion(
  region: Region,
  email: string,
  password: string,
  onOrgProgress: (orgName: string) => void,
): Promise<RegionNode> {
  return await withCfSession(async (ctx) => {
    try {
      await cfApi(region.apiEndpoint, ctx);
      await cfAuth(email, password, ctx);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[CacheSync] ${region.key}: auth failed — ${message}`);
      return buildInaccessibleRegionNode(region, message);
    }

    let orgNames: readonly string[];
    try {
      orgNames = await cfOrgs(ctx);
      logInfo(`[CacheSync] ${region.key}: ${orgNames.length.toString()} org(s) found.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[CacheSync] ${region.key}: orgs fetch failed — ${message}`);
      return buildAccessibleRegionNode(region, [], message);
    }

    const orgs: OrgNode[] = [];
    for (const orgName of orgNames) {
      if (shouldAbort()) break;
      onOrgProgress(orgName);
      orgs.push(await collectOrg(region.key, orgName, ctx));
    }

    return buildAccessibleRegionNode(region, orgs);
  });
}

// Converts a completed cf-sync CfStructure into VS Code globalState app cache entries.
// Each space is cached independently because app names and states can differ by space.
export async function populateCacheFromStructure(structure: CfStructure): Promise<void> {
  for (const region of structure.regions) {
    if (!region.accessible) continue;
    const orgNames = region.orgs.map((o) => o.name);
    await saveCachedOrgs(region.apiEndpoint, orgNames);

    for (const org of region.orgs) {
      if (org.spaces.length === 0) {
        await saveCachedApps(region.apiEndpoint, org.name, []);
        continue;
      }
      for (const space of org.spaces) {
        await saveCachedApps(region.apiEndpoint, org.name, space.apps.map(toCachedApp), space.name);
      }
    }
  }
}

export type SingleRegionSyncResult =
  | { status: 'synced' }
  | { status: 'failed'; error: string }
  | { status: 'skipped' };

export async function syncSingleRegion(
  regionKey: RegionKey,
  email: string,
  password: string,
): Promise<SingleRegionSyncResult> {
  if (_sync.isSyncing) {
    logInfo(`[CacheSync] Single-region warmup skipped for ${regionKey}: full sync is running.`);
    return { status: 'skipped' };
  }

  const region = getAllRegions().find((candidate) => candidate.key === regionKey);
  if (!region) return { status: 'failed', error: 'unknown-region' };

  try {
    logInfo(`[CacheSync] Single-region warmup: ${regionKey}…`);
    const node = await collectRegion(region, email, password, () => undefined);
    await persistRegion(node);
    await populateCacheFromStructure({ syncedAt: new Date().toISOString(), regions: [node] });
    logInfo(`[CacheSync] ${regionKey} warmed up — ${node.orgs.length.toString()} org(s).`);
    cacheSyncEvents.emit('regionWarmed', { regionKey });
    return { status: 'synced' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`[CacheSync] Single-region warmup failed for ${regionKey}: ${message}`);
    return { status: 'failed', error: message };
  }
}

async function doSync(): Promise<void> {
  if (_sync.isSyncing) {
    logInfo('[CacheSync] Already running — skipping duplicate trigger.');
    return;
  }

  if (!getCacheSettings().enabled) {
    logInfo('[CacheSync] Cache sync disabled — skipping.');
    const skipped = buildSkippedProgress('cache-disabled', getAllRegions().length, getSyncProgress()?.lastCompletedAt);
    await saveSyncProgress(skipped);
    pushStatus(skipped);
    return;
  }

  const { email, password } = await getCredentials();
  if (!email || !password) {
    logWarn('[CacheSync] SAP credentials not set — skipping background sync.');
    const skipped = buildSkippedProgress('no-credentials', getAllRegions().length, getSyncProgress()?.lastCompletedAt);
    await saveSyncProgress(skipped);
    pushStatus(skipped);
    return;
  }

  _sync.isSyncing = true;
  _sync.abortRequested = false;

  const regions = getAllRegions();
  const total = regions.length;
  const startedAt = Date.now();
  const lastAttemptedAt = startedAt;
  const previousLastCompletedAt = getSyncProgress()?.lastCompletedAt;
  const syncId = randomUUID();
  const regionKeys = regions.map((r) => r.key);

  let progress = buildRunningProgress(startedAt, lastAttemptedAt, 0, total, previousLastCompletedAt);
  await saveSyncProgress(progress);
  pushStatus(progress);

  logInfo(`[CacheSync] Starting sync across ${total.toString()} regions using cf-sync…`);

  let lockHandle: Awaited<ReturnType<typeof tryAcquireSyncLock>> = undefined;

  try {
    lockHandle = await tryAcquireSyncLock(syncId);
    if (!lockHandle) {
      logInfo('[CacheSync] Another sync process holds the lock — skipping.');
      const final = buildSkippedProgress('lock-contention', total, previousLastCompletedAt, startedAt);
      await saveSyncProgress(final);
      pushStatus(final);
      _sync.isSyncing = false;
      return;
    }

    await initializeRuntimeState(syncId, regionKeys);

    let done = 0;
    let aborted = false;

    for (const region of regions) {
      if (shouldAbort()) {
        aborted = true;
        break;
      }

      progress = buildRunningProgress(
        startedAt,
        lastAttemptedAt,
        done,
        total,
        previousLastCompletedAt,
        region.key,
      );
      pushStatus(progress);
      logInfo(`[CacheSync] Scanning ${region.key} (${region.label})…`);

      const node = await collectRegion(region, email, password, (orgName) => {
        pushStatus(buildRunningProgress(
          startedAt,
          lastAttemptedAt,
          done,
          total,
          previousLastCompletedAt,
          region.key,
          orgName,
        ));
      });

      await mergeRuntimeRegion(syncId, regionKeys, node);

      done++;
      progress = buildRunningProgress(startedAt, lastAttemptedAt, done, total, previousLastCompletedAt);
      await saveSyncProgress(progress);
      pushStatus(progress);
    }

    if (aborted) {
      await failRuntimeState(syncId, 'aborted').catch(() => undefined);
      const final = buildSkippedProgress('aborted', total, previousLastCompletedAt, startedAt, done);
      await saveSyncProgress(final);
      pushStatus(final);
      logInfo('[CacheSync] Sync aborted.');
    } else {
      const completedState = await completeRuntimeState(syncId);
      await writeStructure(completedState.structure);
      await populateCacheFromStructure(completedState.structure);

      const final: SyncProgress = {
        isRunning: false,
        startedAt,
        lastCompletedAt: Date.now(),
        lastAttemptedAt,
        done,
        total,
      };
      await saveSyncProgress(final);
      pushStatus(final);
      logInfo(`[CacheSync] Sync complete — ${done.toString()}/${total.toString()} regions.`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await failRuntimeState(syncId, message).catch(() => undefined);
    const final = buildSkippedProgress('fatal-error', total, previousLastCompletedAt, startedAt);
    await saveSyncProgress(final);
    pushStatus(final);
    throw err;
  } finally {
    if (lockHandle !== undefined) {
      await releaseSyncLock(lockHandle).catch(() => undefined);
    }
    _sync.isSyncing = false;
  }
}

export function runCacheSync(): void {
  void doSync().catch((err: unknown) => {
    _sync.isSyncing = false;
    const message = err instanceof Error ? err.message : String(err);
    logError(`[CacheSync] Fatal error: ${message}`);
    const total = getAllRegions().length;
    const final = buildSkippedProgress('fatal-error', total, getSyncProgress()?.lastCompletedAt);
    void saveSyncProgress(final);
    pushStatus(final);
  });
}

export function getCurrentSyncProgress(): SyncProgress {
  return getSyncProgress() ?? { isRunning: _sync.isSyncing, done: 0, total: getAllRegions().length };
}

export function initCacheSync(): void {
  // Reset stale isRunning flag from a previous session that was interrupted (VS Code crash).
  const prev = getSyncProgress();
  if (prev?.isRunning) {
    logInfo('[CacheSync] Previous sync was interrupted — resetting flag.');
    void saveSyncProgress({ ...prev, isRunning: false });
  }

  // If a cf-sync structure already exists on disk (e.g. written by the cf-sync CLI or a
  // previous VS Code session), populate VS Code globalState immediately so the extension
  // can serve app lists before the next background sync completes.
  const existingStructure = readStructureSync();
  if (existingStructure) {
    void populateCacheFromStructure(existingStructure).then(() => {
      logInfo('[CacheSync] Loaded existing cf-sync structure from ~/.saptools/.');
    });
  }

  if (!getCacheSettings().enabled) {
    logInfo('[CacheSync] Background sync is disabled — skipping timer setup.');
    return;
  }

  const intervalMs = syncIntervalMs();

  // Determine staleness: prefer the cf-sync structure timestamp (shared across tools)
  // over VS Code globalState, since the CLI may have run a fresh sync more recently.
  let lastCompleted = prev?.lastCompletedAt ?? 0;
  if (existingStructure) {
    const structureTime = new Date(existingStructure.syncedAt).getTime();
    if (structureTime > lastCompleted) {
      lastCompleted = structureTime;
    }
  }

  if (Date.now() - lastCompleted >= intervalMs) {
    setTimeout(() => { runCacheSync(); }, INITIAL_DELAY_MS);
  }

  _timer = setInterval(() => { runCacheSync(); }, intervalMs);
}

// Called when the user changes cache settings. Restarts the periodic timer with the
// new interval, and triggers an immediate sync if the cache is stale under the new settings.
export function restartCacheSyncTimer(): void {
  if (_timer !== undefined) {
    clearInterval(_timer);
    _timer = undefined;
  }

  const settings = getCacheSettings();
  if (!settings.enabled) {
    _sync.abortRequested = true;
    return;
  }

  _sync.abortRequested = false;
  const intervalMs = settings.intervalHours * 60 * 60 * 1000;
  _timer = setInterval(() => { runCacheSync(); }, intervalMs);

  const prev = getSyncProgress();
  let lastCompleted = prev?.lastCompletedAt ?? 0;
  const existingStructure = readStructureSync();
  if (existingStructure) {
    const structureTime = new Date(existingStructure.syncedAt).getTime();
    if (structureTime > lastCompleted) {
      lastCompleted = structureTime;
    }
  }

  if (Date.now() - lastCompleted >= intervalMs) {
    setTimeout(() => { runCacheSync(); }, INITIAL_DELAY_MS);
  }
}

export function disposeCacheSync(): void {
  _sync.abortRequested = true;
  if (_timer !== undefined) {
    clearInterval(_timer);
    _timer = undefined;
  }
}
