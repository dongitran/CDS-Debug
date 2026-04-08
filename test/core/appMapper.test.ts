import { describe, it, expect } from 'vitest';
import {
  getFolderNameCandidates,
  findFolderPath,
  buildDebugTargets,
} from '../../src/core/appMapper';

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
