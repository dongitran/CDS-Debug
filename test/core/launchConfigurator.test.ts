import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises');

import { generateLaunchConfigurations, mergeLaunchJson } from '../../src/core/launchConfigurator';
import type { DebugTarget } from '../../src/types/index';
import * as fs from 'node:fs/promises';

const TARGETS: DebugTarget[] = [
  { appName: 'prefix-srv-config-main', folderPath: '/group/core/config/prefix_srv_config_main', port: 9229 },
  { appName: 'prefix-srv-process-approver', folderPath: '/group/core/process/prefix_srv_process_approver', port: 9230 },
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe('generateLaunchConfigurations', () => {
  it('generates one configuration per target', () => {
    const configs = generateLaunchConfigurations(TARGETS);
    expect(configs).toHaveLength(2);
  });

  it('sets correct name, port and folder paths', () => {
    const configs = generateLaunchConfigurations(TARGETS);

    expect(configs[0]).toMatchObject({
      type: 'node',
      request: 'attach',
      name: 'Debug: prefix-srv-config-main',
      port: 9229,
      localRoot: '/group/core/config/prefix_srv_config_main',
      remoteRoot: '/group/core/config/prefix_srv_config_main',
      restart: true,
    });

    expect(configs[1]).toMatchObject({
      name: 'Debug: prefix-srv-process-approver',
      port: 9230,
      localRoot: '/group/core/process/prefix_srv_process_approver',
    });
  });

  it('includes skipFiles in every configuration', () => {
    const configs = generateLaunchConfigurations(TARGETS);
    for (const config of configs) {
      expect(config.skipFiles).toContain('<node_internals>/**');
    }
  });

  it('returns empty array for empty targets list', () => {
    expect(generateLaunchConfigurations([])).toEqual([]);
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
        { name: 'Debug: prefix-srv-config-main', type: 'node', port: 9999 },
        { name: 'My manual config', type: 'node', port: 8080 },
      ],
    };

    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(existing));
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    await mergeLaunchJson('/workspace', TARGETS);

    const written = JSON.parse((vi.mocked(fs.writeFile).mock.calls[0]?.[1] as string)) as {
      configurations: Array<{ name: string; port: number }>;
    };

    // manual config preserved
    expect(written.configurations.find((c) => c.name === 'My manual config')).toBeDefined();
    // existing entry replaced with new port
    const updated = written.configurations.find((c) => c.name === 'Debug: prefix-srv-config-main');
    expect(updated?.port).toBe(9229);
    // total: 1 manual + 2 new
    expect(written.configurations).toHaveLength(3);
  });
});
