import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSshProxySettings,
  getSshProxyConnectionConfig,
  getSshProxyPublicSettings,
  initSshProxyStore,
  saveSshProxySettings,
  saveTrustedSshHostFingerprint,
  type SshProxyStoreContext,
} from '../../src/storage/sshProxyStore';

interface TestStore {
  readonly global: Map<string, unknown>;
  readonly secrets: Map<string, string>;
}

function makeContext(initialGlobal?: unknown): { context: SshProxyStoreContext; store: TestStore } {
  const global = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  if (initialGlobal !== undefined) {
    global.set('cds-debug.sshProxy.settings', initialGlobal);
  }

  return {
    context: {
      globalState: {
        get: (key: string): unknown => global.get(key),
        update: (key: string, value: unknown): Promise<void> => {
          if (value === undefined) global.delete(key);
          else global.set(key, value);
          return Promise.resolve();
        },
      },
      secrets: {
        get: (key: string): Promise<string | undefined> => Promise.resolve(secrets.get(key)),
        store: (key: string, value: string): Promise<void> => {
          secrets.set(key, value);
          return Promise.resolve();
        },
        delete: (key: string): Promise<void> => {
          secrets.delete(key);
          return Promise.resolve();
        },
      },
    },
    store: { global, secrets },
  };
}

describe('sshProxyStore', () => {
  beforeEach(() => {
    initSshProxyStore(undefined);
  });

  it('returns disabled defaults without exposing a password', async () => {
    const { context } = makeContext();
    initSshProxyStore(context);

    await expect(getSshProxyPublicSettings()).resolves.toEqual({
      enabled: false,
      host: '',
      port: 22,
      username: '',
      hasPassword: false,
    });
  });

  it('normalizes malformed persisted state', async () => {
    const { context } = makeContext({
      enabled: 'yes',
      host: 42,
      port: -1,
      username: null,
      trustedHostFingerprint: 99,
    });
    initSshProxyStore(context);

    await expect(getSshProxyPublicSettings()).resolves.toEqual({
      enabled: false,
      host: '',
      port: 22,
      username: '',
      hasPassword: false,
    });
  });

  it('stores the password only in SecretStorage', async () => {
    const { context, store } = makeContext();
    initSshProxyStore(context);

    await saveSshProxySettings({
      enabled: true,
      host: 'home.example.com',
      port: 44322,
      username: 'dongtran',
      password: 'not-in-global-state',
    });

    expect(store.global.get('cds-debug.sshProxy.settings')).toEqual({
      enabled: true,
      host: 'home.example.com',
      port: 44322,
      username: 'dongtran',
    });
    expect(JSON.stringify(store.global.get('cds-debug.sshProxy.settings'))).not.toContain('not-in-global-state');
    expect(store.secrets.get('cds-debug.sshProxy.password')).toBe('not-in-global-state');
  });

  it('keeps the existing password when an update omits it', async () => {
    const { context } = makeContext();
    initSshProxyStore(context);
    await saveSshProxySettings({
      enabled: true,
      host: 'old.example.com',
      port: 22,
      username: 'old-user',
      password: 'existing-secret',
    });

    await saveSshProxySettings({
      enabled: true,
      host: 'old.example.com',
      port: 44322,
      username: 'new-user',
    });

    await expect(getSshProxyConnectionConfig()).resolves.toMatchObject({
      host: 'old.example.com',
      port: 44322,
      username: 'new-user',
      password: 'existing-secret',
    });
  });

  it('resets the trusted fingerprint when host or port changes', async () => {
    const { context } = makeContext();
    initSshProxyStore(context);
    await saveSshProxySettings({
      enabled: true,
      host: 'old.example.com',
      port: 22,
      username: 'dongtran',
      password: 'secret',
    });
    await saveTrustedSshHostFingerprint('SHA256:trusted');

    await saveSshProxySettings({
      enabled: true,
      host: 'new.example.com',
      port: 22,
      username: 'dongtran',
    });

    await expect(getSshProxyConnectionConfig()).resolves.not.toHaveProperty('trustedHostFingerprint');
  });

  it('persists a trusted fingerprint without changing the password', async () => {
    const { context } = makeContext();
    initSshProxyStore(context);
    await saveSshProxySettings({
      enabled: true,
      host: 'home.example.com',
      port: 44322,
      username: 'dongtran',
      password: 'secret',
    });

    await saveTrustedSshHostFingerprint('SHA256:trusted');

    await expect(getSshProxyConnectionConfig()).resolves.toEqual({
      enabled: true,
      host: 'home.example.com',
      port: 44322,
      username: 'dongtran',
      password: 'secret',
      trustedHostFingerprint: 'SHA256:trusted',
    });
  });

  it('clears settings and password together', async () => {
    const { context, store } = makeContext();
    initSshProxyStore(context);
    await saveSshProxySettings({
      enabled: true,
      host: 'home.example.com',
      port: 44322,
      username: 'dongtran',
      password: 'secret',
    });

    await clearSshProxySettings();

    expect(store.global.size).toBe(0);
    expect(store.secrets.size).toBe(0);
    await expect(getSshProxyPublicSettings()).resolves.toMatchObject({
      enabled: false,
      hasPassword: false,
    });
  });
});
