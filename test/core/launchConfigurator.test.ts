import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises');

import {
  buildLaunchConfiguration,
  readCapDebugConfig,
  generateLaunchConfigurations,
  getExistingLaunchConfigs,
  mergeLaunchJson,
  removeLaunchConfigs,
} from '../../src/core/launchConfigurator';
import type { DebugTarget } from '../../src/types/index';
import * as fs from 'node:fs/promises';

const TARGETS: DebugTarget[] = [
  { appName: 'myapp-svc-one', folderPath: '/group/sub-a/myapp_svc_one', port: 9229 },
  { appName: 'myapp-svc-two', folderPath: '/group/sub-b/myapp_svc_two', port: 9230 },
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe('readCapDebugConfig', () => {
  it('returns null when file does not exist', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await readCapDebugConfig('/some/folder');
    expect(result).toBeNull();
  });

  it('returns remoteRoot when file exists with valid remoteRoot', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: '/home/vcap/app' })); // cspell:ignore vcap

    const result = await readCapDebugConfig('/some/folder');
    expect(result).toEqual({ remoteRoot: '/home/vcap/app' });
  });

  it('returns empty object when file exists but remoteRoot is not a string', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: 123 }));

    const result = await readCapDebugConfig('/some/folder');
    expect(result).toEqual({});
  });

  it('returns null when JSON is invalid', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{ invalid json }');

    const result = await readCapDebugConfig('/some/folder');
    expect(result).toBeNull();
  });

  it('returns null when parsed JSON is not an object', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('null');

    const result = await readCapDebugConfig('/some/folder');
    expect(result).toBeNull();
  });
});

describe('buildLaunchConfiguration', () => {
  const target: DebugTarget = { appName: 'myapp-svc-one', folderPath: '/group/sub-a/myapp_svc_one', port: 9229 };

  it('sets correct name, port, address, and attach mode', () => {
    const config = buildLaunchConfiguration(target, undefined);

    expect(config).toMatchObject({
      type: 'node',
      request: 'attach',
      name: 'Debug: myapp-svc-one',
      address: '127.0.0.1',
      port: 9229,
      restart: true,
    });
  });

  it('appends gen/srv to localRoot', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.localRoot).toBe('/group/sub-a/myapp_svc_one/gen/srv');
  });

  it('sets outFiles using the gen/srv path', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.outFiles).toContain('/group/sub-a/myapp_svc_one/gen/srv/**/*.js');
  });

  it('sets sourceMaps to true', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.sourceMaps).toBe(true);
  });

  it('includes both skipFiles entries', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.skipFiles).toContain('<node_internals>/**');
    expect(config.skipFiles).toContain('**/node_modules/**');
  });

  it('includes remoteRoot when explicitly provided', () => {
    const config = buildLaunchConfiguration(target, '/home/vcap/app'); // cspell:ignore vcap
    expect(config.remoteRoot).toBe('/home/vcap/app');
  });

  it('omits remoteRoot when not provided', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect('remoteRoot' in config).toBe(false);
  });
});

describe('generateLaunchConfigurations', () => {
  it('generates one configuration per target', async () => {
    // No cap-debug-config.json — readFile throws ENOENT for each
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const configs = await generateLaunchConfigurations(TARGETS);
    expect(configs).toHaveLength(2);
  });

  it('sets correct name and port for each target', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const configs = await generateLaunchConfigurations(TARGETS);

    expect(configs[0]).toMatchObject({ name: 'Debug: myapp-svc-one', port: 9229 });
    expect(configs[1]).toMatchObject({ name: 'Debug: myapp-svc-two', port: 9230 });
  });

  it('reads remoteRoot from cap-debug-config.json when present', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: '/home/vcap/app' })); // cspell:ignore vcap

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget]);
    expect(configs[0]?.remoteRoot).toBe('/home/vcap/app');
  });

  it('omits remoteRoot when cap-debug-config.json is absent', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget]);
    expect('remoteRoot' in (configs[0] ?? {})).toBe(false);
  });

  it('returns empty array for empty targets list', async () => {
    const configs = await generateLaunchConfigurations([]);
    expect(configs).toEqual([]);
  });

  it('uses workspace-level fallback remoteRoot when app config is absent', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget], { remoteRoot: '/home/vcap/fallback' }); // cspell:ignore vcap
    expect(configs[0]?.remoteRoot).toBe('/home/vcap/fallback');
  });

  it('app-level remoteRoot takes priority over workspace fallback', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: '/home/vcap/app-level' })); // cspell:ignore vcap

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget], { remoteRoot: '/home/vcap/workspace-level' });
    expect(configs[0]?.remoteRoot).toBe('/home/vcap/app-level');
  });
});

