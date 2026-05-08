import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises');
vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: () => undefined,
    }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      dispose: vi.fn(),
      show: vi.fn(),
    }),
  },
}));

import {
  buildLaunchConfiguration,
  cleanStaleDebugConfigs,
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
  vi.mocked(fs.access).mockResolvedValue(undefined);
  // realpath is auto-mocked to return undefined; default to identity passthrough so existing
  // tests continue to compare raw paths. Tests that exercise symlink resolution override this.
  vi.mocked(fs.realpath).mockImplementation((path) => Promise.resolve(String(path)));
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
    });
  });

  it('omits the restart attribute so vscode-js-debug does not race with the extension reconnect', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.restart).toBeUndefined();
  });

  it('uses the repository root as localRoot', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.localRoot).toBe('/group/sub-a/myapp_svc_one');
  });

  it('keeps the gen/srv compiled output folder in the outFiles glob list', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.outFiles).toContain('/group/sub-a/myapp_svc_one/gen/srv/**/*.{js,cjs,mjs}');
  });

  it('sets sourceMaps to true', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.sourceMaps).toBe(true);
  });

  it('marks generated configs as cdsDebugManaged', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.cdsDebugManaged).toBe(true);
  });

  it('includes only the node internals skipFiles entry', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.skipFiles).toEqual(['<node_internals>/**']);
  });

  it('includes remoteRoot when explicitly provided', () => {
    const config = buildLaunchConfiguration(target, '/home/vcap/app'); // cspell:ignore vcap
    expect(config.remoteRoot).toBe('/home/vcap/app');
  });

  it('omits remoteRoot when not provided', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect('remoteRoot' in config).toBe(false);
  });

  it('extends outFiles to cover the runtime srv folder, not just gen/srv', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.outFiles).toContain('/group/sub-a/myapp_svc_one/srv/**/*.{js,cjs,mjs}');
  });

  it('includes additional CAP layout folders (app, lib, dist, build) in outFiles', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.outFiles).toContain('/group/sub-a/myapp_svc_one/app/**/*.{js,cjs,mjs}');
    expect(config.outFiles).toContain('/group/sub-a/myapp_svc_one/lib/**/*.{js,cjs,mjs}');
    expect(config.outFiles).toContain('/group/sub-a/myapp_svc_one/dist/**/*.{js,cjs,mjs}');
    expect(config.outFiles).toContain('/group/sub-a/myapp_svc_one/build/**/*.{js,cjs,mjs}');
  });

  it('excludes node_modules from outFiles via a negative glob', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.outFiles).toContain('!/group/sub-a/myapp_svc_one/**/node_modules/**');
  });

  it('sets resolveSourceMapLocations to null so remote source maps are not silently dropped', () => {
    const config = buildLaunchConfiguration(target, undefined);
    expect(config.resolveSourceMapLocations).toBeNull();
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

  it('uses the repository root even when generated output folders are absent', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget]);

    expect(configs[0]?.localRoot).toBe('/group/sub-a/myapp_svc_one');
    expect(configs[0]?.outFiles).toContain('/group/sub-a/myapp_svc_one/gen/srv/**/*.{js,cjs,mjs}');
  });

  it('uses workspace-level fallback remoteRoot when app config is absent', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget], { remoteRoot: '/home/vcap/fallback' }); // cspell:ignore vcap
    expect(configs[0]?.remoteRoot).toBe('/home/vcap/fallback');
  });

  it('uses a resolved remoteRoot when the selected config is regex-based', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations(
      [firstTarget],
      { remoteRoot: 'regex:^/(usr/)?sample-service-a$' },
      { resolvedRemoteRoots: new Map([[firstTarget.appName, '/usr/sample-service-a']]) },
    );

    expect(configs[0]?.remoteRoot).toBe('/usr/sample-service-a');
  });

  it('falls back to localRoot when a regex remoteRoot has not yet resolved', async () => {
    // Sprint 1 Fix #1 — the previous behavior silently omitted remoteRoot, leaving VS Code
    // without a path mapping rule and breakpoints unbound until a Stop+Start cycle warmed
    // the resolver cache. Falling back to localRoot guarantees launch.json always includes
    // remoteRoot when the user configured it via regex.
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget], {
      remoteRoot: 'regex:^/(usr/)?sample-service-a$',
    });

    expect(configs[0]?.remoteRoot).toBe('/group/sub-a/myapp_svc_one');
  });

  it('resolves localRoot via fs.realpath when the workspace path is a symlink', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.realpath).mockImplementation((path) => {
      if (path === '/group/sub-a/myapp_svc_one') {
        return Promise.resolve('/private/var/group/sub-a/myapp_svc_one');
      }
      return Promise.resolve(String(path));
    });

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget]);

    expect(configs[0]?.localRoot).toBe('/private/var/group/sub-a/myapp_svc_one');
    expect(configs[0]?.outFiles).toContain('/private/var/group/sub-a/myapp_svc_one/srv/**/*.{js,cjs,mjs}');
  });

  it('falls back to the raw localRoot when fs.realpath rejects', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.realpath).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget]);

    expect(configs[0]?.localRoot).toBe('/group/sub-a/myapp_svc_one');
  });

  it('lets cap-debug-config.json replace the default outFiles glob list', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      outFiles: ['/group/sub-a/myapp_svc_one/custom/**/*.js'],
    }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget]);

    expect(configs[0]?.outFiles).toEqual(['/group/sub-a/myapp_svc_one/custom/**/*.js']);
  });

  it('appends outFilesExtra to the defaults while keeping the trailing node_modules exclusion last', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      outFilesExtra: ['/group/sub-a/myapp_svc_one/extra/**/*.js'],
    }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget]);

    const outFiles = configs[0]?.outFiles ?? [];
    expect(outFiles).toContain('/group/sub-a/myapp_svc_one/srv/**/*.{js,cjs,mjs}');
    expect(outFiles).toContain('/group/sub-a/myapp_svc_one/extra/**/*.js');
    expect(outFiles[outFiles.length - 1]).toBe('!/group/sub-a/myapp_svc_one/**/node_modules/**');
  });

  it('lets cap-debug-config.json override resolveSourceMapLocations with an explicit glob list', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      resolveSourceMapLocations: ['${workspaceFolder}/**', '!**/node_modules/**'],
    }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget]);

    expect(configs[0]?.resolveSourceMapLocations).toEqual(['${workspaceFolder}/**', '!**/node_modules/**']);
  });

  it('flows sourceMapPathOverrides from cap-debug-config.json into the generated launch config', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      sourceMapPathOverrides: {
        '/home/vcap/app/*': '/group/sub-a/myapp_svc_one/*',
      },
    }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget]);

    expect(configs[0]?.sourceMapPathOverrides).toEqual({
      '/home/vcap/app/*': '/group/sub-a/myapp_svc_one/*',
    });
  });

  it('per-service outFiles take priority over workspace-level outFiles', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      outFiles: ['/group/sub-a/myapp_svc_one/per-service/**/*.js'],
    }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations(
      [firstTarget],
      { outFiles: ['/group/workspace/**/*.js'] },
    );

    expect(configs[0]?.outFiles).toEqual(['/group/sub-a/myapp_svc_one/per-service/**/*.js']);
  });

  it('app-level remoteRoot takes priority over workspace fallback', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: '/home/vcap/app-level' })); // cspell:ignore vcap

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations([firstTarget], { remoteRoot: '/home/vcap/workspace-level' });
    expect(configs[0]?.remoteRoot).toBe('/home/vcap/app-level');
  });

  it('does not let a resolved regex override an app-level literal remoteRoot', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: '/sample/app-literal' }));

    const firstTarget = TARGETS[0];
    if (!firstTarget) throw new Error('TARGETS[0] must exist');
    const configs = await generateLaunchConfigurations(
      [firstTarget],
      { remoteRoot: 'regex:^/(usr/)?sample-service-a$' },
      { resolvedRemoteRoots: new Map([[firstTarget.appName, '/usr/sample-service-a']]) },
    );

    expect(configs[0]?.remoteRoot).toBe('/sample/app-literal');
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
          localRoot: '/group/sub-a/myapp_svc_one',
          sourceMaps: true,
          restart: true,
          skipFiles: ['<node_internals>/**'],
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

  it('returns an empty configurations array when configurations is not an array', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: '0.2.0', configurations: 'invalid' }));

    const result = await getExistingLaunchConfigs('/workspace');

    expect(result).toEqual({ version: '0.2.0', configurations: [] });
  });
});

