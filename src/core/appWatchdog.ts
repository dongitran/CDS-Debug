import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';

// App Watchdog: a debug session that ends without proper cleanup (crashed window,
// dropped tunnel, missed setBreakpoints([])) can leave breakpoints armed inside the
// remote CF app — the next tester who hits that code path freezes the whole app.
// Every app started through "Start Debug Sessions" is recorded in a registry file
// shared across VS Code windows, and its mapped route is pinged on an interval.
// While a route stops answering, a status bar warning points at the stuck apps.

export interface WatchedAppEntry {
  appName: string;
  org: string;
  space: string;
  /** Region code (e.g. `eu10`) or the API endpoint host when no code could be derived. */
  region: string;
  /** Fully-qualified https URL of the app's mapped route. */
  url: string;
  /** Epoch ms when the debug session was started — the watch window counts from here. */
  startedAt: number;
  /**
   * Extension-host pid of the VS Code window that started the debug session.
   * While that process is alive, it is the one responsible for checking the app
   * (it alone knows whether a debug session is still intentionally pausing it);
   * once it dies — the crash scenario this watchdog exists for — any window
   * takes over. `0` means "owner unknown", treated as a dead owner.
   */
  ownerPid: number;
}

/** Registration input — the watchdog stamps the current process as owner. */
export type WatchedAppRegistration = Omit<WatchedAppEntry, 'ownerPid'>;

export type AppPingOutcome =
  | { ok: true; status: number }
  | { ok: false; kind: 'timeout' | 'gateway' | 'network'; reason: string };

/**
 * Why a watched app currently is or is not being pinged by this window:
 * - `monitoring`: this window pings the route on the configured interval.
 * - `debug-in-progress`: a live debug session for the app exists in this window —
 *   pauses are expected (the developer may sit on a breakpoint), so checks and
 *   failure counting are suspended until the session ends.
 * - `other-window`: a different, still-alive VS Code window owns the entry and
 *   performs the checks; alerting from here would double-report (and this window
 *   cannot see that window's active sessions).
 */
export type WatchedAppMonitorState = 'monitoring' | 'debug-in-progress' | 'other-window';

export interface WatchedAppStatus extends WatchedAppEntry {
  key: string;
  expiresAt: number;
  monitorState: WatchedAppMonitorState;
  consecutiveFailures: number;
  unresponsive: boolean;
  lastCheckedAt?: number;
  lastOutcome?: AppPingOutcome;
}

export interface AppWatchdogSnapshot {
  enabled: boolean;
  pingIntervalSeconds: number;
  watchDurationHours: number;
  apps: WatchedAppStatus[];
  unresponsiveCount: number;
}

export interface AppWatchdogConfigValues {
  enabled: boolean;
  pingIntervalSeconds: number;
  watchDurationHours: number;
}

export type WatchdogPingFn = (url: string, timeoutMs: number) => Promise<AppPingOutcome>;

export interface InitializeAppWatchdogOptions {
  storageDir?: string;
  ping?: WatchdogPingFn;
  now?: () => number;
  /** Returns true while this window has a live debug session for the app. */
  isAppActivelyDebugged?: (appName: string) => boolean;
  isProcessAlive?: (pid: number) => boolean;
}

const WATCH_FILE_NAME = 'watched-apps.json';
const CONFIG_SECTION = 'cdsDebug';
export const SHOW_APP_WATCHDOG_COMMAND = 'cdsDebug.showAppWatchdog';
export const DEFAULT_PING_INTERVAL_SECONDS = 90;
export const DEFAULT_WATCH_DURATION_HOURS = 8;
export const PING_INTERVAL_BOUNDS = { min: 60, max: 600 } as const;
const WATCH_DURATION_BOUNDS = { min: 1, max: 72 } as const;
const MAX_PING_TIMEOUT_MS = 10_000;
const MIN_PING_TIMEOUT_MS = 2_000;
// One failed ping can be a network blip; two in a row is a stronger signal the
// event loop is parked on a breakpoint.
export const UNRESPONSIVE_AFTER_FAILURES = 2;

interface RuntimeCheckState {
  consecutiveFailures: number;
  lastCheckedAt?: number;
  lastOutcome?: AppPingOutcome;
}

export const appWatchdogEvents = new EventEmitter();
export const WATCHDOG_CHANGED_EVENT = 'changed';

