import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CfClientModule from '../../src/core/cfClient';
import type * as CapDebugConfigModule from '../../src/core/capDebugConfig';
import type * as LaunchConfiguratorModule from '../../src/core/launchConfigurator';
import type * as ProcessManagerModule from '../../src/core/processManager';
import type { CapDebugConfig, DebugTarget, ExtensionMessage, OrgGroupMapping } from '../../src/types/index';

// Hoisted mocks ------------------------------------------------------------

const cfClientMock = vi.hoisted(() => ({
  cfFindRemotePackageJsonPaths: vi.fn<(appName: string) => Promise<string[]>>(
    () => Promise.resolve([]),
  ),
  cfTarget: vi.fn<(org: string, space?: string) => Promise<void>>(() => Promise.resolve()),
}));

const capDebugConfigMock = vi.hoisted(() => ({
  resolveSharedCapDebugConfig: vi.fn<() => Promise<CapDebugConfig | null>>(
    () => Promise.resolve(null),
  ),
  readCapDebugConfig: vi.fn<() => Promise<CapDebugConfig | null>>(
    () => Promise.resolve(null),
  ),
}));

const launchConfiguratorMock = vi.hoisted(() => ({
  getExistingLaunchConfigs: vi.fn<() => Promise<{ configurations: { name: string; port: number }[] }>>(
    () => Promise.resolve({ configurations: [] }),
  ),
  mergeLaunchJson: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

const folderScannerMock = vi.hoisted(() => ({
  findRepoFolder: vi.fn<(groupPath: string, candidate: string) => Promise<string | null>>(
    (groupPath, candidate) => Promise.resolve(`${groupPath}/${candidate}`),
  ),
}));

const cacheSyncMock = vi.hoisted(() => {
  const cacheSyncEvents = {
    on: vi.fn(() => cacheSyncEvents),
    emit: vi.fn(() => true),
  };
  return {
    cacheSyncEvents,
    getCurrentSyncProgress: vi.fn(() => ({ isRunning: false, done: 0, total: 0 })),
    requestCacheSyncStop: vi.fn(),
    restartCacheSyncTimer: vi.fn(),
    runCacheSync: vi.fn(),
    syncSingleRegion: vi.fn(() => Promise.resolve({ status: 'synced' as const })),
  };
});

const cfTopologyMock = vi.hoisted(() => ({
  getAppsFromTopologySync: vi.fn(() => undefined as unknown),
  getTopologySnapshot: vi.fn(() => Promise.resolve({ ready: false, accounts: [] })),
  getTopologySnapshotSync: vi.fn(() => ({ ready: false, accounts: [] })),
}));

const cfSpaceRefreshMock = vi.hoisted(() => ({
  refreshCfSyncRegionOrgs: vi.fn(() => Promise.resolve({ status: 'skipped' as const, reason: 'unknown-region' })),
  refreshCfSyncSpace: vi.fn(() => Promise.resolve({ status: 'skipped' as const, reason: 'unknown-region' })),
  resolveRegionKeyForEndpoint: vi.fn(() => 'eu10'),
}));

const loggerMock = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  showLogChannel: vi.fn(),
}));

const processManagerMock = vi.hoisted(() => {
  const debugProcessEvents = {
    on: vi.fn(() => debugProcessEvents),
    emit: vi.fn(() => true),
  };
  return {
    debugProcessEvents,
    getActiveAppNames: vi.fn<() => string[]>(() => []),
    getActiveSessions: vi.fn(() => ({})),
    getActiveDebugSessionForApp: vi.fn(() => undefined),
    getDebugSessionById: vi.fn(() => undefined),
    getDebugSessionsForApp: vi.fn(() => []),
    getProcessOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    getSessionParams: vi.fn(() => undefined),
    setBeforeReconnectHook: vi.fn(),
    stopAllProcesses: vi.fn(() => Promise.resolve()),
    stopProcess: vi.fn(() => Promise.resolve()),
    startTunnelAndAttach: vi.fn(() => Promise.resolve()),
  };
});

const breakpointSnapshotManagerMock = vi.hoisted(() => {
  const breakpointSnapshotEvents = {
    on: vi.fn(() => breakpointSnapshotEvents),
    emit: vi.fn(() => true),
  };
  return {
    breakpointSnapshotEvents,
    clearBreakpointSnapshots: vi.fn(),
    getBreakpointSnapshots: vi.fn(() => []),
  };
});

