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
      port: 9229,
    });
    expect(targets[1]).toMatchObject({
      appName: 'myapp-db-one',
      folderPath: '/root/group/sub-a/myapp_db_one',
      port: 9230,
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
});
