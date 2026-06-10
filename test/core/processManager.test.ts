import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockDebugSession {
  id: string;
  name: string;
  parentSession?: MockDebugSession;
  customRequest: ReturnType<typeof vi.fn>;
}

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

interface SpawnCall {
  command: string;
  args: string[];
  options: unknown;
}

interface StatusChangedEvent {
  appName: string;
  status: string;
  message?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

type DebugSessionListener = (session: MockDebugSession) => void;

const {
  childProcessMockState,
  keepaliveMockState,
  inspectorProbeMockState,
  portCleanupMockState,
  processMockState,
  remoteCleanupMockState,
  tunnelRegistryMockState,
  vscodeMockState,
} = vi.hoisted(() => ({
  childProcessMockState: {
    calls: [] as SpawnCall[],
    children: [] as MockChildProcess[],
    nextPid: 41,
    spawn: vi.fn(),
    execFile: vi.fn(),
  },
  keepaliveMockState: {
    disposers: [] as ReturnType<typeof vi.fn>[],
    startTunnelKeepalive: vi.fn(),
  },
  inspectorProbeMockState: {
    waitInspectorReady: vi.fn(),
  },
  portCleanupMockState: {
    cleanupPort: vi.fn(),
    killProcessOnPort: vi.fn(),
    waitPortFree: vi.fn(),
  },
  processMockState: {
    kill: vi.fn(),
  },
  remoteCleanupMockState: {
    clearBreakpointsBeforeStop: vi.fn(),
    handleRemoteInspectorAfterStop: vi.fn(),
    scanAndWarnForDebuggerLiterals: vi.fn(),
  },
  tunnelRegistryMockState: {
    registerActiveTunnel: vi.fn(),
    unregisterActiveTunnel: vi.fn(),
  },
  vscodeMockState: {
    append: vi.fn(),
    appendLine: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    show: vi.fn(),
    showInformationMessage: vi.fn(),
    startDebugging: vi.fn(),
    stopDebugging: vi.fn(),
    onDidStartDebugSession: undefined as DebugSessionListener | undefined,
    onDidTerminateDebugSession: undefined as DebugSessionListener | undefined,
    removeLaunchConfigs: vi.fn(),
    settings: new Map<string, unknown>(),
    nextSessionId: 1,
  },
}));

function createDeferred<T>(): Deferred<T> {
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });

  if (!resolveValue || !rejectValue) {
    throw new Error('Deferred promise callbacks were not initialized.');
  }

  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue,
  };
}

function createMockChildProcess(pid: number): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = pid;
  return child;
}

function isTunnelSpawn(call: SpawnCall): boolean {
  return call.command === 'cf' && call.args.includes('-L');
}

function tunnelSpawnCount(): number {
  return childProcessMockState.calls.filter(isTunnelSpawn).length;
}

function latestTunnelChild(): MockChildProcess {
  const tunnelChildren = childProcessMockState.children.filter((_, index) => {
    const call = childProcessMockState.calls[index];
    return call ? isTunnelSpawn(call) : false;
  });
  const child = tunnelChildren[tunnelChildren.length - 1];
  if (!child) throw new Error('No tunnel child process was spawned.');
  return child;
}

vi.mock('node:child_process', () => ({
  spawn: childProcessMockState.spawn,
  execFile: childProcessMockState.execFile,
}));

vi.mock('../../src/core/portCleanup', () => ({
  DEFAULT_PORT_FREE_TIMEOUT_MS: 3_000,
  cleanupPort: portCleanupMockState.cleanupPort,
  killProcessOnPort: portCleanupMockState.killProcessOnPort,
  waitPortFree: portCleanupMockState.waitPortFree,
}));

vi.mock('../../src/core/inspectorReadyProbe', () => ({
  waitInspectorReady: inspectorProbeMockState.waitInspectorReady,
}));

