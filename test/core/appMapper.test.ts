import { describe, it, expect } from 'vitest';
import {
  getFolderNameCandidates,
  findFolderPath,
  buildDebugTargets,
  buildFallbackTargets,
  resolveOverrideFolder,
} from '../../src/core/appMapper';
import type { AppFolderMapping } from '../../src/types/index';

describe('getFolderNameCandidates', () => {
  it('returns both exact match and underscore-replaced match for hyphenated names', () => {
    expect(getFolderNameCandidates('myapp-svc-one')).toEqual([
      'myapp-svc-one',
      'myapp_svc_one',
    ]);
  });

  it('returns only exact match if no hyphens exist', () => {
    expect(getFolderNameCandidates('myapp')).toEqual(['myapp']);
    expect(getFolderNameCandidates('myapp_svc_one')).toEqual(['myapp_svc_one']);
  });

  it('handles single-hyphen names', () => {
    expect(getFolderNameCandidates('a-b')).toEqual(['a-b', 'a_b']);
  });
});

describe('findFolderPath', () => {
  const paths = [
    '/root/group/sub-a/myapp_svc_one',
    '/root/group/sub-a/myapp_db_one',
    '/root/group/sub-b/myapp_svc_two',
    '/root/group/sub-c/myapp_helper_one',
  ];

  it('returns the full path when exact basename match found', () => {
    expect(findFolderPath('myapp_svc_one', paths)).toBe(
      '/root/group/sub-a/myapp_svc_one',
    );
  });

  it('matches underscore folder when CF app name uses hyphens', () => {
    // CF app is named 'myapp-svc-one', local folder is 'myapp_svc_one'
    // This exercises the getFolderNameCandidates integration inside findFolderPath
    expect(findFolderPath('myapp-svc-one', paths)).toBe(
      '/root/group/sub-a/myapp_svc_one',
    );
  });

  it('returns null when no match found', () => {
    expect(findFolderPath('myapp_svc_unknown', paths)).toBeNull();
  });

  it('returns null for empty folder list', () => {
    expect(findFolderPath('myapp_svc_one', [])).toBeNull();
  });

  it('matches deeply nested folder by basename', () => {
    expect(findFolderPath('myapp_helper_one', paths)).toBe(
      '/root/group/sub-c/myapp_helper_one',
    );
  });

  it('returns first match when multiple folders share the same basename', () => {
    const duplicatePaths = [
      '/group/a/myapp_svc_one',
      '/group/b/myapp_svc_one',
    ];
    expect(findFolderPath('myapp_svc_one', duplicatePaths)).toBe('/group/a/myapp_svc_one');
  });
});

