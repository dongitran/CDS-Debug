import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

const { childProcessMockState, vscodeMockState } = vi.hoisted(() => ({
  childProcessMockState: {
    spawn: vi.fn(),
    children: [] as MockChildProcess[],
  },
  vscodeMockState: {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
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

vi.mock('node:child_process', () => ({
  spawn: childProcessMockState.spawn,
}));

vi.mock('../../src/core/cfEnvironment', () => ({
  createCfProcessEnv: createCfProcessEnvMock,
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: vscodeMockState.appendLine,
      show: vscodeMockState.show,
      dispose: vscodeMockState.dispose,
    }),
  },
}));

import { cfLogsManager } from '../../src/core/cfLogsManager';

beforeEach(() => {
  childProcessMockState.children.length = 0;
  childProcessMockState.spawn.mockImplementation(() => {
    const child = createMockChildProcess();
    childProcessMockState.children.push(child);
    return child;
  });
  createCfProcessEnvMock.mockReset().mockResolvedValue({
    HTTPS_PROXY: 'socks5://127.0.0.1:49152',
  });
});

afterEach(() => {
  cfLogsManager.dispose();
  childProcessMockState.spawn.mockReset();
  vscodeMockState.appendLine.mockClear();
  vscodeMockState.show.mockClear();
  vscodeMockState.dispose.mockClear();
});

describe('cfLogsManager', () => {
  it('starts a CF logs stream and emits non-empty stdout and stderr lines', async () => {
    const lines: string[] = [];
    cfLogsManager.on('logLine', (_appName: string, line: string) => {
      lines.push(line);
    });

    await cfLogsManager.startStreaming('demo-app');
    const child = childProcessMockState.children[0];

    child?.stdout.emit('data', Buffer.from('first line\n\nsecond line\n'));
    child?.stderr.emit('data', Buffer.from('warning line\n'));

    expect(childProcessMockState.spawn).toHaveBeenCalledWith(
      'cf',
      ['logs', 'demo-app'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(cfLogsManager.isStreaming('demo-app')).toBe(true);
    expect(cfLogsManager.streamingApps()).toEqual(['demo-app']);
    expect(lines).toEqual(['first line', 'second line', 'warning line']);
  });

  it('ignores duplicate stream starts for the same app', async () => {
    await cfLogsManager.startStreaming('demo-app');
    await cfLogsManager.startStreaming('demo-app');

    expect(childProcessMockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent starts while the proxy environment is loading', async () => {
    let resolveEnvironment: ((env: NodeJS.ProcessEnv) => void) | undefined;
    createCfProcessEnvMock.mockReturnValue(new Promise((resolve) => {
      resolveEnvironment = resolve;
    }));

    const first = cfLogsManager.startStreaming('demo-app');
    const second = cfLogsManager.startStreaming('demo-app');
    resolveEnvironment?.({ HTTPS_PROXY: 'socks5://127.0.0.1:49152' });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(childProcessMockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not spawn a stream after stop cancels an in-flight start', async () => {
    let resolveEnvironment: ((env: NodeJS.ProcessEnv) => void) | undefined;
    createCfProcessEnvMock.mockReturnValue(new Promise((resolve) => {
      resolveEnvironment = resolve;
    }));

    const starting = cfLogsManager.startStreaming('demo-app');
    cfLogsManager.stopStreaming('demo-app');
    resolveEnvironment?.({ HTTPS_PROXY: 'socks5://127.0.0.1:49152' });

    await expect(starting).resolves.toBe(false);
    expect(childProcessMockState.spawn).not.toHaveBeenCalled();
    expect(cfLogsManager.isStreaming('demo-app')).toBe(false);
  });

  it('emits logError and logEnd when the child process errors', async () => {
    const errors: string[] = [];
    const ended: string[] = [];
    cfLogsManager.on('logError', (appName: string, message: string) => {
      errors.push(`${appName}:${message}`);
    });
    cfLogsManager.on('logEnd', (appName: string) => {
      ended.push(appName);
    });

    await cfLogsManager.startStreaming('demo-app');
    childProcessMockState.children[0]?.emit('error', new Error('stream failed'));

    expect(errors).toEqual(['demo-app:stream failed']);
    expect(ended).toEqual(['demo-app']);
    expect(cfLogsManager.isStreaming('demo-app')).toBe(false);
  });

  it('emits logEnd when the child process closes', async () => {
    const ended: string[] = [];
    cfLogsManager.on('logEnd', (appName: string) => {
      ended.push(appName);
    });

    await cfLogsManager.startStreaming('demo-app');
    childProcessMockState.children[0]?.emit('close', 0);

    expect(ended).toEqual(['demo-app']);
    expect(cfLogsManager.isStreaming('demo-app')).toBe(false);
  });

  it('stops active streams and ignores missing streams', async () => {
    const ended: string[] = [];
    cfLogsManager.on('logEnd', (appName: string) => {
      ended.push(appName);
    });

    cfLogsManager.stopStreaming('missing-app');
    await cfLogsManager.startStreaming('demo-app');
    const child = childProcessMockState.children[0];
    cfLogsManager.stopStreaming('demo-app');

    expect(child?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ended).toEqual(['demo-app']);
    expect(cfLogsManager.streamingApps()).toEqual([]);
  });

  it('stops every active stream when disposed', async () => {
    await cfLogsManager.startStreaming('app-a');
    await cfLogsManager.startStreaming('app-b');

    cfLogsManager.dispose();

    expect(childProcessMockState.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(childProcessMockState.children[1]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(cfLogsManager.streamingApps()).toEqual([]);
  });
});