vi.mock('../../src/core/cfClient', () => ({
  cfSshEnabled: vi.fn(() => Promise.resolve(true)),
  cfEnableSsh: vi.fn(() => Promise.resolve(undefined)),
  cfRestartApp: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('../../src/core/chromeDevTools', () => ({
  openChromeDevTools: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../src/storage/cacheStore', () => ({
  getDebugPreferences: () => ({
    openBrowserOnAttach: false,
    enableBreakpointSnapshotHandling: false,
    enableBranchPrep: false,
  }),
}));

vi.mock('../../src/core/launchConfigurator', () => ({
  removeLaunchConfigs: vscodeMockState.removeLaunchConfigs,
}));

vi.mock('../../src/core/remoteInspectorCleanup', () => ({
  clearBreakpointsBeforeStop: remoteCleanupMockState.clearBreakpointsBeforeStop,
  handleRemoteInspectorAfterStop: remoteCleanupMockState.handleRemoteInspectorAfterStop,
  scanAndWarnForDebuggerLiterals: remoteCleanupMockState.scanAndWarnForDebuggerLiterals,
}));

vi.mock('../../src/core/tunnelKeepalive', () => ({
  startTunnelKeepalive: keepaliveMockState.startTunnelKeepalive,
}));

vi.mock('../../src/core/orphanTunnelReaper', () => ({
  registerActiveTunnel: tunnelRegistryMockState.registerActiveTunnel,
  unregisterActiveTunnel: tunnelRegistryMockState.unregisterActiveTunnel,
}));

vi.mock('vscode', () => ({
  debug: {
    onDidStartDebugSession: (listener: DebugSessionListener) => {
      vscodeMockState.onDidStartDebugSession = listener;
      return { dispose: vi.fn() };
    },
    onDidTerminateDebugSession: (listener: DebugSessionListener) => {
      vscodeMockState.onDidTerminateDebugSession = listener;
      return { dispose: vi.fn() };
    },
    startDebugging: vscodeMockState.startDebugging,
    stopDebugging: vscodeMockState.stopDebugging,
  },
  window: {
    createOutputChannel: () => ({
      append: vscodeMockState.append,
      appendLine: vscodeMockState.appendLine,
      clear: vscodeMockState.clear,
      dispose: vscodeMockState.dispose,
      show: vscodeMockState.show,
    }),
    showInformationMessage: vscodeMockState.showInformationMessage,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => vscodeMockState.settings.get(key) ?? fallback,
    }),
    workspaceFolders: [{ uri: { fsPath: '/tmp/sample-workspace' } }],
  },
}));

import {
  debugProcessEvents,
  disposeAllProcesses,
  initializeProcessManager,
  startTunnelAndAttach,
  stopProcess,
} from '../../src/core/processManager';

async function startManagedTunnel(appName = 'demo-app', port = 20000): Promise<MockChildProcess> {
  const startPromise = startTunnelAndAttach(appName, '/tmp/sample-service', port, `Debug: ${appName}`);
  await vi.advanceTimersByTimeAsync(300);
  await startPromise;
  return latestTunnelChild();
}

beforeEach(() => {
  vi.useFakeTimers();
  childProcessMockState.calls.length = 0;
  childProcessMockState.children.length = 0;
  childProcessMockState.nextPid = 41;
  childProcessMockState.spawn.mockImplementation((command: string, args: readonly string[] = [], options: unknown) => {
    const child = createMockChildProcess(childProcessMockState.nextPid++);
    childProcessMockState.calls.push({ command, args: [...args], options });
    childProcessMockState.children.push(child);
    if (args.includes('-c')) {
      queueMicrotask(() => {
        child.emit('close', 0);
      });
    }
    return child;
  });
  childProcessMockState.execFile.mockImplementation(() => new EventEmitter());
  keepaliveMockState.disposers.length = 0;
  keepaliveMockState.startTunnelKeepalive.mockReset();
  keepaliveMockState.startTunnelKeepalive.mockImplementation(() => {
    const dispose = vi.fn();
    keepaliveMockState.disposers.push(dispose);
    return dispose;
  });

  portCleanupMockState.cleanupPort.mockResolvedValue(true);
  portCleanupMockState.killProcessOnPort.mockResolvedValue(undefined);
  portCleanupMockState.waitPortFree.mockResolvedValue(true);
  inspectorProbeMockState.waitInspectorReady.mockReset();
  inspectorProbeMockState.waitInspectorReady.mockResolvedValue(true);

  vscodeMockState.append.mockClear();
  vscodeMockState.appendLine.mockClear();
  vscodeMockState.clear.mockClear();
  vscodeMockState.dispose.mockClear();
  vscodeMockState.showInformationMessage.mockResolvedValue(undefined);
  vscodeMockState.startDebugging.mockImplementation((_folder: unknown, launchConfigName: string) => {
    const session: MockDebugSession = {
      id: `session-${vscodeMockState.nextSessionId.toString()}`,
      name: launchConfigName,
      customRequest: vi.fn().mockResolvedValue(undefined),
    };
    vscodeMockState.nextSessionId += 1;
    vscodeMockState.onDidStartDebugSession?.(session);
    return Promise.resolve(true);
  });
  vscodeMockState.stopDebugging.mockResolvedValue(undefined);
  vscodeMockState.removeLaunchConfigs.mockResolvedValue(undefined);
  vscodeMockState.settings.clear();
  vscodeMockState.nextSessionId = 1;

  remoteCleanupMockState.clearBreakpointsBeforeStop.mockReset();
  remoteCleanupMockState.handleRemoteInspectorAfterStop.mockReset();
  remoteCleanupMockState.scanAndWarnForDebuggerLiterals.mockReset();
  remoteCleanupMockState.clearBreakpointsBeforeStop.mockResolvedValue(undefined);
  remoteCleanupMockState.handleRemoteInspectorAfterStop.mockResolvedValue(undefined);
  remoteCleanupMockState.scanAndWarnForDebuggerLiterals.mockResolvedValue(undefined);
  tunnelRegistryMockState.registerActiveTunnel.mockReset();
  tunnelRegistryMockState.unregisterActiveTunnel.mockReset();
  tunnelRegistryMockState.registerActiveTunnel.mockResolvedValue(undefined);
  tunnelRegistryMockState.unregisterActiveTunnel.mockResolvedValue(undefined);

  processMockState.kill.mockReset();
  processMockState.kill.mockReturnValue(true);
  vi.spyOn(process, 'kill').mockImplementation(processMockState.kill);
});

afterEach(async () => {
  await disposeAllProcesses();
  debugProcessEvents.removeAllListeners();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('processManager remote inspector hardening', () => {
  it('signals the heuristic main Node process by default instead of every node process', async () => {
    await startManagedTunnel('demo-app', 20000);

    const signalCall = childProcessMockState.calls.find((call) => call.args.includes('-c'));
    expect(signalCall?.args[3]).toContain("node.*(server|app|index)\\.js");
    expect(signalCall?.args[3]).toContain('cds-mtxs');
    expect(signalCall?.args[3]).not.toBe('kill -s USR1 $(pidof node)');
  });

  it('keeps the legacy all-node signal command when signalAllNodeProcesses is enabled', async () => {
    vscodeMockState.settings.set('signalAllNodeProcesses', true);

    await startManagedTunnel('legacy-app', 20001);

    const signalCall = childProcessMockState.calls.find((call) => call.args.includes('-c'));
    expect(signalCall?.args[3]).toBe('kill -s USR1 $(pidof node)');
  });

  it('registers the cf ssh tunnel, starts keepalive, and scans for debugger literals after attach', async () => {
    await startManagedTunnel('demo-app', 20000);

    expect(tunnelRegistryMockState.registerActiveTunnel).toHaveBeenCalledWith({
      appName: 'demo-app',
      pid: 42,
      port: 20000,
      startedAt: expect.any(Number),
      ownerPid: process.pid,
    });
    expect(keepaliveMockState.startTunnelKeepalive).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Debug: demo-app' }),
      'demo-app',
      10,
      expect.any(Function),
    );
    expect(remoteCleanupMockState.scanAndWarnForDebuggerLiterals).toHaveBeenCalledWith(
      'demo-app',
      '/tmp/sample-service',
      expect.any(Number),
      expect.any(Object),
    );
  });

  it('clears remote breakpoints before killing the tunnel and stopping the debug session', async () => {
    await startManagedTunnel('demo-app', 20000);

    await stopProcess('demo-app');

    expect(remoteCleanupMockState.clearBreakpointsBeforeStop).toHaveBeenCalledWith(
      'demo-app',
      expect.objectContaining({ name: 'Debug: demo-app' }),
    );
    expect(vscodeMockState.stopDebugging).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Debug: demo-app' }),
    );
    const clearOrder = remoteCleanupMockState.clearBreakpointsBeforeStop.mock.invocationCallOrder[0] ?? 0;
    const killOrder = processMockState.kill.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(clearOrder).toBeLessThan(killOrder);
    expect(keepaliveMockState.disposers[0]).toHaveBeenCalledOnce();
    expect(tunnelRegistryMockState.unregisterActiveTunnel).toHaveBeenCalledWith('demo-app');
    expect(remoteCleanupMockState.handleRemoteInspectorAfterStop).toHaveBeenCalledWith('demo-app');
  });

  it('skips post-stop inspector notification during silent stop', async () => {
    await startManagedTunnel('silent-app', 20000);

    await stopProcess('silent-app', false, true);

    expect(remoteCleanupMockState.handleRemoteInspectorAfterStop).not.toHaveBeenCalled();
  });

  it('clears old remote breakpoints before an auto-reconnect attempt opens a replacement tunnel', async () => {
    const tunnelChild = await startManagedTunnel('reconnect-app', 20000);
    remoteCleanupMockState.clearBreakpointsBeforeStop.mockClear();

    tunnelChild.emit('close', 1);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(300);

    expect(remoteCleanupMockState.clearBreakpointsBeforeStop).toHaveBeenCalledWith(
      'reconnect-app',
      expect.objectContaining({ name: 'Debug: reconnect-app' }),
    );
    expect(tunnelSpawnCount()).toBe(2);
  });

  it('re-arms USR1 mid-probe and tears down the cf ssh tunnel when the probe times out', async () => {
    // Reproduces the user-reported flow where Start Debug after a fresh CF app boot
    // would hang on the inspector probe and require a manual Stop + Start to recover.
    // The midpoint USR1 re-arm gives the still-booting app a second chance to expose
    // the inspector, and the explicit teardown ensures the orphaned cf ssh tunnel
    // does not keep port 20000 held captive when the probe ultimately fails.
    const probeReady = createDeferred<boolean>();
    inspectorProbeMockState.waitInspectorReady.mockReset();
    inspectorProbeMockState.waitInspectorReady.mockImplementationOnce(() => probeReady.promise);
    vscodeMockState.startDebugging.mockClear();

    const tunnelChild = await startManagedTunnel('slow-boot-app', 20000);

    const signalCount = (): number =>
      childProcessMockState.calls.filter((call) => call.command === 'cf' && call.args.includes('-c')).length;
    expect(signalCount()).toBe(1);

    // Default tunnelReadyTimeoutSeconds is 30s, so the resend fires at 15s in.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signalCount()).toBe(2);

    processMockState.kill.mockClear();
    tunnelRegistryMockState.unregisterActiveTunnel.mockClear();

    const errors: string[] = [];
    debugProcessEvents.on('statusChanged', (event: StatusChangedEvent) => {
      if (event.status === 'ERROR' && event.message !== undefined) errors.push(event.message);
    });

    probeReady.resolve(false);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(processMockState.kill).toHaveBeenCalledWith(-tunnelChild.pid, 'SIGTERM');
    expect(tunnelRegistryMockState.unregisterActiveTunnel).toHaveBeenCalledWith('slow-boot-app');
    expect(vscodeMockState.startDebugging).not.toHaveBeenCalled();
    expect(errors.some((message) => message.includes('Remote Node inspector did not respond'))).toBe(true);
  });

  it('schedules reconnect when keepalive reports repeated failure', async () => {
    await startManagedTunnel('keepalive-app', 20000);
    const onFailure = keepaliveMockState.startTunnelKeepalive.mock.calls[0]?.[3];
    if (typeof onFailure !== 'function') throw new Error('keepalive failure callback was not registered.');

    onFailure();
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);

    expect(tunnelSpawnCount()).toBe(2);
  });

  it('clears remote breakpoints before tunnel teardown when the session is stopped externally (red square)', async () => {
    // VS Code's debug-toolbar stop never goes through stopProcess, so the defensive
    // setBreakpoints([]) pass used to be skipped entirely — leaving the remote Node
    // inspector holding breakpoints until `cf restart`.
    const tunnelChild = await startManagedTunnel('demo-app', 20000);
    const session = keepaliveMockState.startTunnelKeepalive.mock.calls[0]?.[0] as MockDebugSession | undefined;
    if (!session) throw new Error('attached debug session was not captured.');

    vscodeMockState.onDidTerminateDebugSession?.(session);
    await vi.advanceTimersByTimeAsync(350);
    await vi.advanceTimersByTimeAsync(0);

    expect(remoteCleanupMockState.clearBreakpointsBeforeStop).toHaveBeenCalledWith('demo-app', undefined);
    expect(processMockState.kill).toHaveBeenCalledWith(-tunnelChild.pid, 'SIGTERM');
    const clearOrder = remoteCleanupMockState.clearBreakpointsBeforeStop.mock.invocationCallOrder[0] ?? 0;
    const killOrder = processMockState.kill.mock.invocationCallOrder[0] ?? 0;
    expect(clearOrder).toBeLessThan(killOrder);
    expect(remoteCleanupMockState.handleRemoteInspectorAfterStop).toHaveBeenCalledWith('demo-app');
  });

  it('ignores terminate events for Debug:-named sessions the manager never started', async () => {
    initializeProcessManager();
    // removeLaunchConfigs is shared across tests and only re-stubbed (not cleared) in
    // beforeEach — drop calls recorded by earlier stop flows before asserting.
    vscodeMockState.removeLaunchConfigs.mockClear();
    const foreign: MockDebugSession = {
      id: 'foreign-1',
      name: 'Debug: third-party-app',
      customRequest: vi.fn(),
    };

    vscodeMockState.onDidStartDebugSession?.(foreign);
    vscodeMockState.onDidTerminateDebugSession?.(foreign);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(remoteCleanupMockState.clearBreakpointsBeforeStop).not.toHaveBeenCalled();
    expect(remoteCleanupMockState.handleRemoteInspectorAfterStop).not.toHaveBeenCalled();
    expect(vscodeMockState.removeLaunchConfigs).not.toHaveBeenCalled();
  });
});