describe('buildDebugTargets', () => {
  const allFolderPaths = [
    '/root/group/sub-a/myapp_svc_one',
    '/root/group/sub-a/myapp_db_one',
    '/root/group/sub-b/myapp_svc_two',
  ];

  it('maps app names to debug targets with assigned ports', () => {
    const { targets, unmapped } = buildDebugTargets(
      ['myapp-svc-one', 'myapp-db-one'],
      allFolderPaths,
    );

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      appName: 'myapp-svc-one',
      folderPath: '/root/group/sub-a/myapp_svc_one',
      port: 20000,
    });
    expect(targets[1]).toMatchObject({
      appName: 'myapp-db-one',
      folderPath: '/root/group/sub-a/myapp_db_one',
      port: 20001,
    });
    expect(unmapped).toHaveLength(0);
  });

  it('adds unmapped apps to unmapped list', () => {
    const { targets, unmapped } = buildDebugTargets(
      ['myapp-svc-one', 'myapp-svc-unmapped'],
      allFolderPaths,
    );

    expect(targets).toHaveLength(1);
    expect(unmapped).toEqual(['myapp-svc-unmapped']);
  });

  it('increments ports starting from custom base port', () => {
    const { targets } = buildDebugTargets(
      ['myapp-svc-one', 'myapp-db-one'],
      allFolderPaths,
      {},
      new Set(),
      9300,
    );

    expect(targets[0]?.port).toBe(9300);
    expect(targets[1]?.port).toBe(9301);
  });

  it('returns empty targets and all unmapped when no paths match', () => {
    const { targets, unmapped } = buildDebugTargets(
      ['myapp-svc-unknown'],
      allFolderPaths,
    );

    expect(targets).toHaveLength(0);
    expect(unmapped).toEqual(['myapp-svc-unknown']);
  });

  it('handles empty app names list', () => {
    const { targets, unmapped } = buildDebugTargets([], allFolderPaths);
    expect(targets).toHaveLength(0);
    expect(unmapped).toHaveLength(0);
  });

  describe('stable port allocation and collision avoidance', () => {
    it('uses existingPorts if provided', () => {
      const { targets } = buildDebugTargets(
        ['myapp-svc-one'],
        allFolderPaths,
        { 'myapp-svc-one': 9999 },
      );
      expect(targets[0]?.port).toBe(9999);
    });

    it('skips usedPorts during new allocation', () => {
      const { targets } = buildDebugTargets(
        ['myapp-svc-one', 'myapp-db-one'],
        allFolderPaths,
        {},
        new Set([20000, 20002]), // 20000 and 20002 are occupied
      );
      // Should pick 20001 (next available after 20000)
      expect(targets[0]?.port).toBe(20001);
      // Should pick 20003 (skips 20002)
      expect(targets[1]?.port).toBe(20003);
    });

    it('handles mixed existing and new allocations correctly', () => {
      const { targets } = buildDebugTargets(
        ['app-fixed', 'app-new'],
        ['/root/app_fixed', '/root/app_new'],
        { 'app-fixed': 9500 },
        new Set([20000]),
      );
      expect(targets.find((t) => t.appName === 'app-fixed')?.port).toBe(9500);
      expect(targets.find((t) => t.appName === 'app-new')?.port).toBe(20001); // 20000 used, so 20001
    });

    it('marks existingPort as used so other apps do not collide with it', () => {
      // app-fixed gets port 9230 from existingPorts.
      // app-new must NOT also get 9230 — it should get 9231.
      const { targets } = buildDebugTargets(
        ['app-fixed', 'app-new'],
        ['/root/app_fixed', '/root/app_new'],
        { 'app-fixed': 20001 },
        new Set(),
        20000,
      );
      expect(targets.find((t) => t.appName === 'app-fixed')?.port).toBe(20001);
      // 20000 is the start, 20001 is taken by app-fixed's existingPort → skip to 20002
      expect(targets.find((t) => t.appName === 'app-new')?.port).toBe(20000);
    });
  });
});

describe('buildFallbackTargets', () => {
  const fallbackRoot = '/workspace/root';

  it('builds targets with noLocalFolder=true for all apps', () => {
    const targets = buildFallbackTargets(['app-a', 'app-b'], fallbackRoot);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ appName: 'app-a', folderPath: fallbackRoot, noLocalFolder: true });
    expect(targets[1]).toMatchObject({ appName: 'app-b', folderPath: fallbackRoot, noLocalFolder: true });
  });

  it('assigns sequential ports starting from DEBUG_BASE_PORT', () => {
    const targets = buildFallbackTargets(['app-a', 'app-b'], fallbackRoot);
    expect(targets[0]?.port).toBe(20000);
    expect(targets[1]?.port).toBe(20001);
  });

  it('respects existingPorts', () => {
    const targets = buildFallbackTargets(['app-a'], fallbackRoot, { 'app-a': 9500 });
    expect(targets[0]?.port).toBe(9500);
  });

  it('skips usedPorts', () => {
    const targets = buildFallbackTargets(['app-a', 'app-b'], fallbackRoot, {}, new Set([20000]));
    expect(targets[0]?.port).toBe(20001);
    expect(targets[1]?.port).toBe(20002);
  });

  it('avoids collisions between existingPort and new allocations', () => {
    // app-a claims 20001 via existingPorts; app-b must not also get 20001
    const targets = buildFallbackTargets(
      ['app-a', 'app-b'],
      fallbackRoot,
      { 'app-a': 20001 },
      new Set(),
      20000,
    );
    expect(targets.find((t) => t.appName === 'app-a')?.port).toBe(20001);
    expect(targets.find((t) => t.appName === 'app-b')?.port).toBe(20000);
  });

  it('returns empty array for empty input', () => {
    expect(buildFallbackTargets([], fallbackRoot)).toEqual([]);
  });
});

