import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appWatchdogEvents,
  classifyHttpStatus,
  clampNumber,
  disposeAppWatchdog,
  getAppWatchdogConfig,
  getWatchdogSnapshot,
  initializeAppWatchdog,
  normalizeRouteUrl,
  pingAppUrl,
  registerWatchedApps,
  stopWatchingApp,
  sweepWatchedApps,
  watchedAppKey,
  WATCHDOG_CHANGED_EVENT,
  type AppPingOutcome,
  type WatchedAppEntry,
  type WatchedAppRegistration,
} from '../../src/core/appWatchdog';

const harness = vi.hoisted(() => {
  const statusBarItem = {
    text: '',
    tooltip: '',
    name: '',
    command: undefined as string | undefined,
    backgroundColor: undefined as unknown,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
  const configValues = new Map<string, unknown>();
  const listeners: ((event: { affectsConfiguration: (section: string) => boolean }) => void)[] = [];
  return { statusBarItem, configValues, listeners };
});

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
    createStatusBarItem: () => harness.statusBarItem,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => harness.configValues.get(key),
    }),
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration: (section: string) => boolean }) => void) => {
      harness.listeners.push(listener);
      return { dispose: () => undefined };
    },
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class {
    constructor(public readonly id: string) {}
  },
}));

function entryFor(appName: string, overrides: Partial<WatchedAppRegistration> = {}): WatchedAppRegistration {
  return {
    appName,
    org: 'demo-org',
    space: 'app',
    region: 'eu10',
    url: `https://${appName}.cfapps.eu10.hana.ondemand.com`,
    startedAt: Date.now(),
    ...overrides,
  };
}

const okOutcome: AppPingOutcome = { ok: true, status: 200 };
const timeoutOutcome: AppPingOutcome = { ok: false, kind: 'timeout', reason: 'No response within 10s' };

let storageDir: string;

async function readRegistry(): Promise<unknown> {
  const raw = await readFile(join(storageDir, 'watched-apps.json'), 'utf8');
  return JSON.parse(raw) as unknown;
}

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'cds-watchdog-'));
  harness.configValues.clear();
  harness.statusBarItem.show.mockClear();
  harness.statusBarItem.hide.mockClear();
  harness.statusBarItem.dispose.mockClear();
  harness.statusBarItem.text = '';
  harness.statusBarItem.backgroundColor = undefined;
  harness.listeners.length = 0;
});

afterEach(async () => {
  disposeAppWatchdog();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await rm(storageDir, { recursive: true, force: true });
});

describe('classifyHttpStatus', () => {
  it('treats any app-produced status as alive', () => {
    expect(classifyHttpStatus(200)).toEqual({ ok: true, status: 200 });
    expect(classifyHttpStatus(401)).toEqual({ ok: true, status: 401 });
    expect(classifyHttpStatus(404)).toEqual({ ok: true, status: 404 });
    expect(classifyHttpStatus(500)).toEqual({ ok: true, status: 500 });
  });

  it('treats gateway statuses as not responding', () => {
    for (const status of [502, 503, 504]) {
      const outcome = classifyHttpStatus(status);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe('gateway');
    }
  });
});

describe('normalizeRouteUrl', () => {
  it('prefixes bare route hosts with https', () => {
    expect(normalizeRouteUrl('my-app.cfapps.eu10.hana.ondemand.com')).toBe('https://my-app.cfapps.eu10.hana.ondemand.com');
  });

  it('keeps explicit schemes untouched', () => {
    expect(normalizeRouteUrl('http://localhost:4004')).toBe('http://localhost:4004');
    expect(normalizeRouteUrl(' https://a.example.com ')).toBe('https://a.example.com');
  });
});

describe('clampNumber', () => {
  it('clamps to bounds and falls back for non-numbers', () => {
    expect(clampNumber(5, 10, 600, 30)).toBe(10);
    expect(clampNumber(10_000, 10, 600, 30)).toBe(600);
    expect(clampNumber(45, 10, 600, 30)).toBe(45);
    expect(clampNumber(undefined, 10, 600, 30)).toBe(30);
    expect(clampNumber(Number.NaN, 10, 600, 30)).toBe(30);
  });
});

