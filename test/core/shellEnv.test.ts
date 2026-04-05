import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../src/core/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: () => execFileAsyncMock,
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { getCredentials, clearShellEnvCache } from '../../src/core/shellEnv';

const originalShell = process.env.SHELL;

beforeEach(() => {
  execFileAsyncMock.mockReset();
  clearShellEnvCache();
  delete process.env.SAP_EMAIL;
  delete process.env.SAP_PASSWORD;
  process.env.SHELL = '/bin/zsh';
});

afterEach(() => {
  delete process.env.SAP_EMAIL;
  delete process.env.SAP_PASSWORD;
  process.env.SHELL = originalShell;
});

describe('getCredentials', () => {
  it('returns credentials from process.env immediately without spawning a shell', async () => {
    process.env.SAP_EMAIL = 'user@example.com';
    process.env.SAP_PASSWORD = 'secret123';

    const result = await getCredentials();

    expect(result).toEqual({ email: 'user@example.com', password: 'secret123' });
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('falls back to login-shell env when process.env lacks both credentials', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: 'HOME=/home/user\nSAP_EMAIL=shell@example.com\nSAP_PASSWORD=shell-secret\nSHELL=/bin/zsh\n',
    });

    const result = await getCredentials();

    expect(result).toEqual({ email: 'shell@example.com', password: 'shell-secret' });
    expect(execFileAsyncMock).toHaveBeenCalledOnce();
  });

  it('returns empty strings when credentials are absent from both sources', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: 'HOME=/home/user\nSHELL=/bin/zsh\n' });

    const result = await getCredentials();

    expect(result).toEqual({ email: '', password: '' });
  });

  it('returns empty strings and does not throw when login-shell spawn fails', async () => {
    execFileAsyncMock.mockRejectedValue(new Error('spawn ENOENT'));

    const result = await getCredentials();

    expect(result).toEqual({ email: '', password: '' });
  });

  it('returns empty strings when process.env has email but no password', async () => {
    process.env.SAP_EMAIL = 'user@example.com';
    // SAP_PASSWORD not set
    execFileAsyncMock.mockResolvedValue({ stdout: 'HOME=/home/user\n' });

    const result = await getCredentials();

    expect(result).toEqual({ email: '', password: '' });
  });

  it('parses env values that contain = characters', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: 'SAP_EMAIL=user@example.com\nSAP_PASSWORD=pass=with=equals\n',
    });

    const result = await getCredentials();

    expect(result.password).toBe('pass=with=equals');
  });

  it('caches login-shell env so the shell is only spawned once across multiple calls', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: 'SAP_EMAIL=cached@example.com\nSAP_PASSWORD=cached-pw\n',
    });

    await getCredentials();
    await getCredentials();

    expect(execFileAsyncMock).toHaveBeenCalledOnce();
  });

  it('spawns shell again after clearShellEnvCache() is called', async () => {
    execFileAsyncMock.mockResolvedValue({
      stdout: 'SAP_EMAIL=user@example.com\nSAP_PASSWORD=pw\n',
    });

    await getCredentials();
    clearShellEnvCache();
    await getCredentials();

    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
  });

  it('uses -l -i -c env args for POSIX shells (zsh, bash)', async () => {
    process.env.SHELL = '/bin/zsh';
    execFileAsyncMock.mockResolvedValue({ stdout: '' });

    await getCredentials();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-l', '-i', '-c', 'env'],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('uses -l -c env args for fish shell (no -i flag)', async () => {
    process.env.SHELL = '/usr/bin/fish';
    execFileAsyncMock.mockResolvedValue({ stdout: '' });

    await getCredentials();

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      '/usr/bin/fish',
      ['-l', '-c', 'env'],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('falls back to /bin/zsh when SHELL env var is not set', async () => {
    delete process.env.SHELL;
    execFileAsyncMock.mockResolvedValue({ stdout: '' });

    await getCredentials();

    const calledShell = execFileAsyncMock.mock.calls[0]?.[0] as string;
    expect(calledShell).toBe('/bin/zsh');
  });
});
