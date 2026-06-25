import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/cfEnvironment', () => ({
  createCfProcessEnv: vi.fn((overrides: NodeJS.ProcessEnv) => Promise.resolve({ ...overrides })),
}));
import {
  normalizeRemotePackageJsonPath,
  parseRemoteRootSetting,
  RemoteRootLookupCoordinator,
  resolveRemoteRootForApp,
} from '../../src/core/remoteRootResolver';

describe('parseRemoteRootSetting', () => {
  it('treats normal absolute paths as literal remote roots', () => {
    expect(parseRemoteRootSetting('/home/vcap/app')).toEqual({
      kind: 'literal',
      value: '/home/vcap/app',
    });
  });

  it('parses explicit regex prefix syntax', () => {
    const setting = parseRemoteRootSetting('regex:^/(usr/)?sample-service-a$');

    expect(setting.kind).toBe('regex');
    if (setting.kind !== 'regex') throw new Error('Expected regex setting.');
    expect(setting.pattern).toBe('^/(usr/)?sample-service-a$');
  });

  it('parses slash-delimited regex syntax with flags', () => {
    const setting = parseRemoteRootSetting('/sample-service-a$/i');

    expect(setting.kind).toBe('regex');
    if (setting.kind !== 'regex') throw new Error('Expected regex setting.');
    expect(setting.pattern).toBe('sample-service-a$');
    expect(setting.flags).toBe('i');
  });

  it('returns invalid-regex for malformed explicit regex syntax', () => {
    const setting = parseRemoteRootSetting('regex:[');

    expect(setting.kind).toBe('invalid-regex');
  });
});

describe('normalizeRemotePackageJsonPath', () => {
  it('converts package.json paths into normalized remote folders', () => {
    expect(normalizeRemotePackageJsonPath('/usr/sample-service-a/package.json')).toBe('/usr/sample-service-a');
    expect(normalizeRemotePackageJsonPath('/sample-service-a/package.json')).toBe('/sample-service-a');
  });

  it('returns null for non-package paths', () => {
    expect(normalizeRemotePackageJsonPath('/usr/sample-service-a/server.js')).toBeNull();
  });
});

describe('resolveRemoteRootForApp', () => {
  it('returns literal remote roots without calling CF SSH', async () => {
    let calls = 0;

    const result = await resolveRemoteRootForApp('mock-service-a', '/home/vcap/app', {
      findPackageJsonPaths: () => {
        calls += 1;
        return Promise.resolve(['/usr/sample-service-a/package.json']);
      },
    });

    expect(result).toEqual({ status: 'literal', remoteRoot: '/home/vcap/app' });
    expect(calls).toBe(0);
  });

  it('resolves regex remote roots from CF SSH package.json candidates', async () => {
    const result = await resolveRemoteRootForApp('mock-service-a', 'regex:^/(usr/)?sample-service-a$', {
      findPackageJsonPaths: () => Promise.resolve([
        '/opt/sample-service-b/package.json',
        '/usr/sample-service-a/package.json',
      ]),
    });

    expect(result).toEqual({
      status: 'resolved',
      remoteRoot: '/usr/sample-service-a',
      pattern: '^/(usr/)?sample-service-a$',
    });
  });

  it('chooses the shallowest matching remote folder deterministically', async () => {
    const result = await resolveRemoteRootForApp('mock-service-a', 'regex:sample-service-a', {
      findPackageJsonPaths: () => Promise.resolve([
        '/usr/sample-service-a/nested/package.json',
        '/sample-service-a/package.json',
        '/usr/sample-service-a/package.json',
      ]),
    });

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('Expected resolved remote root.');
    expect(result.remoteRoot).toBe('/sample-service-a');
  });

  it('returns unmatched when no remote folder matches the regex', async () => {
    const result = await resolveRemoteRootForApp('mock-service-a', 'regex:^/sample-service-a$', {
      findPackageJsonPaths: () => Promise.resolve(['/usr/sample-service-b/package.json']),
    });

    expect(result).toEqual({ status: 'unmatched', pattern: '^/sample-service-a$' });
  });
});

describe('RemoteRootLookupCoordinator', () => {
  it('shares concurrent lookups for the same cache key', async () => {
    const coordinator = new RemoteRootLookupCoordinator();
    let calls = 0;
    let releaseLookup: (() => void) | undefined;
    let markLookupStarted: (() => void) | undefined;
    const lookupReleased = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });

    const first = coordinator.resolve('same-key', 'mock-service-a', 'regex:^/(usr/)?sample-service-a$', {
      findPackageJsonPaths: async () => {
        calls += 1;
        if (markLookupStarted === undefined) throw new Error('Lookup start marker was not initialized.');
        markLookupStarted();
        await lookupReleased;
        return ['/usr/sample-service-a/package.json'];
      },
    });

    await lookupStarted;
    const second = coordinator.resolve('same-key', 'mock-service-a', 'regex:^/(usr/)?sample-service-a$', {
      findPackageJsonPaths: () => {
        calls += 1;
        return Promise.reject(new Error('duplicate lookup should not run'));
      },
    });

    if (releaseLookup === undefined) throw new Error('Lookup release was not initialized.');
    releaseLookup();

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        status: 'resolved',
        remoteRoot: '/usr/sample-service-a',
        pattern: '^/(usr/)?sample-service-a$',
      },
      {
        status: 'resolved',
        remoteRoot: '/usr/sample-service-a',
        pattern: '^/(usr/)?sample-service-a$',
      },
    ]);
    expect(calls).toBe(1);
  });
});