describe('resolveOverrideFolder', () => {
  const overrides: AppFolderMapping[] = [
    { appName: 'sample-service-billing', folderName: 'billing-internal' },
    { appName: 'sample-service-core', folderName: 'core-svc' },
  ];

  it('returns the configured folder name for a matching app', () => {
    expect(resolveOverrideFolder('sample-service-billing', overrides)).toBe('billing-internal');
  });

  it('returns undefined when no override matches', () => {
    expect(resolveOverrideFolder('sample-service-other', overrides)).toBeUndefined();
  });

  it('returns undefined for undefined or empty overrides', () => {
    expect(resolveOverrideFolder('sample-service-billing')).toBeUndefined();
    expect(resolveOverrideFolder('sample-service-billing', [])).toBeUndefined();
  });

  it('returns the first match when duplicate app names are configured', () => {
    const duplicates: AppFolderMapping[] = [
      { appName: 'sample-service-billing', folderName: 'first-folder' },
      { appName: 'sample-service-billing', folderName: 'second-folder' },
    ];
    expect(resolveOverrideFolder('sample-service-billing', duplicates)).toBe('first-folder');
  });

  it('matches app names case-sensitively', () => {
    expect(resolveOverrideFolder('Sample-Service-Billing', overrides)).toBeUndefined();
  });
});

describe('getFolderNameCandidates with overrides', () => {
  it('prepends the override folder ahead of exact and underscore candidates', () => {
    const overrides: AppFolderMapping[] = [{ appName: 'my-cap-app', folderName: 'custom-folder' }];
    expect(getFolderNameCandidates('my-cap-app', overrides)).toEqual([
      'custom-folder',
      'my-cap-app',
      'my_cap_app',
    ]);
  });

  it('ignores overrides that do not match the app name', () => {
    const overrides: AppFolderMapping[] = [{ appName: 'other-app', folderName: 'custom-folder' }];
    expect(getFolderNameCandidates('my-cap-app', overrides)).toEqual([
      'my-cap-app',
      'my_cap_app',
    ]);
  });

  it('does not duplicate when the override equals the exact app name', () => {
    const overrides: AppFolderMapping[] = [{ appName: 'my-cap-app', folderName: 'my-cap-app' }];
    expect(getFolderNameCandidates('my-cap-app', overrides)).toEqual([
      'my-cap-app',
      'my_cap_app',
    ]);
  });

  it('does not duplicate when the override equals the underscore-normalized name', () => {
    const overrides: AppFolderMapping[] = [{ appName: 'my-cap-app', folderName: 'my_cap_app' }];
    expect(getFolderNameCandidates('my-cap-app', overrides)).toEqual([
      'my_cap_app',
      'my-cap-app',
    ]);
  });

  it('behaves identically to no-override mode when overrides are undefined or empty', () => {
    expect(getFolderNameCandidates('my-cap-app')).toEqual(['my-cap-app', 'my_cap_app']);
    expect(getFolderNameCandidates('my-cap-app', [])).toEqual(['my-cap-app', 'my_cap_app']);
  });
});

describe('findFolderPath with overrides', () => {
  const paths = [
    '/root/group/services/billing-internal',
    '/root/group/services/sample_service_core',
  ];

  it('resolves a folder whose basename is the override but not the app or underscore name', () => {
    const overrides: AppFolderMapping[] = [
      { appName: 'sample-service-billing', folderName: 'billing-internal' },
    ];
    // Without the override, neither 'sample-service-billing' nor
    // 'sample_service_billing' matches 'billing-internal' → null.
    expect(findFolderPath('sample-service-billing', paths)).toBeNull();
    expect(findFolderPath('sample-service-billing', paths, overrides)).toBe(
      '/root/group/services/billing-internal',
    );
  });

  it('falls back to exact/underscore candidates when the override folder is absent', () => {
    const overrides: AppFolderMapping[] = [
      { appName: 'sample-service-core', folderName: 'missing-folder' },
    ];
    expect(findFolderPath('sample-service-core', paths, overrides)).toBe(
      '/root/group/services/sample_service_core',
    );
  });
});

describe('buildDebugTargets with overrides', () => {
  const allFolderPaths = ['/root/group/services/billing-internal'];

  it('maps an app to an override-named folder the second re-derivation would otherwise drop', () => {
    const overrides: AppFolderMapping[] = [
      { appName: 'sample-service-billing', folderName: 'billing-internal' },
    ];
    const { targets, unmapped } = buildDebugTargets(
      ['sample-service-billing'],
      allFolderPaths,
      {},
      new Set(),
      undefined,
      overrides,
    );
    expect(unmapped).toHaveLength(0);
    expect(targets[0]).toMatchObject({
      appName: 'sample-service-billing',
      folderPath: '/root/group/services/billing-internal',
      port: 20000,
    });
  });

  it('leaves the same app unmapped without overrides (proves the gap the feature closes)', () => {
    const { targets, unmapped } = buildDebugTargets(
      ['sample-service-billing'],
      allFolderPaths,
    );
    expect(targets).toHaveLength(0);
    expect(unmapped).toEqual(['sample-service-billing']);
  });
});