describe('getAppWatchdogConfig', () => {
  it('returns defaults when nothing is configured', () => {
    expect(getAppWatchdogConfig()).toEqual({
      enabled: true,
      pingIntervalSeconds: 30,
      watchDurationHours: 8,
    });
  });

  it('reads and clamps configured values', () => {
    harness.configValues.set('appWatchdog.enabled', false);
    harness.configValues.set('appWatchdog.pingIntervalSeconds', 5);
    harness.configValues.set('appWatchdog.watchDurationHours', 100);
    expect(getAppWatchdogConfig()).toEqual({
      enabled: false,
      pingIntervalSeconds: 10,
      watchDurationHours: 72,
    });
  });
});

describe('registerWatchedApps + sweep', () => {
  it('persists entries to the registry file and pings them', async () => {
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a'), entryFor('srv-b')]);

    expect(ping).toHaveBeenCalledWith('https://srv-a.cfapps.eu10.hana.ondemand.com', expect.any(Number));
    const registry = await readRegistry();
    expect(Array.isArray(registry)).toBe(true);
    expect((registry as WatchedAppEntry[]).map((e) => e.appName).sort()).toEqual(['srv-a', 'srv-b']);

    const snapshot = getWatchdogSnapshot();
    expect(snapshot.apps).toHaveLength(2);
    expect(snapshot.unresponsiveCount).toBe(0);
    expect(snapshot.apps.every((app) => !app.unresponsive)).toBe(true);
  });

  it('replaces an existing entry with the same key and resets its failure count', async () => {
    const ping = vi.fn().mockResolvedValue(timeoutOutcome);
    const firstStart = Date.now() - 5_000;
    const secondStart = Date.now();
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a', { startedAt: firstStart })]);
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().apps[0]?.consecutiveFailures).toBeGreaterThanOrEqual(2);

    ping.mockResolvedValue(okOutcome);
    await registerWatchedApps([entryFor('srv-a', { startedAt: secondStart })]);
    const registry = (await readRegistry()) as WatchedAppEntry[];
    expect(registry).toHaveLength(1);
    expect(registry[0]?.startedAt).toBe(secondStart);
    expect(getWatchdogSnapshot().apps[0]?.consecutiveFailures).toBe(0);
  });

  it('marks an app unresponsive only after two consecutive failures and shows the status bar', async () => {
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a')]);
    expect(getWatchdogSnapshot().unresponsiveCount).toBe(0);

    ping.mockResolvedValue(timeoutOutcome);
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().unresponsiveCount).toBe(0);
    expect(getWatchdogSnapshot().apps[0]?.consecutiveFailures).toBe(1);

    await sweepWatchedApps();
    const snapshot = getWatchdogSnapshot();
    expect(snapshot.unresponsiveCount).toBe(1);
    expect(snapshot.apps[0]?.unresponsive).toBe(true);
    expect(harness.statusBarItem.show).toHaveBeenCalled();
    expect(harness.statusBarItem.text).toContain('1 app is not responding');

    ping.mockResolvedValue(okOutcome);
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().unresponsiveCount).toBe(0);
    expect(harness.statusBarItem.hide).toHaveBeenCalled();
  });

  it('emits a changed event with the snapshot on every sweep', async () => {
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    const events: unknown[] = [];
    appWatchdogEvents.on(WATCHDOG_CHANGED_EVENT, (snapshot) => events.push(snapshot));
    await registerWatchedApps([entryFor('srv-a')]);
    expect(events.length).toBeGreaterThan(0);
  });

  it('removes entries older than the watch window from the registry', async () => {
    const ping = vi.fn().mockResolvedValue(okOutcome);
    let now = Date.now();
    initializeAppWatchdog({ storageDir, ping, now: () => now });
    await registerWatchedApps([entryFor('srv-old', { startedAt: now }), entryFor('srv-new', { startedAt: now })]);

    now += 9 * 3_600_000; // default watch window is 8h
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().apps).toHaveLength(0);
    expect((await readRegistry()) as WatchedAppEntry[]).toHaveLength(0);
    expect(harness.statusBarItem.hide).toHaveBeenCalled();
  });

  it('does not ping when the watchdog is disabled but still lists watched apps', async () => {
    harness.configValues.set('appWatchdog.enabled', false);
    const ping = vi.fn().mockResolvedValue(timeoutOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a')]);

    expect(ping).not.toHaveBeenCalled();
    const snapshot = getWatchdogSnapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.apps).toHaveLength(1);
    expect(snapshot.unresponsiveCount).toBe(0);
  });

  it('clears the unresponsive alert when the watchdog gets disabled', async () => {
    const ping = vi.fn().mockResolvedValue(timeoutOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a')]);
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().unresponsiveCount).toBe(1);

    harness.configValues.set('appWatchdog.enabled', false);
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().unresponsiveCount).toBe(0);
    expect(harness.statusBarItem.hide).toHaveBeenCalled();
  });

  it('treats a corrupt registry file as empty without throwing', async () => {
    await writeFile(join(storageDir, 'watched-apps.json'), '{not json', 'utf8');
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().apps).toHaveLength(0);
  });

  it('skips malformed registry entries while keeping valid ones', async () => {
    const valid = entryFor('srv-a');
    const malformed = [
      null,
      { appName: '', org: 'o', space: 's', region: 'r', url: 'https://x.example', startedAt: 1 },
      { appName: 'x', org: 'o', space: 's', region: 'r', url: 'ftp://x.example', startedAt: 1 },
      { appName: 'x', org: 'o', space: 's', region: 'r', url: 'https://x.example', startedAt: -5 },
    ];
    await writeFile(join(storageDir, 'watched-apps.json'), JSON.stringify([valid, ...malformed]), 'utf8');
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().apps.map((app) => app.appName)).toEqual(['srv-a']);
  });
});