const shellEnvMock = vi.hoisted(() => ({
  clearCredentialsFromSecretStorage: vi.fn(() => Promise.resolve()),
  getCredentialSource: vi.fn(() => Promise.resolve('none' as const)),
  getCredentials: vi.fn(() => Promise.resolve({ email: '', password: '' })),
  maskEmail: vi.fn((email: string) => email),
  saveCredentialsToSecretStorage: vi.fn(() => Promise.resolve()),
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/sample/workspace' } }],
    getConfiguration: vi.fn(() => ({
      inspect: vi.fn(() => undefined),
      get: vi.fn((_key: string, fallback: unknown) => fallback),
    })),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, path: string) => ({ fsPath: `${base.fsPath}/${path}` }),
    parse: (value: string) => ({ toString: () => value }),
  },
  commands: { executeCommand: vi.fn() },
  env: { openExternal: vi.fn() },
  debug: { startDebugging: vi.fn(() => Promise.resolve(true)) },
}));

vi.mock('../../src/core/cfClient', async (importOriginal) => {
  const actual = await importOriginal<typeof CfClientModule>();
  return {
    ...actual,
    cfFindRemotePackageJsonPaths: cfClientMock.cfFindRemotePackageJsonPaths,
    cfTarget: cfClientMock.cfTarget,
  };
});

vi.mock('../../src/core/capDebugConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof CapDebugConfigModule>();
  return {
    ...actual,
    resolveSharedCapDebugConfig: capDebugConfigMock.resolveSharedCapDebugConfig,
  };
});

vi.mock('../../src/core/launchConfigurator', async (importOriginal) => {
  const actual = await importOriginal<typeof LaunchConfiguratorModule>();
  return {
    ...actual,
    getExistingLaunchConfigs: launchConfiguratorMock.getExistingLaunchConfigs,
    mergeLaunchJson: launchConfiguratorMock.mergeLaunchJson,
    readCapDebugConfig: capDebugConfigMock.readCapDebugConfig,
  };
});

vi.mock('../../src/core/folderScanner', () => folderScannerMock);

vi.mock('../../src/core/cacheSync', () => cacheSyncMock);
vi.mock('../../src/core/cfTopology', () => cfTopologyMock);
vi.mock('../../src/core/cfSpaceRefresh', () => cfSpaceRefreshMock);
vi.mock('../../src/core/logger', () => loggerMock);

vi.mock('../../src/core/processManager', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessManagerModule>();
  return {
    ...actual,
    debugProcessEvents: processManagerMock.debugProcessEvents,
    getActiveAppNames: processManagerMock.getActiveAppNames,
    getActiveSessions: processManagerMock.getActiveSessions,
    getActiveDebugSessionForApp: processManagerMock.getActiveDebugSessionForApp,
    getDebugSessionById: processManagerMock.getDebugSessionById,
    getDebugSessionsForApp: processManagerMock.getDebugSessionsForApp,
    getProcessOutputChannel: processManagerMock.getProcessOutputChannel,
    getSessionParams: processManagerMock.getSessionParams,
    setBeforeReconnectHook: processManagerMock.setBeforeReconnectHook,
    stopAllProcesses: processManagerMock.stopAllProcesses,
    stopProcess: processManagerMock.stopProcess,
    startTunnelAndAttach: processManagerMock.startTunnelAndAttach,
  };
});

vi.mock('../../src/core/breakpointSnapshotManager', () => breakpointSnapshotManagerMock);

vi.mock('../../src/core/shellEnv', () => shellEnvMock);

vi.mock('../../src/storage/scopeSync', () => ({
  writeScopeIfChanged: vi.fn(() => Promise.resolve()),
  buildCfApiEndpoint: (regionCode: string) => `https://api.cf.${regionCode}.hana.ondemand.com`,
  regionCodeFromApiEndpoint: () => 'eu10',
}));

// Imports after mocks ------------------------------------------------------

import { DebugLauncherViewProvider } from '../../src/webview/debugPanel';
import { initCacheStore, saveCacheSettings } from '../../src/storage/cacheStore';
import { initConfigStore, saveConfig } from '../../src/storage/configStore';

// Helpers ------------------------------------------------------------------

interface DebugPanelInternals {
  resolveRemoteRootsForTargets(
    targets: readonly DebugTarget[],
    apiEndpoint: string,
    org: string,
    space: string,
    fallbackConfig: CapDebugConfig | null,
  ): Promise<Map<string, string>>;
  handleStartDebug(appNames: string[], org: string, space: string): Promise<void>;
  handleLoadApps(org: string, space: string, forceRefresh?: boolean): Promise<void>;
  resolvedRemoteRoots: Map<string, string>;
  resolvedRemoteRootByApp: Map<string, string>;
}

