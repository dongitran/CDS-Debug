import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// cspell:ignore taskkill

interface ExecFileCall {
  file: string;
  args: string[];
}

interface ExecFileResponse {
  error?: NodeJS.ErrnoException;
  stdout: string;
  stderr?: string;
}

interface MockSocket extends EventEmitter {
  setTimeout: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

type SocketOutcome = 'connect' | 'refused' | 'timeout';
type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

const { childProcessMockState, netMockState } = vi.hoisted(() => ({
  childProcessMockState: {
    calls: [] as ExecFileCall[],
    responses: [] as ExecFileResponse[],
    execFile: vi.fn(),
  },
  netMockState: {
    outcomes: [] as SocketOutcome[],
    createConnection: vi.fn(),
  },
}));

function isExecFileCallback(value: unknown): value is ExecFileCallback {
  return typeof value === 'function';
}

function createMockSocket(): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.setTimeout = vi.fn();
  socket.destroy = vi.fn();
  return socket;
}

function setProcessPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });

  return (): void => {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  };
}

vi.mock('node:child_process', () => ({
  execFile: childProcessMockState.execFile,
}));

vi.mock('node:net', () => ({
  createConnection: netMockState.createConnection,
}));

import { killProcessOnPort, waitPortFree } from '../../src/core/portCleanup';

beforeEach(() => {
  childProcessMockState.calls.length = 0;
  childProcessMockState.responses.length = 0;
  childProcessMockState.execFile.mockImplementation((file: string, args: readonly string[], callback: unknown) => {
    childProcessMockState.calls.push({ file, args: [...args] });
    const response = childProcessMockState.responses.shift() ?? { stdout: '' };
    if (isExecFileCallback(callback)) {
      queueMicrotask(() => {
        callback(response.error ?? null, response.stdout, response.stderr ?? '');
      });
    }
    return new EventEmitter();
  });

  netMockState.outcomes.length = 0;
  netMockState.createConnection.mockImplementation(() => {
    const socket = createMockSocket();
    const outcome = netMockState.outcomes.shift() ?? 'refused';
    queueMicrotask(() => {
      if (outcome === 'connect') {
        socket.emit('connect');
        return;
      }
      if (outcome === 'timeout') {
        socket.emit('timeout');
        return;
      }
      const error = new Error('connection refused') as NodeJS.ErrnoException;
      error.code = 'ECONNREFUSED';
      socket.emit('error', error);
    });
    return socket;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('portCleanup', () => {
  it('kills Unix listeners returned by lsof for a local debug port', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    childProcessMockState.responses.push({ stdout: '123\n456\n' });

    try {
      await killProcessOnPort(20000);
    } finally {
      restorePlatform();
    }

    expect(childProcessMockState.calls).toEqual([
      { file: 'lsof', args: ['-t', '-i', 'tcp:20000'] },
    ]);
    expect(killSpy).toHaveBeenCalledWith(123, 'SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(456, 'SIGKILL');
  });

  it('kills Windows listeners parsed from netstat with taskkill', async () => {
    const restorePlatform = setProcessPlatform('win32');
    childProcessMockState.responses.push(
      {
        stdout: [
          'TCP    127.0.0.1:20000    0.0.0.0:0    LISTENING    321',
          'TCP    127.0.0.1:20001    0.0.0.0:0    LISTENING    654',
        ].join('\n'),
      },
      { stdout: '' },
    );

    try {
      await killProcessOnPort(20000);
    } finally {
      restorePlatform();
    }

    expect(childProcessMockState.calls).toEqual([
      { file: 'netstat', args: ['-ano'] },
      { file: 'taskkill', args: ['/F', '/PID', '321'] },
    ]);
  });

  it('returns true when waitPortFree observes ECONNREFUSED on loopback', async () => {
    netMockState.outcomes.push('refused');

    await expect(waitPortFree(20000, 3000)).resolves.toBe(true);

    expect(netMockState.createConnection).toHaveBeenCalledWith({ port: 20000, host: '127.0.0.1' });
  });

  it('returns false when waitPortFree times out while the port still accepts TCP connections', async () => {
    vi.useFakeTimers();
    netMockState.outcomes.push('connect', 'connect', 'connect', 'connect');

    const result = waitPortFree(20000, 250);
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBe(false);
    expect(netMockState.createConnection).toHaveBeenCalledTimes(3);
  });
});
