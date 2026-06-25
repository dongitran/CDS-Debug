import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureSshProxyMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/sshProxyTunnel', () => ({
  ensureSshProxy: ensureSshProxyMock,
}));

import { createCfProcessEnv } from '../../src/core/cfEnvironment';

const ORIGINAL_ENV = { ...process.env };

describe('cfEnvironment', () => {
  beforeEach(() => {
    ensureSshProxyMock.mockReset();
    process.env = { PATH: '/usr/bin', EXISTING_FLAG: 'preserved' };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('preserves the process environment when the proxy is disabled', async () => {
    ensureSshProxyMock.mockResolvedValue(undefined);

    await expect(createCfProcessEnv()).resolves.toEqual({
      PATH: '/usr/bin',
      EXISTING_FLAG: 'preserved',
    });
  });

  it('adds SOCKS variables without exposing SSH credentials', async () => {
    ensureSshProxyMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 49152,
    });

    const env = await createCfProcessEnv({ CF_HOME: '/tmp/cf-home' });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      EXISTING_FLAG: 'preserved',
      CF_HOME: '/tmp/cf-home',
      http_proxy: 'socks5://127.0.0.1:49152',
      HTTP_PROXY: 'socks5://127.0.0.1:49152',
      https_proxy: 'socks5://127.0.0.1:49152',
      HTTPS_PROXY: 'socks5://127.0.0.1:49152',
      all_proxy: 'socks5://127.0.0.1:49152',
      ALL_PROXY: 'socks5://127.0.0.1:49152',
    });
    expect(JSON.stringify(env)).not.toContain('home.example.com');
    expect(JSON.stringify(env)).not.toContain('dongtran');
    expect(JSON.stringify(env)).not.toContain('secret');
  });

  it('does not mutate process.env', async () => {
    ensureSshProxyMock.mockResolvedValue({ host: '127.0.0.1', port: 49152 });

    await createCfProcessEnv({ CF_HOME: '/tmp/cf-home' });

    expect(process.env).toEqual({
      PATH: '/usr/bin',
      EXISTING_FLAG: 'preserved',
    });
  });
});