function makeContext(): unknown {
  const store = new Map<string, unknown>();
  return {
    extensionUri: { fsPath: '/sample/extension' },
    subscriptions: [],
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

function makeProvider(): DebugLauncherViewProvider {
  return new DebugLauncherViewProvider(
    makeContext() as ConstructorParameters<typeof DebugLauncherViewProvider>[0],
  );
}

function getInternals(provider: DebugLauncherViewProvider): DebugPanelInternals {
  return provider as unknown as DebugPanelInternals;
}

const SAMPLE_API_ENDPOINT = 'https://api.cf.eu10.hana.ondemand.com';
const SAMPLE_ORG = 'sample-org-alpha';
const SAMPLE_SPACE = 'app';

function makeTarget(appName: string, folderPath: string): DebugTarget {
  return { appName, folderPath, port: 9229 };
}

function makeMapping(): OrgGroupMapping {
  return {
    cfOrg: SAMPLE_ORG,
    cfSpace: SAMPLE_SPACE,
    groupFolderPath: '/sample/group',
  };
}

async function saveProviderConfig(): Promise<void> {
  await saveConfig({
    apiEndpoint: SAMPLE_API_ENDPOINT,
    orgs: [SAMPLE_ORG],
    orgGroupMappings: [makeMapping()],
  });
}

beforeEach(async () => {
  initConfigStore(makeContext() as Parameters<typeof initConfigStore>[0]);
  initCacheStore(makeContext() as Parameters<typeof initCacheStore>[0]);
  await saveCacheSettings({ enabled: false, intervalHours: 24 });
  cfClientMock.cfFindRemotePackageJsonPaths.mockReset().mockResolvedValue([]);
  cfClientMock.cfTarget.mockReset().mockResolvedValue(undefined);
  capDebugConfigMock.resolveSharedCapDebugConfig.mockReset().mockResolvedValue(null);
  capDebugConfigMock.readCapDebugConfig.mockReset().mockResolvedValue(null);
  launchConfiguratorMock.getExistingLaunchConfigs.mockReset().mockResolvedValue({ configurations: [] });
  launchConfiguratorMock.mergeLaunchJson.mockReset().mockResolvedValue(undefined);
  cfTopologyMock.getAppsFromTopologySync.mockReset().mockReturnValue(undefined);
  processManagerMock.startTunnelAndAttach.mockReset().mockResolvedValue(undefined);
  loggerMock.logInfo.mockReset();
  loggerMock.logWarn.mockReset();
  loggerMock.logError.mockReset();
});

// Tests --------------------------------------------------------------------

describe('DebugLauncherViewProvider — lazy remote-root resolution', () => {
  it('probes all selected targets in parallel, not sequentially', async () => {
    const provider = makeProvider();
    const internals = getInternals(provider);

    let activeProbes = 0;
    let maxActiveProbes = 0;
    cfClientMock.cfFindRemotePackageJsonPaths.mockImplementation(async (appName: string) => {
      activeProbes += 1;
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      activeProbes -= 1;
      return [`/usr/${appName}/package.json`];
    });

    const targets: DebugTarget[] = [
      makeTarget('demo-service-a', '/sample/group/demo-service-a'),
      makeTarget('demo-service-b', '/sample/group/demo-service-b'),
      makeTarget('demo-service-c', '/sample/group/demo-service-c'),
      makeTarget('demo-service-d', '/sample/group/demo-service-d'),
    ];

    const fallbackConfig: CapDebugConfig = { remoteRoot: 'regex:^/usr/demo-service-[a-z]$' };
    const resolved = await internals.resolveRemoteRootsForTargets(
      targets,
      SAMPLE_API_ENDPOINT,
      SAMPLE_ORG,
      SAMPLE_SPACE,
      fallbackConfig,
    );

    expect(maxActiveProbes).toBe(4);
    expect(cfClientMock.cfFindRemotePackageJsonPaths).toHaveBeenCalledTimes(4);
    expect(resolved.size).toBe(4);
    for (const target of targets) {
      expect(resolved.get(target.appName)).toBe(`/usr/${target.appName}`);
    }
  });

  it('reuses cached remote-root resolutions on a second Start Debug for the same app', async () => {
    const provider = makeProvider();
    const internals = getInternals(provider);
    cfClientMock.cfFindRemotePackageJsonPaths.mockResolvedValue(['/usr/demo-service-a/package.json']);
    const fallbackConfig: CapDebugConfig = { remoteRoot: 'regex:^/usr/demo-service-a$' };
    const target = makeTarget('demo-service-a', '/sample/group/demo-service-a');

    await internals.resolveRemoteRootsForTargets([target], SAMPLE_API_ENDPOINT, SAMPLE_ORG, SAMPLE_SPACE, fallbackConfig);
    expect(cfClientMock.cfFindRemotePackageJsonPaths).toHaveBeenCalledTimes(1);

    const resolvedAgain = await internals.resolveRemoteRootsForTargets(
      [target],
      SAMPLE_API_ENDPOINT,
      SAMPLE_ORG,
      SAMPLE_SPACE,
      fallbackConfig,
    );
    expect(cfClientMock.cfFindRemotePackageJsonPaths).toHaveBeenCalledTimes(1);
    expect(resolvedAgain.get('demo-service-a')).toBe('/usr/demo-service-a');
  });

  it('does not invoke cfFindRemotePackageJsonPaths after handleLoadApps alone', async () => {
    const provider = makeProvider();
    const internals = getInternals(provider);
    vi.spyOn(provider, 'postMessage').mockImplementation(() => undefined);
    await saveProviderConfig();
    cfTopologyMock.getAppsFromTopologySync.mockReturnValue([
      { name: 'demo-service-a', state: 'started', urls: [] },
      { name: 'demo-service-b', state: 'started', urls: [] },
    ]);

    await internals.handleLoadApps(SAMPLE_ORG, SAMPLE_SPACE);
    // Give any microtasks a chance to flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(cfClientMock.cfFindRemotePackageJsonPaths).not.toHaveBeenCalled();
  });

  it('returns an empty map and posts nothing when no target needs probing', async () => {
    const provider = makeProvider();
    const internals = getInternals(provider);
    const target = makeTarget('demo-service-a', '/sample/group/demo-service-a');

    // No fallback config and no per-service config — remoteRoot is unset.
    const resolved = await internals.resolveRemoteRootsForTargets(
      [target],
      SAMPLE_API_ENDPOINT,
      SAMPLE_ORG,
      SAMPLE_SPACE,
      null,
    );

    expect(resolved.size).toBe(0);
    expect(cfClientMock.cfFindRemotePackageJsonPaths).not.toHaveBeenCalled();
  });

  it('continues resolving other targets when one probe rejects', async () => {
    const provider = makeProvider();
    const internals = getInternals(provider);
    cfClientMock.cfFindRemotePackageJsonPaths.mockImplementation((appName: string) => {
      if (appName === 'demo-service-broken') return Promise.reject(new Error('mock cf ssh failure'));
      return Promise.resolve([`/usr/${appName}/package.json`]);
    });
    const fallbackConfig: CapDebugConfig = { remoteRoot: 'regex:^/usr/demo-service-[a-z\\-]+$' };
    const targets: DebugTarget[] = [
      makeTarget('demo-service-a', '/sample/group/demo-service-a'),
      makeTarget('demo-service-broken', '/sample/group/demo-service-broken'),
      makeTarget('demo-service-b', '/sample/group/demo-service-b'),
    ];

    const resolved = await internals.resolveRemoteRootsForTargets(
      targets,
      SAMPLE_API_ENDPOINT,
      SAMPLE_ORG,
      SAMPLE_SPACE,
      fallbackConfig,
    );

    expect(resolved.size).toBe(2);
    expect(resolved.get('demo-service-a')).toBe('/usr/demo-service-a');
    expect(resolved.get('demo-service-b')).toBe('/usr/demo-service-b');
    expect(resolved.has('demo-service-broken')).toBe(false);
  });
});

describe('DebugLauncherViewProvider — DEBUG_DISCOVERING_REMOTE_ROOT message order', () => {
  it('posts DEBUG_DISCOVERING_REMOTE_ROOT before invoking cf ssh probe in handleStartDebug', async () => {
    const provider = makeProvider();
    const internals = getInternals(provider);
    await saveProviderConfig();

    const orderedEvents: string[] = [];
    vi.spyOn(provider, 'postMessage').mockImplementation((msg: ExtensionMessage) => {
      orderedEvents.push(`post:${msg.type}`);
    });
    cfClientMock.cfFindRemotePackageJsonPaths.mockImplementation((appName: string) => {
      orderedEvents.push(`probe:${appName}`);
      return Promise.resolve([`/usr/${appName}/package.json`]);
    });
    capDebugConfigMock.resolveSharedCapDebugConfig.mockResolvedValue({
      remoteRoot: 'regex:^/usr/demo-service-a$',
    });
    folderScannerMock.findRepoFolder.mockImplementation((groupPath, candidate) => {
      if (candidate === 'demo-service-a') return Promise.resolve(`${groupPath}/${candidate}`);
      return Promise.resolve(null);
    });

    await internals.handleStartDebug(['demo-service-a'], SAMPLE_ORG, SAMPLE_SPACE);

    const discoveringIndex = orderedEvents.indexOf('post:DEBUG_DISCOVERING_REMOTE_ROOT');
    const probeIndex = orderedEvents.indexOf('probe:demo-service-a');
    expect(discoveringIndex).toBeGreaterThanOrEqual(0);
    expect(probeIndex).toBeGreaterThanOrEqual(0);
    expect(discoveringIndex).toBeLessThan(probeIndex);
  });
});