let initialized = false;
let storageDir = defaultWatchdogStorageDir();
let pingFn: WatchdogPingFn = pingAppUrl;
let nowFn: () => number = Date.now;
let isActivelyDebuggedFn: (appName: string) => boolean = () => false;
let isProcessAliveFn: (pid: number) => boolean = isProcessAlive;
let timer: ReturnType<typeof setInterval> | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let configListener: vscode.Disposable | undefined;
let sweepInFlight: Promise<void> | undefined;
let lastSnapshot: AppWatchdogSnapshot = emptySnapshot();
const runtimeStates = new Map<string, RuntimeCheckState>();

export function defaultWatchdogStorageDir(): string {
  // ~/.cds-debug on every platform: on Windows os.homedir() resolves to
  // C:\Users\<name>, which is always writable by the current user.
  return join(homedir(), '.cds-debug');
}

function emptySnapshot(): AppWatchdogSnapshot {
  return {
    enabled: true,
    pingIntervalSeconds: DEFAULT_PING_INTERVAL_SECONDS,
    watchDurationHours: DEFAULT_WATCH_DURATION_HOURS,
    apps: [],
    unresponsiveCount: 0,
  };
}

export function getAppWatchdogConfig(): AppWatchdogConfigValues {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: config.get<boolean>('appWatchdog.enabled') ?? true,
    pingIntervalSeconds: clampNumber(
      config.get<number>('appWatchdog.pingIntervalSeconds'),
      PING_INTERVAL_BOUNDS.min,
      PING_INTERVAL_BOUNDS.max,
      DEFAULT_PING_INTERVAL_SECONDS,
    ),
    watchDurationHours: clampNumber(
      config.get<number>('appWatchdog.watchDurationHours'),
      WATCH_DURATION_BOUNDS.min,
      WATCH_DURATION_BOUNDS.max,
      DEFAULT_WATCH_DURATION_HOURS,
    ),
  };
}

export function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function watchedAppKey(entry: Pick<WatchedAppEntry, 'region' | 'org' | 'space' | 'appName'>): string {
  return JSON.stringify([entry.region, entry.org, entry.space, entry.appName]);
}

/** Routes from `cf apps` / cf-sync are bare hosts; CF routes are always TLS-terminated. */
export function normalizeRouteUrl(route: string): string {
  const trimmed = route.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function initializeAppWatchdog(options: InitializeAppWatchdogOptions = {}): void {
  initialized = true;
  storageDir = options.storageDir ?? defaultWatchdogStorageDir();
  pingFn = options.ping ?? pingAppUrl;
  nowFn = options.now ?? Date.now;
  isActivelyDebuggedFn = options.isAppActivelyDebugged ?? ((): boolean => false);
  isProcessAliveFn = options.isProcessAlive ?? isProcessAlive;

  if (statusBarItem === undefined) {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    statusBarItem.name = 'CDS Debug App Watchdog';
    statusBarItem.command = SHOW_APP_WATCHDOG_COMMAND;
  }

  configListener ??= vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('cdsDebug.appWatchdog')) return;
    restartTimer();
    void sweepWatchedApps().catch(logSweepFailure);
  });

  restartTimer();
  // Resume monitoring of entries left behind by a previous window/crash right away.
  void sweepWatchedApps().catch(logSweepFailure);
}

export function disposeAppWatchdog(): void {
  initialized = false;
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  configListener?.dispose();
  configListener = undefined;
  statusBarItem?.dispose();
  statusBarItem = undefined;
  runtimeStates.clear();
  appWatchdogEvents.removeAllListeners();
  lastSnapshot = emptySnapshot();
  sweepInFlight = undefined;
  storageDir = defaultWatchdogStorageDir();
  pingFn = pingAppUrl;
  nowFn = Date.now;
  isActivelyDebuggedFn = (): boolean => false;
  isProcessAliveFn = isProcessAlive;
}

export function isAppWatchdogInitialized(): boolean {
  return initialized;
}

