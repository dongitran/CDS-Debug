import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockDebugSession {
  id: string;
  name: string;
  parentSession?: MockDebugSession;
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

const { childProcessMockState, portCleanupMockState, vscodeMockState } = vi.hoisted(() => ({
  childProcessMockState: {
    calls: [] as SpawnCall[],
    children: [] as MockChildProcess[],
    nextPid: 41,
    spawn: vi.fn(),
    execFile: vi.fn(),
  },
  portCleanupMockState: {
    cleanupPort: vi.fn(),
    killProcessOnPort: vi.fn(),
    waitPortFree: vi.fn(),
    waitPortListening: vi.fn(),
  },
  vscodeMockState: {
    append: vi.fn(),
    appendLine: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    showInformationMessage: vi.fn(),
    startDebugging: vi.fn(),
    stopDebugging: vi.fn(),
    onDidStartDebugSession: undefined as DebugSessionListener | undefined,
    onDidTerminateDebugSession: undefined as DebugSessionListener | undefined,
    removeLaunchConfigs: vi.fn(),
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
  waitPortListening: portCleanupMockState.waitPortListening,
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
    }),
    showInformationMessage: vscodeMockState.showInformationMessage,
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: number) => fallback,
    }),
    workspaceFolders: [{ uri: { fsPath: '/tmp/sample-workspace' } }],
  },
}));

import {
  debugProcessEvents,
  disposeAllProcesses,
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

  portCleanupMockState.cleanupPort.mockResolvedValue(true);
  portCleanupMockState.killProcessOnPort.mockResolvedValue(undefined);
  portCleanupMockState.waitPortFree.mockResolvedValue(true);
  portCleanupMockState.waitPortListening.mockResolvedValue(true);

  vscodeMockState.append.mockClear();
  vscodeMockState.appendLine.mockClear();
  vscodeMockState.clear.mockClear();
  vscodeMockState.dispose.mockClear();
  vscodeMockState.showInformationMessage.mockResolvedValue(undefined);
  vscodeMockState.startDebugging.mockResolvedValue(true);
  vscodeMockState.stopDebugging.mockResolvedValue(undefined);
  vscodeMockState.removeLaunchConfigs.mockResolvedValue(undefined);

  vi.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(async () => {
  await disposeAllProcesses();
  debugProcessEvents.removeAllListeners();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
