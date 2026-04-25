import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

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
    return child as unknown as ChildProcessWithoutNullStreams;
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
  it('starts a CF logs stream and emits non-empty stdout and stderr lines', () => {
    const lines: string[] = [];
    cfLogsManager.on('logLine', (_appName: string, line: string) => {
      lines.push(line);
    });

    cfLogsManager.startStreaming('demo-app');
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

  it('ignores duplicate stream starts for the same app', () => {
    cfLogsManager.startStreaming('demo-app');
    cfLogsManager.startStreaming('demo-app');

    expect(childProcessMockState.spawn).toHaveBeenCalledTimes(1);
  });

  it('emits logError and logEnd when the child process errors', () => {
    const errors: string[] = [];
    const ended: string[] = [];
    cfLogsManager.on('logError', (appName: string, message: string) => {
      errors.push(`${appName}:${message}`);
    });
    cfLogsManager.on('logEnd', (appName: string) => {
      ended.push(appName);
    });

    cfLogsManager.startStreaming('demo-app');
    childProcessMockState.children[0]?.emit('error', new Error('stream failed'));

    expect(errors).toEqual(['demo-app:stream failed']);
    expect(ended).toEqual(['demo-app']);
    expect(cfLogsManager.isStreaming('demo-app')).toBe(false);
  });

  it('emits logEnd when the child process closes', () => {
    const ended: string[] = [];
    cfLogsManager.on('logEnd', (appName: string) => {
      ended.push(appName);
    });

    cfLogsManager.startStreaming('demo-app');
    childProcessMockState.children[0]?.emit('close', 0);

    expect(ended).toEqual(['demo-app']);
    expect(cfLogsManager.isStreaming('demo-app')).toBe(false);
  });

  it('stops active streams and ignores missing streams', () => {
    const ended: string[] = [];
    cfLogsManager.on('logEnd', (appName: string) => {
      ended.push(appName);
    });

    cfLogsManager.stopStreaming('missing-app');
    cfLogsManager.startStreaming('demo-app');
    const child = childProcessMockState.children[0];
    cfLogsManager.stopStreaming('demo-app');

    expect(child?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(ended).toEqual(['demo-app']);
    expect(cfLogsManager.streamingApps()).toEqual([]);
  });

  it('stops every active stream when disposed', () => {
    cfLogsManager.startStreaming('app-a');
    cfLogsManager.startStreaming('app-b');

    cfLogsManager.dispose();

    expect(childProcessMockState.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(childProcessMockState.children[1]?.kill).toHaveBeenCalledWith('SIGTERM');
    expect(cfLogsManager.streamingApps()).toEqual([]);
  });
});
