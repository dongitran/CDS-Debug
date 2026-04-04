import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { cfApps, cfLogin, cfOrgs, cfTarget, cfTargetAndApps } from '../../src/core/cfClient';
import type { CfCliError } from '../../src/core/cfClient';

describe('cfClient command wrappers', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset();
  });

  it('cfLogin calls cf api then cf auth', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '' });

    await cfLogin('https://api.cf.eu10.hana.ondemand.com', 'user@example.com', 'secret');

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'cf',
      ['api', 'https://api.cf.eu10.hana.ondemand.com'],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'cf',
      ['auth', 'user@example.com', 'secret'],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
    );
  });

  it('cfOrgs parses org names from cf output', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: ['name', 'org-a', 'org-b'].join('\n'),
    });

    await expect(cfOrgs()).resolves.toEqual(['org-a', 'org-b']);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'cf',
      ['orgs'],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
    );
  });

  it('cfTarget uses default and custom spaces', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '' });

    await cfTarget('org-main');
    await cfTarget('org-main', 'dev');

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'cf',
      ['target', '-o', 'org-main', '-s', 'app'],
      expect.any(Object),
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'cf',
      ['target', '-o', 'org-main', '-s', 'dev'],
      expect.any(Object),
    );
  });

  it('cfApps parses app states from cf apps output', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: [
        'name requested state processes routes',
        'svc-one  started  web:1/1  svc-one.cfapps.br10.hana.ondemand.com',
      ].join('\n'),
    });

    await expect(cfApps()).resolves.toEqual([
      {
        name: 'svc-one',
        state: 'started',
        urls: ['svc-one.cfapps.br10.hana.ondemand.com'],
      },
    ]);
  });

  it('cfTargetAndApps targets org before loading apps', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({
        stdout: [
          'name requested state processes routes',
          'svc-two  stopped  web:0/1  svc-two.cfapps.br10.hana.ondemand.com',
        ].join('\n'),
      });

    await expect(cfTargetAndApps('org-main')).resolves.toEqual([
      {
        name: 'svc-two',
        state: 'stopped',
        urls: ['svc-two.cfapps.br10.hana.ondemand.com'],
      },
    ]);

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'cf',
      ['target', '-o', 'org-main', '-s', 'app'],
      expect.any(Object),
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'cf',
      ['apps'],
      expect.any(Object),
    );
  });

  it('retries cf auth and succeeds on first retry', async () => {
    vi.useFakeTimers();
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })                           // cf api
      .mockRejectedValueOnce({ message: 'connect timeout', stderr: '' }) // auth attempt 1 fails
      .mockResolvedValueOnce({ stdout: '' });                          // auth attempt 2 succeeds

    const loginPromise = cfLogin('https://api.cf.eu10.hana.ondemand.com', 'user@example.com', 'secret');
    await vi.runAllTimersAsync();

    await expect(loginPromise).resolves.toBeUndefined();
    expect(execFileAsyncMock).toHaveBeenCalledTimes(3); // api + 2 auth calls
    vi.useRealTimers();
  });

  it('throws CfCliError after all 3 cf auth retries are exhausted', async () => {
    vi.useFakeTimers();
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })                                   // cf api
      .mockRejectedValueOnce({ message: 'persistent error', stderr: 'FAILED' }) // auth attempt 1
      .mockRejectedValueOnce({ message: 'persistent error', stderr: 'FAILED' }) // auth attempt 2
      .mockRejectedValueOnce({ message: 'persistent error', stderr: 'FAILED' }) // auth attempt 3
      .mockRejectedValueOnce({ message: 'persistent error', stderr: 'FAILED' }); // auth attempt 4

    const loginPromise = cfLogin('https://api.cf.eu10.hana.ondemand.com', 'user@example.com', 'secret');
    // Pre-attach a noop catch so the rejection is never "unhandled" during timer execution
    loginPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    await expect(loginPromise).rejects.toMatchObject({ name: 'CfCliError', message: 'persistent error' });
    expect(execFileAsyncMock).toHaveBeenCalledTimes(5); // api + 4 auth calls (1 + 3 retries)
    vi.useRealTimers();
  });

  it('wraps CLI failures as CfCliError with trimmed stderr', async () => {
    execFileAsyncMock.mockRejectedValue({
      message: 'cf failed',
      stderr: ' permission denied \n',
    });

    await expect(cfOrgs()).rejects.toEqual(
      expect.objectContaining<CfCliError>({
        name: 'CfCliError',
        message: 'cf failed',
        stderr: 'permission denied',
      }),
    );
  });
});
