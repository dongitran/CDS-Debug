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

import {
  getCredentials,
  getCredentialSource,
  clearShellEnvCache,
  saveCredentialsToSecretStorage,
  clearCredentialsFromSecretStorage,
  maskEmail,
  setSecretStorage,
  type SecretStorageLike,
} from '../../src/core/shellEnv';

const originalShell = process.env.SHELL;

beforeEach(() => {
  execFileAsyncMock.mockReset();
  clearShellEnvCache();
  setSecretStorage(undefined);
  delete process.env.SAP_EMAIL;
  delete process.env.SAP_PASSWORD;
  process.env.SHELL = '/bin/zsh';
});

afterEach(() => {
  setSecretStorage(undefined);
  delete process.env.SAP_EMAIL;
  delete process.env.SAP_PASSWORD;
  process.env.SHELL = originalShell;
});

/** Creates an in-memory SecretStorageLike for testing. */
function makeSecretStorage(initial: Record<string, string> = {}): SecretStorageLike {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    store: (key: string, value: string) => { store.set(key, value); return Promise.resolve(); },
    delete: (key: string) => { store.delete(key); return Promise.resolve(); },
  };
}

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

  it('falls back to SecretStorage when env and shell env have no credentials', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: 'HOME=/home/user\n' });
    setSecretStorage(makeSecretStorage({
      'cds-debug.credentials.email': 'keychain@example.com',
      'cds-debug.credentials.password': 'keychain-secret',
    }));

    const result = await getCredentials();

    expect(result).toEqual({ email: 'keychain@example.com', password: 'keychain-secret' });
  });

  it('prefers process.env credentials over SecretStorage', async () => {
    process.env.SAP_EMAIL = 'env@example.com';
    process.env.SAP_PASSWORD = 'env-secret';
    setSecretStorage(makeSecretStorage({
      'cds-debug.credentials.email': 'keychain@example.com',
      'cds-debug.credentials.password': 'keychain-secret',
    }));

    const result = await getCredentials();

    expect(result.email).toBe('env@example.com');
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('returns empty strings when all three sources lack credentials', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: 'HOME=/home/user\n' });
    setSecretStorage(makeSecretStorage({}));

    const result = await getCredentials();

    expect(result).toEqual({ email: '', password: '' });
  });
});

describe('getCredentialSource', () => {
  it('returns "env" when credentials are in process.env', async () => {
    process.env.SAP_EMAIL = 'user@example.com';
    process.env.SAP_PASSWORD = 'secret';

    const source = await getCredentialSource();

    expect(source).toBe('env');
  });

  it('returns "keychain" when credentials are only in SecretStorage', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '' });
    setSecretStorage(makeSecretStorage({
      'cds-debug.credentials.email': 'k@example.com',
      'cds-debug.credentials.password': 'kpw',
    }));

    const source = await getCredentialSource();

    expect(source).toBe('keychain');
  });

  it('returns "none" when no credentials are configured', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '' });
    setSecretStorage(makeSecretStorage({}));

    const source = await getCredentialSource();

    expect(source).toBe('none');
  });
});

describe('saveCredentialsToSecretStorage', () => {
  it('stores email and password in SecretStorage', async () => {
    const storage = makeSecretStorage();
    setSecretStorage(storage);

    await saveCredentialsToSecretStorage('user@example.com', 'mypassword');

    expect(await storage.get('cds-debug.credentials.email')).toBe('user@example.com');
    expect(await storage.get('cds-debug.credentials.password')).toBe('mypassword');
  });

  it('clears the shell env cache so next getCredentials() re-evaluates', async () => {
    execFileAsyncMock.mockResolvedValue({ stdout: '' });
    const storage = makeSecretStorage();
    setSecretStorage(storage);

    // Warm up the cache
    await getCredentials();
    expect(execFileAsyncMock).toHaveBeenCalledOnce();

    // Save new credentials — should bust the cache
    await saveCredentialsToSecretStorage('new@example.com', 'newpw');
    await getCredentials();
    // Shell spawned again because cache was cleared
    expect(execFileAsyncMock).toHaveBeenCalledTimes(2);
  });

  it('throws when SecretStorage is not initialized', async () => {
    // _secretStorage is undefined (reset in beforeEach)
    await expect(saveCredentialsToSecretStorage('a@b.com', 'pw')).rejects.toThrow(
      'SecretStorage is not available',
    );
  });
});

describe('clearCredentialsFromSecretStorage', () => {
  it('removes stored credentials from SecretStorage', async () => {
    const storage = makeSecretStorage({
      'cds-debug.credentials.email': 'user@example.com',
      'cds-debug.credentials.password': 'secret',
    });
    setSecretStorage(storage);

    await clearCredentialsFromSecretStorage();

    expect(await storage.get('cds-debug.credentials.email')).toBeUndefined();
    expect(await storage.get('cds-debug.credentials.password')).toBeUndefined();
  });

  it('does nothing when SecretStorage is not initialized', async () => {
    // Should not throw even when _secretStorage is undefined
    await expect(clearCredentialsFromSecretStorage()).resolves.toBeUndefined();
  });
});

describe('maskEmail', () => {
  it('masks the local part keeping first and last character', () => {
    expect(maskEmail('dongtran@sap.com')).toBe('d***n@sap.com');
  });

  it('handles short local parts (≤2 chars)', () => {
    expect(maskEmail('ab@sap.com')).toBe('a***@sap.com');
    expect(maskEmail('a@sap.com')).toBe('a***@sap.com');
  });

  it('returns *** for malformed input (no @)', () => {
    expect(maskEmail('notanemail')).toBe('***');
  });

  it('returns empty string for empty input', () => {
    expect(maskEmail('')).toBe('');
  });

  it('preserves the full domain', () => {
    expect(maskEmail('user@subdomain.example.com')).toBe('u***r@subdomain.example.com');
  });
});
