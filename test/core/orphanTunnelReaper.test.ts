import { EventEmitter } from 'node:events';
// cspell:ignore pgrep taskkill
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ExecFileCall {
  file: string;
  args: string[];
}

interface ExecFileResponse {
  error?: NodeJS.ErrnoException;
  stdout: string;
  stderr?: string;
}

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

const { childProcessMockState } = vi.hoisted(() => ({
  childProcessMockState: {
    calls: [] as ExecFileCall[],
    responses: [] as ExecFileResponse[],
    execFile: vi.fn(),
    processKill: vi.fn(),
  },
}));

function isExecFileCallback(value: unknown): value is ExecFileCallback {
  return typeof value === 'function';
}

vi.mock('node:child_process', () => ({
  execFile: childProcessMockState.execFile,
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

import {
  initializeTunnelRegistry,
  reapOrphanCfSshTunnels,
  registerActiveTunnel,
  unregisterActiveTunnel,
} from '../../src/core/orphanTunnelReaper';

let storageDir: string;

beforeEach(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'cds-debug-reaper-'));
  initializeTunnelRegistry(storageDir);
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
  childProcessMockState.processKill.mockReset();
  childProcessMockState.processKill.mockImplementation((pid: number, signal?: string | number) => {
    if (signal === 0 && pid === 99999) {
      throw new Error('owner is gone');
    }
    return true;
  });
  vi.spyOn(process, 'kill').mockImplementation(childProcessMockState.processKill);
});

afterEach(async () => {
  await rm(storageDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('orphanTunnelReaper', () => {
  it('reaps old Unix cf ssh inspector tunnels and skips young ones', async () => {
    childProcessMockState.responses.push(
      { stdout: '101\n102\n' },
      { stdout: 'Sat May  9 10:00:00 2026\n' },
      { stdout: 'Sat May  9 10:01:30 2026\n' },
    );

    const result = await reapOrphanCfSshTunnels({
      platform: 'linux',
      graceMs: 60_000,
      killGraceMs: 0,
      now: () => Date.parse('Sat May  9 10:02:00 2026'),
    });

    expect(result).toEqual({ killed: [101], skipped: [102] });
    expect(childProcessMockState.calls[0]).toEqual({
      file: 'pgrep',
      args: ['-f', 'cf ssh .* -L [0-9]+:localhost:9229'],
    });
    const killCalls = childProcessMockState.processKill.mock.calls;
    expect(killCalls).toContainEqual([-101, 'SIGTERM']);
    expect(killCalls).not.toContainEqual([-102, 'SIGTERM']);
  });

  it('skips registry entries owned by a live extension process', async () => {
    await registerActiveTunnel({
      appName: 'demo-app',
      pid: 202,
      port: 20000,
      startedAt: Date.parse('Sat May  9 10:00:00 2026'),
      ownerPid: 12345,
    });
    childProcessMockState.responses.push(
      { stdout: '202\n' },
      { stdout: 'Sat May  9 10:00:00 2026\n' },
    );

    const result = await reapOrphanCfSshTunnels({
      platform: 'darwin',
      graceMs: 60_000,
      killGraceMs: 0,
      now: () => Date.parse('Sat May  9 10:02:00 2026'),
    });

    expect(result).toEqual({ killed: [], skipped: [202] });
    const killCalls = childProcessMockState.processKill.mock.calls;
    expect(killCalls).toContainEqual([12345, 0]);
    expect(killCalls).not.toContainEqual([-202, 'SIGTERM']);
  });

  it('reaps stale registry entries whose owner process no longer exists', async () => {
    await registerActiveTunnel({
      appName: 'demo-app',
      pid: 303,
      port: 20000,
      startedAt: Date.parse('Sat May  9 10:00:00 2026'),
      ownerPid: 99999,
    });
    childProcessMockState.responses.push(
      { stdout: '303\n' },
      { stdout: 'Sat May  9 10:00:00 2026\n' },
    );

    const result = await reapOrphanCfSshTunnels({
      platform: 'linux',
      graceMs: 60_000,
      killGraceMs: 0,
      now: () => Date.parse('Sat May  9 10:02:00 2026'),
    });

    expect(result.killed).toEqual([303]);
    expect(childProcessMockState.processKill.mock.calls).toContainEqual([-303, 'SIGTERM']);
  });

  it('treats a corrupt registry file as unsafe and skips reaping', async () => {
    await writeFile(join(storageDir, 'active-tunnels.json'), '{not-json', 'utf8');

    const result = await reapOrphanCfSshTunnels({
      platform: 'linux',
      graceMs: 60_000,
      killGraceMs: 0,
      now: () => Date.parse('Sat May  9 10:02:00 2026'),
    });

    expect(result).toEqual({ killed: [], skipped: [] });
    expect(childProcessMockState.calls).toEqual([]);
  });

  it('queries Windows cf processes and kills matching old tunnels as a tree', async () => {
    childProcessMockState.responses.push(
      {
        stdout: JSON.stringify([
          {
            ProcessId: 404,
            CommandLine: 'cf ssh demo-app -L 20000:localhost:9229',
            CreationDate: '2026-05-09T10:00:00.000Z',
          },
          {
            ProcessId: 405,
            CommandLine: 'cf ssh demo-app -L 20001:localhost:9230',
            CreationDate: '2026-05-09T10:00:00.000Z',
          },
        ]),
      },
      { stdout: '' },
    );

    const result = await reapOrphanCfSshTunnels({
      platform: 'win32',
      graceMs: 60_000,
      killGraceMs: 0,
      now: () => Date.parse('2026-05-09T10:02:00.000Z'),
    });

    expect(result).toEqual({ killed: [404], skipped: [] });
    expect(childProcessMockState.calls[0]?.file).toMatch(/powershell/i);
    expect(childProcessMockState.calls).toContainEqual({
      file: 'taskkill',
      args: ['/F', '/T', '/PID', '404'],
    });
  });

  it('overwrites a corrupt registry on register so the file self-recovers', async () => {
    // Simulate the real-world failure: two JSON arrays concatenated end-to-end.
    // Before the fix this kept register/unregister bailing out forever, so the
    // warning would spam every activation and orphan tunnels could never be
    // tracked.
    await writeFile(
      join(storageDir, 'active-tunnels.json'),
      '[]\n[{"appName":"stale","pid":1,"port":1,"startedAt":1,"ownerPid":1}]\n',
      'utf8',
    );

    await registerActiveTunnel({
      appName: 'recovering-app',
      pid: 606,
      port: 20002,
      startedAt: 456,
      ownerPid: 789,
    });

    const raw = await readFile(join(storageDir, 'active-tunnels.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual([
      {
        appName: 'recovering-app',
        pid: 606,
        port: 20002,
        startedAt: 456,
        ownerPid: 789,
      },
    ]);
  });

  it('registers and unregisters active tunnel records', async () => {
    await registerActiveTunnel({
      appName: 'demo-app',
      pid: 505,
      port: 20000,
      startedAt: 123,
      ownerPid: 456,
    });

    const raw = await readFile(join(storageDir, 'active-tunnels.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual([
      {
        appName: 'demo-app',
        pid: 505,
        port: 20000,
        startedAt: 123,
        ownerPid: 456,
      },
    ]);

    await unregisterActiveTunnel('demo-app');
    const afterRaw = await readFile(join(storageDir, 'active-tunnels.json'), 'utf8');
    expect(JSON.parse(afterRaw)).toEqual([]);
  });
});
