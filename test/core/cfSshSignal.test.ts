import { EventEmitter } from 'node:events';
import type { OutputChannel } from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

interface SpawnCall {
  command: string;
  args: string[];
}

const { childProcessMockState, channelMockState } = vi.hoisted(() => ({
  childProcessMockState: {
    calls: [] as SpawnCall[],
    children: [] as MockChildProcess[],
    spawn: vi.fn(),
  },
  channelMockState: {
    append: vi.fn(),
    appendLine: vi.fn(),
  },
}));

const createCfProcessEnvMock = vi.hoisted(() => vi.fn());

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function mockOutputChannel(): OutputChannel {
  return channelMockState as unknown as OutputChannel;
}

vi.mock('node:child_process', () => ({
  spawn: childProcessMockState.spawn,
}));

vi.mock('../../src/core/cfEnvironment', () => ({
  createCfProcessEnv: createCfProcessEnvMock,
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

import {
  CF_SSH_SIGNAL_TIMEOUT_MS,
  isSshDisabledError,
  runCfSshSignal,
} from '../../src/core/cfSshSignal';

beforeEach(() => {
  vi.useFakeTimers();
  childProcessMockState.calls.length = 0;
  childProcessMockState.children.length = 0;
  childProcessMockState.spawn.mockImplementation((command: string, args: readonly string[]) => {
    const child = createMockChildProcess();
    childProcessMockState.calls.push({ command, args: [...args] });
    childProcessMockState.children.push(child);
    return child;
  });
  channelMockState.append.mockClear();
  channelMockState.appendLine.mockClear();
  createCfProcessEnvMock.mockReset().mockResolvedValue({
    HTTPS_PROXY: 'socks5://127.0.0.1:49152',
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('cfSshSignal', () => {
  it('captures stderr and exit code from a one-shot cf ssh signal command', async () => {
    const signal = runCfSshSignal('demo-app', 'kill -s USR1 $(pidof node)', mockOutputChannel());
    await Promise.resolve();
    const child = childProcessMockState.children[0];
    child?.stderr.emit('data', Buffer.from('not authorized\n'));
    child?.emit('close', 1);

    await expect(signal).resolves.toEqual({ exitCode: 1, stderr: 'not authorized\n' });
    expect(childProcessMockState.calls).toEqual([
      { command: 'cf', args: ['ssh', 'demo-app', '-c', 'kill -s USR1 $(pidof node)'] },
    ]);
    expect(childProcessMockState.spawn).toHaveBeenCalledWith(
      'cf',
      ['ssh', 'demo-app', '-c', 'kill -s USR1 $(pidof node)'],
      { env: { HTTPS_PROXY: 'socks5://127.0.0.1:49152' } },
    );
    expect(channelMockState.append).toHaveBeenCalledWith('not authorized\n');
  });

  it('kills and resolves non-fatally when the signal command times out', async () => {
    const signal = runCfSshSignal('demo-app', 'kill -s USR1 $(pidof node)', mockOutputChannel());
    await Promise.resolve();
    const child = childProcessMockState.children[0];

    await vi.advanceTimersByTimeAsync(CF_SSH_SIGNAL_TIMEOUT_MS);

    await expect(signal).resolves.toEqual({ exitCode: null, stderr: '' });
    expect(child?.kill).toHaveBeenCalledTimes(1);
    expect(channelMockState.appendLine).toHaveBeenCalledWith('[Extension] USR1 signal timed out — killing cf ssh and continuing.');
  });

  it('does not spawn a stale signal command after its environment finishes loading', async () => {
    let resolveEnvironment: ((env: NodeJS.ProcessEnv) => void) | undefined;
    createCfProcessEnvMock.mockReturnValue(new Promise((resolve) => {
      resolveEnvironment = resolve;
    }));
    let shouldStart = true;

    const signal = runCfSshSignal(
      'demo-app',
      'kill -s USR1 $(pidof node)',
      mockOutputChannel(),
      () => shouldStart,
    );
    shouldStart = false;
    resolveEnvironment?.({ HTTPS_PROXY: 'socks5://127.0.0.1:49152' });

    await expect(signal).resolves.toEqual({ exitCode: null, stderr: '' });
    expect(childProcessMockState.calls).toEqual([]);
  });

  it('detects Cloud Foundry SSH-disabled error text', () => {
    expect(isSshDisabledError('SSH support is disabled for this app')).toBe(true);
    expect(isSshDisabledError('not authorized: ssh access denied')).toBe(true);
    expect(isSshDisabledError('temporary network failure')).toBe(false);
  });
});