describe('active-debug and cross-window exclusion', () => {
  it('does not ping an app that has a live debug session in this window', async () => {
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping, isAppActivelyDebugged: (name) => name === 'srv-a' });
    await registerWatchedApps([entryFor('srv-a'), entryFor('srv-b')]);

    expect(ping).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledWith('https://srv-b.cfapps.eu10.hana.ondemand.com', expect.any(Number));
    const apps = getWatchdogSnapshot().apps;
    expect(apps.find((app) => app.appName === 'srv-a')?.monitorState).toBe('debug-in-progress');
    expect(apps.find((app) => app.appName === 'srv-b')?.monitorState).toBe('monitoring');
  });

  it('resumes pinging and resets the failure streak once the debug session ends', async () => {
    const activeApps = new Set<string>(['srv-a']);
    const ping = vi.fn().mockResolvedValue(timeoutOutcome);
    initializeAppWatchdog({ storageDir, ping, isAppActivelyDebugged: (name) => activeApps.has(name) });

    await registerWatchedApps([entryFor('srv-a')]);
    expect(ping).not.toHaveBeenCalled();

    // One failure recorded before the next session, then debugging suspends checks.
    activeApps.delete('srv-a');
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().apps[0]?.consecutiveFailures).toBe(1);

    activeApps.add('srv-a');
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().apps[0]?.monitorState).toBe('debug-in-progress');
    expect(getWatchdogSnapshot().apps[0]?.consecutiveFailures).toBe(0);
    expect(getWatchdogSnapshot().unresponsiveCount).toBe(0);

    // Session over: counting starts fresh — a single failure is not yet an alert.
    activeApps.delete('srv-a');
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().apps[0]?.consecutiveFailures).toBe(1);
    expect(getWatchdogSnapshot().unresponsiveCount).toBe(0);
    await sweepWatchedApps();
    expect(getWatchdogSnapshot().unresponsiveCount).toBe(1);
  });

  it('leaves entries owned by another live window to that window', async () => {
    const foreign = { ...entryFor('srv-foreign'), ownerPid: 99_999 };
    await writeFile(join(storageDir, 'watched-apps.json'), JSON.stringify([foreign]), 'utf8');
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping, isProcessAlive: () => true });
    await sweepWatchedApps();

    expect(ping).not.toHaveBeenCalled();
    expect(getWatchdogSnapshot().apps[0]?.monitorState).toBe('other-window');
    expect(getWatchdogSnapshot().unresponsiveCount).toBe(0);
  });

  it('takes over entries whose owner window died', async () => {
    const orphaned = { ...entryFor('srv-orphan'), ownerPid: 99_999 };
    await writeFile(join(storageDir, 'watched-apps.json'), JSON.stringify([orphaned]), 'utf8');
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping, isProcessAlive: () => false });
    await sweepWatchedApps();

    expect(ping).toHaveBeenCalledWith('https://srv-orphan.cfapps.eu10.hana.ondemand.com', expect.any(Number));
    expect(getWatchdogSnapshot().apps[0]?.monitorState).toBe('monitoring');
  });

  it('monitors entries without an owner pid (legacy or hand-edited registry)', async () => {
    const legacy = entryFor('srv-legacy');
    await writeFile(join(storageDir, 'watched-apps.json'), JSON.stringify([legacy]), 'utf8');
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping, isProcessAlive: () => true });
    await sweepWatchedApps();

    expect(ping).toHaveBeenCalledTimes(1);
    expect(getWatchdogSnapshot().apps[0]?.monitorState).toBe('monitoring');
  });

  it('stamps the current process as owner when registering', async () => {
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a')]);
    const registry = (await readRegistry()) as WatchedAppEntry[];
    expect(registry[0]?.ownerPid).toBe(process.pid);
  });

  it('is inert before initialization (no registry writes from stray calls)', async () => {
    await registerWatchedApps([entryFor('srv-a')]);
    await sweepWatchedApps();
    await expect(readRegistry()).rejects.toThrow();
  });
});