/** Records the given apps in the shared registry and checks them immediately. */
export async function registerWatchedApps(registrations: WatchedAppRegistration[]): Promise<void> {
  if (!initialized || registrations.length === 0) return;
  const entries: WatchedAppEntry[] = registrations.map((item) => ({ ...item, ownerPid: process.pid }));
  const config = getAppWatchdogConfig();
  const ttlMs = config.watchDurationHours * 3_600_000;
  const now = nowFn();
  const newKeys = new Set(entries.map(watchedAppKey));

  const existing = await readWatchedEntries();
  const kept = existing.filter((item) => !newKeys.has(watchedAppKey(item)) && now - item.startedAt <= ttlMs);
  await writeWatchedEntries([...kept, ...entries]);

  for (const entry of entries) {
    // A fresh debug session restarts both the watch window and failure counting.
    runtimeStates.delete(watchedAppKey(entry));
    logInfo(
      `[AppWatchdog] Watching ${entry.appName} (${entry.region}/${entry.org}/${entry.space}) at ${entry.url} `
      + `for the next ${config.watchDurationHours.toString()}h.`,
    );
  }

  restartTimer();
  // An in-flight sweep may have read the registry before the write above —
  // wait it out so the follow-up pass is guaranteed to include the new entries.
  if (sweepInFlight !== undefined) await sweepInFlight.catch(() => undefined);
  await sweepWatchedApps();
}

export async function stopWatchingApp(key: string): Promise<void> {
  if (!initialized) return;
  const existing = await readWatchedEntries();
  const next = existing.filter((item) => watchedAppKey(item) !== key);
  if (next.length !== existing.length) {
    await writeWatchedEntries(next);
    logInfo(`[AppWatchdog] Stopped watching ${key}.`);
  }
  runtimeStates.delete(key);
  publishSnapshot(buildSnapshot(getAppWatchdogConfig(), next, computeMonitorStates(next)));
}

export function getWatchdogSnapshot(): AppWatchdogSnapshot {
  return lastSnapshot;
}

/** Prunes expired entries, pings the live ones, and publishes a fresh snapshot. */
export function sweepWatchedApps(): Promise<void> {
  if (!initialized) return Promise.resolve();
  // Concurrent triggers (timer + manual "Check now" + register) share one pass.
  sweepInFlight ??= doSweep().finally(() => {
    sweepInFlight = undefined;
  });
  return sweepInFlight;
}

async function doSweep(): Promise<void> {
  const config = getAppWatchdogConfig();
  const live = await pruneExpiredEntries(config);

  const liveKeys = new Set(live.map(watchedAppKey));
  for (const key of [...runtimeStates.keys()]) {
    if (!liveKeys.has(key)) runtimeStates.delete(key);
  }

  const monitorStates = computeMonitorStates(live);
  for (const entry of live) {
    // While the developer is intentionally debugging here, pauses are expected —
    // drop any failure streak so counting starts fresh once the session ends.
    if (monitorStates.get(watchedAppKey(entry)) === 'debug-in-progress') {
      runtimeStates.delete(watchedAppKey(entry));
    }
  }

  if (config.enabled) {
    const checkable = live.filter((entry) => monitorStates.get(watchedAppKey(entry)) === 'monitoring');
    await Promise.all(checkable.map((entry) => checkEntry(entry, config)));
  }

  publishSnapshot(buildSnapshot(config, live, monitorStates));
}

function computeMonitorStates(entries: WatchedAppEntry[]): Map<string, WatchedAppMonitorState> {
  return new Map(entries.map((entry) => [watchedAppKey(entry), monitorStateFor(entry)]));
}

function monitorStateFor(entry: WatchedAppEntry): WatchedAppMonitorState {
  // A registry entry owned by another *live* window is that window's job — only
  // it can tell whether its own debug session is still pausing the app. A dead
  // owner (crashed/force-killed window) is exactly when this window takes over.
  if (entry.ownerPid > 0 && entry.ownerPid !== process.pid && isProcessAliveFn(entry.ownerPid)) {
    return 'other-window';
  }
  return isActivelyDebuggedFn(entry.appName) ? 'debug-in-progress' : 'monitoring';
}

async function pruneExpiredEntries(config: AppWatchdogConfigValues): Promise<WatchedAppEntry[]> {
  const all = await readWatchedEntries();
  const ttlMs = config.watchDurationHours * 3_600_000;
  const now = nowFn();
  const live = all.filter((entry) => now - entry.startedAt <= ttlMs);
  if (live.length !== all.length) {
    await writeWatchedEntries(live).catch((err: unknown) => {
      logWarn(`[AppWatchdog] Failed to prune expired entries: ${errorMessage(err)}`);
    });
    logInfo(`[AppWatchdog] ${(all.length - live.length).toString()} app(s) passed the ${config.watchDurationHours.toString()}h watch window and were removed.`);
  }
  return live;
}

