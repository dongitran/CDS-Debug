import { describe, it, expect } from 'vitest';
import {
  cfAppNameToFolderName,
  findFolderPath,
  buildDebugTargets,
} from '../../src/core/appMapper';

describe('cfAppNameToFolderName', () => {
  it('replaces all hyphens with underscores', () => {
    expect(cfAppNameToFolderName('prefix-srv-config-main')).toBe('prefix_srv_config_main');
  });

  it('handles single segment name', () => {
    expect(cfAppNameToFolderName('prefix')).toBe('prefix');
  });

  it('handles name with no hyphens', () => {
    expect(cfAppNameToFolderName('prefix_srv_config')).toBe('prefix_srv_config');
  });

  it('converts db module name', () => {
    expect(cfAppNameToFolderName('prefix-db-config')).toBe('prefix_db_config');
  });

  it('converts multi-role service name', () => {
    expect(cfAppNameToFolderName('prefix-srv-process-approver')).toBe('prefix_srv_process_approver');
  });
});

describe('findFolderPath', () => {
  const paths = [
    '/root/group/core/config/prefix_srv_config_main',
    '/root/group/core/config/prefix_db_config',
    '/root/group/core/process/prefix_srv_process_approver',
    '/root/group/helper/prefix_helper_common',
  ];

  it('returns the full path when exact basename match found', () => {
    expect(findFolderPath('prefix_srv_config_main', paths)).toBe(
      '/root/group/core/config/prefix_srv_config_main',
    );
  });

  it('returns null when no match found', () => {
    expect(findFolderPath('prefix_srv_data_quality', paths)).toBeNull();
  });

  it('returns null for empty folder list', () => {
    expect(findFolderPath('prefix_srv_config_main', [])).toBeNull();
  });

  it('matches deeply nested folder by basename', () => {
    expect(findFolderPath('prefix_helper_common', paths)).toBe(
      '/root/group/helper/prefix_helper_common',
    );
  });
});

describe('buildDebugTargets', () => {
  const allFolderPaths = [
    '/root/group/core/config/prefix_srv_config_main',
    '/root/group/core/config/prefix_db_config',
    '/root/group/core/process/prefix_srv_process_approver',
  ];

  it('maps app names to debug targets with assigned ports', () => {
    const { targets, unmapped } = buildDebugTargets(
      ['prefix-srv-config-main', 'prefix-db-config'],
      allFolderPaths,
    );

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      appName: 'prefix-srv-config-main',
      folderPath: '/root/group/core/config/prefix_srv_config_main',
      port: 9229,
    });
    expect(targets[1]).toMatchObject({
      appName: 'prefix-db-config',
      folderPath: '/root/group/core/config/prefix_db_config',
      port: 9230,
    });
    expect(unmapped).toHaveLength(0);
  });

  it('adds unmapped apps to unmapped list', () => {
    const { targets, unmapped } = buildDebugTargets(
      ['prefix-srv-config-main', 'prefix-srv-dqm'],
      allFolderPaths,
    );

    expect(targets).toHaveLength(1);
    expect(unmapped).toEqual(['prefix-srv-dqm']);
  });

  it('increments ports starting from custom base port', () => {
    const { targets } = buildDebugTargets(
      ['prefix-srv-config-main', 'prefix-db-config'],
      allFolderPaths,
      9300,
    );

    expect(targets[0]?.port).toBe(9300);
    expect(targets[1]?.port).toBe(9301);
  });

  it('returns empty targets and all unmapped when no paths match', () => {
    const { targets, unmapped } = buildDebugTargets(
      ['prefix-srv-unknown'],
      allFolderPaths,
    );

    expect(targets).toHaveLength(0);
    expect(unmapped).toEqual(['prefix-srv-unknown']);
  });

  it('handles empty app names list', () => {
    const { targets, unmapped } = buildDebugTargets([], allFolderPaths);
    expect(targets).toHaveLength(0);
    expect(unmapped).toHaveLength(0);
  });
});