describe('getExistingLaunchConfigs', () => {
  it('returns default empty config when file does not exist', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await getExistingLaunchConfigs('/workspace');
    expect(result).toEqual({ version: '0.2.0', configurations: [] });
  });

  it('returns parsed config when file exists', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        {
          name: 'Debug: myapp-svc-one',
          type: 'node',
          request: 'attach',
          address: '127.0.0.1',
          port: 9229,
          localRoot: '/group/sub-a/myapp_svc_one/gen/srv',
          sourceMaps: true,
          restart: true,
          skipFiles: ['<node_internals>/**', '**/node_modules/**'],
          outFiles: ['/group/sub-a/myapp_svc_one/gen/srv/**/*.js'],
        },
      ],
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));

    const result = await getExistingLaunchConfigs('/workspace');
    expect(result.configurations).toHaveLength(1);
    expect(result.configurations[0]?.name).toBe('Debug: myapp-svc-one');
    expect(result.version).toBe('0.2.0');
  });

  it('returns default config when JSON is syntactically invalid', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('{ this: is not valid json }');

    const result = await getExistingLaunchConfigs('/workspace');
    expect(result).toEqual({ version: '0.2.0', configurations: [] });
  });

  it('returns default config when file content parses to a non-object (e.g. null)', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('null');

    const result = await getExistingLaunchConfigs('/workspace');
    expect(result).toEqual({ version: '0.2.0', configurations: [] });
  });

  it('uses fallback version when existing version is empty', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: '', configurations: [] }));

    const result = await getExistingLaunchConfigs('/workspace');
    expect(result.version).toBe('0.2.0');
  });

  it('filters out configurations without a name field', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({
        version: '0.2.0',
        configurations: [
          { type: 'node', port: 1234 },                      // no name → filtered
          { name: 'Valid Config', type: 'node', port: 5678 }, // has name → kept
          null,                                               // null → filtered
          'bad-entry',                                        // string → filtered
        ],
      }),
    );

    const result = await getExistingLaunchConfigs('/workspace');
    expect(result.configurations).toHaveLength(1);
    expect(result.configurations[0]?.name).toBe('Valid Config');
  });
});

describe('mergeLaunchJson', () => {
  it('writes new launch.json when file does not exist', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await mergeLaunchJson('/workspace', TARGETS);

    expect(fs.writeFile).toHaveBeenCalledOnce();
    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      configurations: unknown[];
    };

    expect(written.configurations).toHaveLength(2);
  });

  it('merges new configs into existing launch.json, replacing same-named entries', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'Debug: myapp-svc-one', type: 'node', port: 9999 },
        { name: 'My manual config', type: 'node', port: 8080 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await mergeLaunchJson('/workspace', TARGETS);

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      configurations: { name: string; port: number }[];
    };

    // manual config preserved
    expect(written.configurations.find((c) => c.name === 'My manual config')).toBeDefined();
    // existing entry replaced with new port
    const updated = written.configurations.find((c) => c.name === 'Debug: myapp-svc-one');
    expect(updated?.port).toBe(9229);
    // total: 1 manual + 2 new
    expect(written.configurations).toHaveLength(3);
  });

  it('tolerates malformed launch.json shape and still writes valid configs', async () => {
    const malformed = {
      version: '',
      configurations: [
        { type: 'node', port: 1234 },
        'bad-entry',
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(malformed));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await mergeLaunchJson('/workspace', TARGETS);

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      version: string;
      configurations: { name?: string }[];
    };

    expect(written.version).toBe('0.2.0');
    expect(written.configurations).toHaveLength(2);
    expect(written.configurations[0]?.name).toBe('Debug: myapp-svc-one');
    expect(written.configurations[1]?.name).toBe('Debug: myapp-svc-two');
  });

  it('writes output with trailing newline', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await mergeLaunchJson('/workspace', TARGETS);

    const content = vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string;
    expect(content.endsWith('\n')).toBe(true);
  });
});

describe('removeLaunchConfigs', () => {
  it('removes matching configs by app name', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'Debug: myapp-svc-one', type: 'node', port: 9229 },
        { name: 'Debug: myapp-svc-two', type: 'node', port: 9230 },
        { name: 'My manual config', type: 'node', port: 8080 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await removeLaunchConfigs('/workspace', ['myapp-svc-one']);

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      configurations: { name: string }[];
    };

    expect(written.configurations).toHaveLength(2);
    expect(written.configurations.find((c) => c.name === 'Debug: myapp-svc-one')).toBeUndefined();
    expect(written.configurations.find((c) => c.name === 'My manual config')).toBeDefined();
  });

  it('removes multiple configs at once', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'Debug: myapp-svc-one', type: 'node', port: 9229 },
        { name: 'Debug: myapp-svc-two', type: 'node', port: 9230 },
        { name: 'My manual config', type: 'node', port: 8080 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await removeLaunchConfigs('/workspace', ['myapp-svc-one', 'myapp-svc-two']);

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      configurations: { name: string }[];
    };

    expect(written.configurations).toHaveLength(1);
    expect(written.configurations[0]?.name).toBe('My manual config');
  });

  it('does nothing when no matching config names exist', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'My manual config', type: 'node', port: 8080 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));

    await removeLaunchConfigs('/workspace', ['nonexistent-app']);

    // writeFile should NOT be called since nothing changed
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('does nothing when appNames is empty', async () => {
    await removeLaunchConfigs('/workspace', []);

    expect(fs.readFile).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