describe('stopWatchingApp', () => {
  it('removes the entry from the registry and publishes the change', async () => {
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a'), entryFor('srv-b')]);

    await stopWatchingApp(watchedAppKey(entryFor('srv-a')));
    expect(getWatchdogSnapshot().apps.map((app) => app.appName)).toEqual(['srv-b']);
    expect(((await readRegistry()) as WatchedAppEntry[]).map((e) => e.appName)).toEqual(['srv-b']);
  });
});

describe('timer scheduling', () => {
  // The sweep does real fs I/O, which fake timers cannot flush — wait for the
  // snapshot publication event to know a sweep actually completed.
  function nextSweepDone(): Promise<void> {
    return new Promise((resolve) => {
      appWatchdogEvents.once(WATCHDOG_CHANGED_EVENT, () => {
        resolve();
      });
    });
  }

  function fireConfigChange(affected = true): void {
    for (const listener of harness.listeners) {
      listener({ affectsConfiguration: (section) => affected && section === 'cdsDebug.appWatchdog' });
    }
  }

  it('sweeps on the configured interval', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a')]);
    ping.mockClear();

    let sweepDone = nextSweepDone();
    await vi.advanceTimersByTimeAsync(30_000);
    await sweepDone;
    expect(ping).toHaveBeenCalledTimes(1);

    sweepDone = nextSweepDone();
    await vi.advanceTimersByTimeAsync(30_000);
    await sweepDone;
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('restarts the timer when the watchdog configuration changes', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a')]);

    harness.configValues.set('appWatchdog.pingIntervalSeconds', 10);
    let sweepDone = nextSweepDone();
    fireConfigChange();
    await sweepDone; // the config handler triggers an immediate re-sweep
    ping.mockClear();

    sweepDone = nextSweepDone();
    await vi.advanceTimersByTimeAsync(10_000);
    await sweepDone;
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('stops pinging entirely once disabled via configuration change', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a')]);
    ping.mockClear();

    harness.configValues.set('appWatchdog.enabled', false);
    const sweepDone = nextSweepDone();
    fireConfigChange();
    await sweepDone;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ping).not.toHaveBeenCalled();
  });

  it('ignores configuration changes outside the watchdog section', async () => {
    vi.useFakeTimers();
    const ping = vi.fn().mockResolvedValue(okOutcome);
    initializeAppWatchdog({ storageDir, ping });
    await registerWatchedApps([entryFor('srv-a')]);
    ping.mockClear();

    fireConfigChange(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ping).not.toHaveBeenCalled();
  });
});

describe('pingAppUrl', () => {
  it('reports alive for an app-produced response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404, body: undefined }));
    expect(await pingAppUrl('https://x.example', 5000)).toEqual({ ok: true, status: 404 });
  });

  it('reports gateway failure for 502 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 502, body: undefined }));
    const outcome = await pingAppUrl('https://x.example', 5000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe('gateway');
  });

  it('classifies an aborted request as a timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue({ name: 'TimeoutError', message: 'aborted' }));
    const outcome = await pingAppUrl('https://x.example', 5000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('timeout');
      expect(outcome.reason).toContain('breakpoint');
    }
  });

  it('surfaces the undici cause for network failures', async () => {
    const error = new TypeError('fetch failed');
    (error as { cause?: Error }).cause = new Error('getaddrinfo ENOTFOUND x.example');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));
    const outcome = await pingAppUrl('https://x.example', 5000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe('network');
      expect(outcome.reason).toContain('ENOTFOUND');
    }
  });

  it('cancels the response body to free the connection', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, body: { cancel } }));
    await pingAppUrl('https://x.example', 5000);
    expect(cancel).toHaveBeenCalled();
  });
});