describe('processManager port cleanup lifecycle', () => {
  it('awaits verified port cleanup before stopProcess resolves', async () => {
    await startManagedTunnel();
    const cleanup = createDeferred<boolean>();
    portCleanupMockState.cleanupPort.mockClear();
    portCleanupMockState.cleanupPort.mockReturnValueOnce(cleanup.promise);

    const stopPromise = stopProcess('demo-app');
    let resolved = false;
    const resolution = stopPromise.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(portCleanupMockState.cleanupPort).toHaveBeenCalledWith(20000, 3_000);
    expect(resolved).toBe(false);

    cleanup.resolve(true);
    await resolution;

    expect(resolved).toBe(true);
  });

  it('does not spawn the replacement cf ssh tunnel until a fast Stop -> Start frees the port', async () => {
    await startManagedTunnel();
    const cleanup = createDeferred<boolean>();
    portCleanupMockState.cleanupPort.mockClear();
    portCleanupMockState.cleanupPort
      .mockReturnValueOnce(cleanup.promise)
      .mockReturnValueOnce(cleanup.promise);

    const stopPromise = stopProcess('demo-app');
    const restartPromise = startTunnelAndAttach('demo-app', '/tmp/sample-service', 20000, 'Debug: demo-app');
    await vi.advanceTimersByTimeAsync(1000);

    expect(tunnelSpawnCount()).toBe(1);

    cleanup.resolve(true);
    await stopPromise;
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);
    await restartPromise;

    expect(tunnelSpawnCount()).toBe(2);
  });

  it('bumps lifecycle before awaiting cleanup so stale child close callbacks do not mutate the stopped state', async () => {
    const tunnelChild = await startManagedTunnel();
    const statuses: string[] = [];
    debugProcessEvents.on('statusChanged', (event: StatusChangedEvent) => {
      statuses.push(event.status);
    });
    const cleanup = createDeferred<boolean>();
    portCleanupMockState.cleanupPort.mockClear();
    portCleanupMockState.cleanupPort.mockReturnValueOnce(cleanup.promise);

    const stopPromise = stopProcess('demo-app');
    tunnelChild.emit('close', 0);
    await Promise.resolve();

    expect(statuses).not.toContain('TUNNELING');
    expect(statuses).not.toContain('ERROR');

    cleanup.resolve(true);
    await stopPromise;

    expect(statuses.filter((status) => status === 'EXITED')).toHaveLength(1);
    expect(statuses).not.toContain('TUNNELING');
    expect(statuses).not.toContain('ERROR');
  });
});