async function checkEntry(entry: WatchedAppEntry, config: AppWatchdogConfigValues): Promise<void> {
  // Stay under the sweep cadence so checks never stack up.
  const timeoutMs = clampNumber(
    config.pingIntervalSeconds * 1000 - 1000,
    MIN_PING_TIMEOUT_MS,
    MAX_PING_TIMEOUT_MS,
    MAX_PING_TIMEOUT_MS,
  );
  const outcome = await pingFn(entry.url, timeoutMs);
  const key = watchedAppKey(entry);
  const previousFailures = runtimeStates.get(key)?.consecutiveFailures ?? 0;
  const consecutiveFailures = outcome.ok ? 0 : previousFailures + 1;
  runtimeStates.set(key, { consecutiveFailures, lastCheckedAt: nowFn(), lastOutcome: outcome });

  if (!outcome.ok) {
    logWarn(`[AppWatchdog] ${entry.appName} (${entry.region}/${entry.org}/${entry.space}) did not respond (${consecutiveFailures.toString()}x): ${outcome.reason}`);
  } else if (previousFailures >= UNRESPONSIVE_AFTER_FAILURES) {
    logInfo(`[AppWatchdog] ${entry.appName} is responding again (HTTP ${outcome.status.toString()}).`);
  }
}

function buildSnapshot(
  config: AppWatchdogConfigValues,
  entries: WatchedAppEntry[],
  monitorStates: Map<string, WatchedAppMonitorState>,
): AppWatchdogSnapshot {
  const apps = entries
    .map((entry) => buildAppStatus(entry, config, monitorStates))
    .sort((left, right) => {
      if (left.unresponsive !== right.unresponsive) return left.unresponsive ? -1 : 1;
      return left.appName.localeCompare(right.appName);
    });
  return {
    enabled: config.enabled,
    pingIntervalSeconds: config.pingIntervalSeconds,
    watchDurationHours: config.watchDurationHours,
    apps,
    unresponsiveCount: apps.filter((app) => app.unresponsive).length,
  };
}

function buildAppStatus(
  entry: WatchedAppEntry,
  config: AppWatchdogConfigValues,
  monitorStates: Map<string, WatchedAppMonitorState>,
): WatchedAppStatus {
  const key = watchedAppKey(entry);
  const runtime = runtimeStates.get(key);
  const monitorState = monitorStates.get(key) ?? 'monitoring';
  const consecutiveFailures = runtime?.consecutiveFailures ?? 0;
  return {
    ...entry,
    key,
    expiresAt: entry.startedAt + config.watchDurationHours * 3_600_000,
    monitorState,
    consecutiveFailures,
    // `config.enabled` matters here: with checks off there is nothing left to
    // ever clear a stale failure streak, so a disabled watchdog must not keep
    // the status bar warning alive.
    unresponsive: config.enabled && monitorState === 'monitoring' && consecutiveFailures >= UNRESPONSIVE_AFTER_FAILURES,
    ...(runtime?.lastCheckedAt !== undefined ? { lastCheckedAt: runtime.lastCheckedAt } : {}),
    ...(runtime?.lastOutcome !== undefined ? { lastOutcome: runtime.lastOutcome } : {}),
  };
}

function publishSnapshot(snapshot: AppWatchdogSnapshot): void {
  lastSnapshot = snapshot;
  updateStatusBar(snapshot);
  appWatchdogEvents.emit(WATCHDOG_CHANGED_EVENT, snapshot);
}

function updateStatusBar(snapshot: AppWatchdogSnapshot): void {
  const item = statusBarItem;
  if (item === undefined) return;
  if (snapshot.unresponsiveCount === 0) {
    item.hide();
    return;
  }
  const names = snapshot.apps.filter((app) => app.unresponsive).map((app) => app.appName);
  const plural = snapshot.unresponsiveCount === 1 ? 'app is' : 'apps are';
  item.text = `$(debug-disconnect) CDS Debug: ${snapshot.unresponsiveCount.toString()} ${plural} not responding`;
  item.tooltip = `Not responding: ${names.join(', ')}\nLikely paused at a leftover breakpoint. Click for details.`;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  item.show();
}

