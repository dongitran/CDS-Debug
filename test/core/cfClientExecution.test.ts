import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  createCfProcessEnv: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: () => mocks.execFileAsync,
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../../src/core/cfEnvironment', () => ({
  createCfProcessEnv: mocks.createCfProcessEnv,
}));

import { cfLogout, cfRestartApp } from '../../src/core/cfClient';

describe('cfClient process environment', () => {
  beforeEach(() => {
    mocks.execFileAsync.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
    mocks.createCfProcessEnv.mockReset().mockResolvedValue({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'socks5://127.0.0.1:49152',
    });
  });

  it('uses the shared CF environment for regular commands', async () => {
    await cfLogout('/tmp/cf-home');

    expect(mocks.createCfProcessEnv).toHaveBeenCalledWith({ CF_HOME: '/tmp/cf-home' });
    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'cf',
      ['logout'],
      expect.objectContaining({
        env: expect.objectContaining({ HTTPS_PROXY: 'socks5://127.0.0.1:49152' }),
      }),
    );
  });

  it('uses the shared CF environment for app restarts', async () => {
    await cfRestartApp('demo-app');

    expect(mocks.createCfProcessEnv).toHaveBeenCalledWith({});
    expect(mocks.execFileAsync).toHaveBeenCalledWith(
      'cf',
      ['restart', 'demo-app'],
      expect.objectContaining({
        env: expect.objectContaining({ HTTPS_PROXY: 'socks5://127.0.0.1:49152' }),
      }),
    );
  });
});