describe('mergeLaunchJson', () => {
  it('uses the provided fallback config when writing generated launch configs', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await mergeLaunchJson('/workspace', TARGETS, { remoteRoot: '/sample/global-root' });

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      configurations: { name: string; remoteRoot?: string }[];
    };

    expect(written.configurations).toHaveLength(2);
    expect(written.configurations[0]?.remoteRoot).toBe('/sample/global-root');
    expect(written.configurations[1]?.remoteRoot).toBe('/sample/global-root');
  });

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

  it('falls back to the default version when merging a launch.json with an empty version', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ version: '', configurations: [] }));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await mergeLaunchJson('/workspace', TARGETS);

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      version: string;
    };

    expect(written.version).toBe('0.2.0');
  });
});

describe('cleanStaleDebugConfigs', () => {
  it('removes legacy CDS managed configs and preserves manual Debug-prefixed configs', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'Debug: stale-app-one', type: 'node', request: 'attach', address: '127.0.0.1', port: 20000 },
        { name: 'Debug: stale-app-two', type: 'node', request: 'attach', address: '127.0.0.1', port: 20001 },
        { name: 'Debug: manual-launch', type: 'node', request: 'launch', program: '${workspaceFolder}/app.js' },
        { name: 'My manual config', type: 'node', port: 8080 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await cleanStaleDebugConfigs('/workspace');

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      configurations: { name: string }[];
    };

    expect(written.configurations).toHaveLength(2);
    expect(written.configurations.find((c) => c.name === 'My manual config')).toBeDefined();
    expect(written.configurations.find((c) => c.name === 'Debug: manual-launch')).toBeDefined();
    expect(written.configurations.find((c) => c.name === 'Debug: stale-app-one')).toBeUndefined();
    expect(written.configurations.find((c) => c.name === 'Debug: stale-app-two')).toBeUndefined();
  });

  it('removes all legacy CDS managed configs when no manual configs exist', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'Debug: app-a', type: 'node', request: 'attach', address: '127.0.0.1', port: 20000 },
        { name: 'Debug: app-b', type: 'node', request: 'attach', address: '127.0.0.1', port: 20001 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await cleanStaleDebugConfigs('/workspace');

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      configurations: unknown[];
    };

    expect(written.configurations).toHaveLength(0);
  });

  it('removes marker-based managed configs even without Debug: prefix', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'CDS generated', type: 'node', request: 'attach', address: '127.0.0.1', port: 20000, cdsDebugManaged: true },
        { name: 'Manual config', type: 'node', request: 'launch', program: '${workspaceFolder}/index.js' },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await cleanStaleDebugConfigs('/workspace');

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      configurations: { name: string }[];
    };

    expect(written.configurations).toHaveLength(1);
    expect(written.configurations[0]?.name).toBe('Manual config');
  });

  it('does not write to disk when no managed configurations exist', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'My manual config', type: 'node', port: 8080 },
        { name: 'Debug: manual-launch', type: 'node', request: 'launch', program: '${workspaceFolder}/app.js' },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));

    await cleanStaleDebugConfigs('/workspace');

    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('does nothing when launch.json does not exist', async () => {
    vi.mocked(fs.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await cleanStaleDebugConfigs('/workspace');

    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('writes output with trailing newline', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'Debug: app-a', type: 'node', request: 'attach', address: '127.0.0.1', port: 20000 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await cleanStaleDebugConfigs('/workspace');

    const content = vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string;
    expect(content.endsWith('\n')).toBe(true);
  });

  it('falls back to the default version when cleaning configs from a launch.json with an empty version', async () => {
    const existing = {
      version: '',
      configurations: [
        { name: 'Debug: app-a', type: 'node', request: 'attach', address: '127.0.0.1', port: 20000 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await cleanStaleDebugConfigs('/workspace');

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      version: string;
    };

    expect(written.version).toBe('0.2.0');
  });
});

describe('removeLaunchConfigs', () => {
  it('removes matching configs by app name', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'Debug: myapp-svc-one', type: 'node', request: 'attach', address: '127.0.0.1', port: 9229 },
        { name: 'Debug: myapp-svc-two', type: 'node', request: 'attach', address: '127.0.0.1', port: 9230 },
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
        { name: 'Debug: myapp-svc-one', type: 'node', request: 'attach', address: '127.0.0.1', port: 9229 },
        { name: 'Debug: myapp-svc-two', type: 'node', request: 'attach', address: '127.0.0.1', port: 9230 },
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

  it('preserves manual config with the same name when not managed by CDS Debug', async () => {
    const existing = {
      version: '0.2.0',
      configurations: [
        { name: 'Debug: myapp-svc-one', type: 'node', request: 'launch', program: '${workspaceFolder}/index.js' },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));

    await removeLaunchConfigs('/workspace', ['myapp-svc-one']);

    expect(fs.writeFile).not.toHaveBeenCalled();
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

  it('falls back to the default version when removing configs from a launch.json with an empty version', async () => {
    const existing = {
      version: '',
      configurations: [
        { name: 'Debug: myapp-svc-one', type: 'node', request: 'attach', address: '127.0.0.1', port: 9229 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await removeLaunchConfigs('/workspace', ['myapp-svc-one']);

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      version: string;
    };

    expect(written.version).toBe('0.2.0');
  });
});