function restartTimer(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  const config = getAppWatchdogConfig();
  if (!config.enabled) return;
  timer = setInterval(() => {
    void sweepWatchedApps().catch(logSweepFailure);
  }, config.pingIntervalSeconds * 1000);
}

function logSweepFailure(err: unknown): void {
  logWarn(`[AppWatchdog] Sweep failed: ${errorMessage(err)}`);
}

// ---------------------------------------------------------------------------
// Ping
// ---------------------------------------------------------------------------

/**
 * Liveness is "did the Node event loop produce an HTTP response", not "was the
 * response successful": 401/404/500 from the app all prove it is running.
 * 502/503/504 are produced by the CF gorouter itself when the app container does
 * not answer — the exact signature of a process frozen on a breakpoint.
 */
export function classifyHttpStatus(status: number): AppPingOutcome {
  if (status === 502 || status === 503 || status === 504) {
    return { ok: false, kind: 'gateway', reason: `HTTP ${status.toString()} — the gateway reports the app is not responding` };
  }
  return { ok: true, status };
}

export async function pingAppUrl(url: string, timeoutMs: number): Promise<AppPingOutcome> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      // A redirect already proves the event loop is alive — don't follow it.
      redirect: 'manual',
      headers: { accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Free the connection without downloading the body.
    await response.body?.cancel().catch(() => undefined);
    return classifyHttpStatus(response.status);
  } catch (err: unknown) {
    if (isTimeoutError(err)) {
      const seconds = (timeoutMs / 1000).toFixed(0);
      return { ok: false, kind: 'timeout', reason: `No response within ${seconds}s — likely paused at a breakpoint` };
    }
    return { ok: false, kind: 'network', reason: errorMessage(err) };
  }
}

function isTimeoutError(err: unknown): boolean {
  // AbortSignal.timeout rejects with a DOMException, which is not an Error
  // instance on every Node version — match on the name instead.
  if (typeof err !== 'object' || err === null || !('name' in err)) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // undici wraps network failures in TypeError("fetch failed") with the real
    // cause (ENOTFOUND, ECONNREFUSED, …) attached.
    const cause = err.cause;
    if (cause instanceof Error && cause.message.length > 0) return `${err.message}: ${cause.message}`;
    return err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Registry file
// ---------------------------------------------------------------------------

function watchFilePath(): string {
  return join(storageDir, WATCH_FILE_NAME);
}

// Corruption is treated as "start from empty" everywhere: the worst case of a
// lost registry is missing pings, never a destructive action (cf. TunnelReaper,
// where the conservative path matters because it kills processes).
async function readWatchedEntries(): Promise<WatchedAppEntry[]> {
  try {
    const raw = await readFile(watchFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => parseWatchedEntry(item));
  } catch (err: unknown) {
    if (!isFileMissingError(err)) {
      logWarn(`[AppWatchdog] Watch registry unreadable; starting from empty. ${errorMessage(err)}`);
    }
    return [];
  }
}

function parseWatchedEntry(value: unknown): WatchedAppEntry[] {
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.appName !== 'string' || record.appName.length === 0) return [];
  if (typeof record.org !== 'string' || typeof record.space !== 'string' || typeof record.region !== 'string') return [];
  if (typeof record.url !== 'string' || !/^https?:\/\//i.test(record.url)) return [];
  if (typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt) || record.startedAt <= 0) return [];
  const ownerPid = typeof record.ownerPid === 'number' && Number.isInteger(record.ownerPid) && record.ownerPid > 0
    ? record.ownerPid
    : 0; // unknown owner — treated as dead so this window monitors the app
  return [{
    appName: record.appName,
    org: record.org,
    space: record.space,
    region: record.region,
    url: record.url,
    startedAt: record.startedAt,
    ownerPid,
  }];
}

async function writeWatchedEntries(entries: WatchedAppEntry[]): Promise<void> {
  await mkdir(storageDir, { recursive: true });
  const target = watchFilePath();
  const tmp = `${target}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  await rename(tmp, target).catch(async (err: unknown) => {
    await unlink(tmp).catch(() => undefined);
    throw err;
  });
}

function isFileMissingError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
