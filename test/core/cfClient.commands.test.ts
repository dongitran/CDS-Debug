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

import {
  cfApps,
  cfLogin,
  cfOrgs,
  cfSpaces,
  cfTarget,
  cfTargetAndApps,
  cfScaleAppInstances,
  cfTargetOrgAndSpaces,
  cfSshEnabled,
  cfEnableSsh,
  cfRestartApp,
  cfFindRemotePackageJsonPaths,
  CfCliError,
  isCfAuthError,
} from '../../src/core/cfClient';

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

  it('cfSpaces parses space names from cf output', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: ['name', 'app', 'dev'].join('\n'),
    });

    await expect(cfSpaces()).resolves.toEqual(['app', 'dev']);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'cf',
      ['spaces'],
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

  it('cfTargetOrgAndSpaces targets org before loading spaces', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: ['name', 'app', 'dev'].join('\n') });

    await expect(cfTargetOrgAndSpaces('org-main')).resolves.toEqual(['app', 'dev']);

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'cf',
      ['target', '-o', 'org-main'],
      expect.any(Object),
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'cf',
      ['spaces'],
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
        runningInstances: 1,
        totalInstances: 1,
        instanceProcessCount: 1,
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
        runningInstances: 0,
        totalInstances: 1,
        instanceProcessCount: 1,
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

  it('cfTargetAndApps targets the selected space before loading apps', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({
        stdout: [
          'name requested state processes routes',
          'svc-dev  started  web:1/1  svc-dev.cfapps.br10.hana.ondemand.com',
        ].join('\n'),
      });

    await expect(cfTargetAndApps('org-main', 'dev')).resolves.toEqual([
      {
        name: 'svc-dev',
        state: 'started',
        runningInstances: 1,
        totalInstances: 1,
        instanceProcessCount: 1,
        urls: ['svc-dev.cfapps.br10.hana.ondemand.com'],
      },
    ]);

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'cf',
      ['target', '-o', 'org-main', '-s', 'dev'],
      expect.any(Object),
    );
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'cf',
      ['apps'],
      expect.any(Object),
    );
  });

  it('cfScaleAppInstances scales through a shell-safe argument array', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '' });

    await cfScaleAppInstances('svc-one', 3);

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'cf',
      ['scale', 'svc-one', '-i', '3'],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
    );
  });

  it('cfFindRemotePackageJsonPaths lists package.json candidates through cf ssh', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: [
        '/usr/sample-service-a/package.json',
        '/sample-service-a/package.json',
      ].join('\n'),
    });

    await expect(cfFindRemotePackageJsonPaths('mock-service-a')).resolves.toEqual([
      '/usr/sample-service-a/package.json',
      '/sample-service-a/package.json',
    ]);

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'cf',
      ['ssh', 'mock-service-a', '-c', expect.stringContaining('find / -maxdepth')],
      expect.objectContaining({ maxBuffer: 10 * 1024 * 1024 }),
    );
  });

  it('cfFindRemotePackageJsonPaths preserves isolated CF_HOME when provided', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '/usr/sample-service-a/package.json\n' });

    await cfFindRemotePackageJsonPaths('mock-service-a', '/tmp/sample-cf-home');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'cf',
      ['ssh', 'mock-service-a', '-c', expect.any(String)],
      expect.objectContaining({
        env: expect.objectContaining({ CF_HOME: '/tmp/sample-cf-home' }),
      }),
    );
  });

  it('detects Cloud Foundry credential authentication errors', () => {
    expect(isCfAuthError(new Error('Authentication failed'))).toBe(true);
    expect(isCfAuthError(new CfCliError('login failed', 'Credentials were rejected'))).toBe(true);
    expect(isCfAuthError(new Error('Invalid email or password'))).toBe(true);
    expect(isCfAuthError(new Error('network unreachable'))).toBe(false);
    expect(isCfAuthError(new Error('connection refused'))).toBe(false);
    expect(isCfAuthError(new Error('The token expired'))).toBe(false);
  });

  it('does not retry cf auth when credentials are rejected', async () => {
    vi.useFakeTimers();
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValue({
        message: 'Command failed: cf auth sample.user@example.com sample-password',
        stderr: 'Authentication failed',
      });

    const loginPromise = cfLogin('https://api.cf.eu10.hana.ondemand.com', 'sample.user@example.com', 'sample-password');
    loginPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    await expect(loginPromise).rejects.toMatchObject({ name: 'CfCliError', message: 'Authentication failed' });
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
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

  it('redacts cf auth command arguments from login errors', async () => {
    vi.useFakeTimers();
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockRejectedValue({
        message: 'Command failed: cf auth user@example.com super-secret\nmock auth failed',
        stderr: 'mock auth failed',
      });

    const loginPromise = cfLogin('https://api.cf.eu10.hana.ondemand.com', 'user@example.com', 'super-secret');
    loginPromise.catch(() => undefined);
    await vi.runAllTimersAsync();

    try {
      await loginPromise;
      throw new Error('Expected cfLogin to reject.');
    } catch (err: unknown) {
      expect(err).toMatchObject({ name: 'CfCliError', message: 'mock auth failed' });
      expect(err instanceof Error ? err.message : String(err)).not.toContain('super-secret');
    } finally {
      vi.useRealTimers();
    }
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

  it('cfSshEnabled returns true when SSH is enabled', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: "ssh support is enabled for app 'my-app'.\n",
    });

    await expect(cfSshEnabled('my-app')).resolves.toBe(true);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'cf',
      ['ssh-enabled', 'my-app'],
      expect.any(Object),
    );
  });

  it('cfSshEnabled returns false when SSH is disabled', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: "ssh support is disabled for app 'my-app'.\nssh is disabled for app\n",
    });

    await expect(cfSshEnabled('my-app')).resolves.toBe(false);
  });

  it('cfSshEnabled returns false when CLI errors', async () => {
    execFileAsyncMock.mockRejectedValue({
      message: 'cf failed',
      stderr: 'FAILED',
    });

    await expect(cfSshEnabled('my-app')).resolves.toBe(false);
  });

  it('cfEnableSsh calls cf enable-ssh with app name', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: 'OK\n' });

    await cfEnableSsh('my-app');
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'cf',
      ['enable-ssh', 'my-app'],
      expect.any(Object),
    );
  });

  it('cfRestartApp calls cf restart with app name and timeout', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: 'OK\n' });

    await cfRestartApp('my-app');
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'cf',
      ['restart', 'my-app'],
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it('cfRestartApp throws CfCliError on failure', async () => {
    execFileAsyncMock.mockRejectedValue({
      message: 'restart timed out',
      stderr: 'FAILED\n',
    });

    await expect(cfRestartApp('my-app')).rejects.toEqual(
      expect.objectContaining<CfCliError>({
        name: 'CfCliError',
        message: 'restart timed out',
        stderr: 'FAILED',
      }),
    );
  });
});
