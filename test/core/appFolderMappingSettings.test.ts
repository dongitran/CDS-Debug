import { beforeEach, describe, expect, it, vi } from 'vitest';

interface VscodeConfigState {
  value: unknown;
}

const { vscodeConfigState } = vi.hoisted((): { vscodeConfigState: VscodeConfigState } => ({
  vscodeConfigState: { value: undefined },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown): unknown =>
        vscodeConfigState.value === undefined ? fallback : vscodeConfigState.value,
    }),
  },
}));

import { getAppFolderMappings, normalizeAppFolderMappings } from '../../src/core/appFolderMappingSettings';

describe('normalizeAppFolderMappings', () => {
  it('keeps valid entries', () => {
    expect(
      normalizeAppFolderMappings([
        { appName: 'sample-service-billing', folderName: 'billing-internal' },
        { appName: 'sample-service-core', folderName: 'core-svc' },
      ]),
    ).toEqual([
      { appName: 'sample-service-billing', folderName: 'billing-internal' },
      { appName: 'sample-service-core', folderName: 'core-svc' },
    ]);
  });

  it('returns an empty array for non-array input', () => {
    expect(normalizeAppFolderMappings(undefined)).toEqual([]);
    expect(normalizeAppFolderMappings(null)).toEqual([]);
    expect(normalizeAppFolderMappings('not-an-array')).toEqual([]);
    expect(normalizeAppFolderMappings({ appName: 'a', folderName: 'b' })).toEqual([]);
  });

  it('returns an empty array for an empty array', () => {
    expect(normalizeAppFolderMappings([])).toEqual([]);
  });

  it('drops entries missing appName or folderName', () => {
    expect(
      normalizeAppFolderMappings([
        { appName: 'sample-service-billing' },
        { folderName: 'billing-internal' },
        { appName: 'sample-service-core', folderName: 'core-svc' },
      ]),
    ).toEqual([{ appName: 'sample-service-core', folderName: 'core-svc' }]);
  });

  it('drops entries with non-string or empty/whitespace fields and trims values', () => {
    expect(
      normalizeAppFolderMappings([
        { appName: 42, folderName: 'core-svc' },
        { appName: 'sample', folderName: 99 },
        { appName: '   ', folderName: 'core-svc' },
        { appName: 'sample', folderName: '   ' },
        { appName: '  sample-service-core  ', folderName: '  core-svc  ' },
      ]),
    ).toEqual([{ appName: 'sample-service-core', folderName: 'core-svc' }]);
  });

  it('drops non-object array elements', () => {
    expect(
      normalizeAppFolderMappings([
        'string-entry',
        42,
        null,
        ['nested'],
        { appName: 'sample-service-core', folderName: 'core-svc' },
      ]),
    ).toEqual([{ appName: 'sample-service-core', folderName: 'core-svc' }]);
  });

  it('keeps the first entry on duplicate app names', () => {
    expect(
      normalizeAppFolderMappings([
        { appName: 'sample-service-billing', folderName: 'first-folder' },
        { appName: 'sample-service-billing', folderName: 'second-folder' },
      ]),
    ).toEqual([{ appName: 'sample-service-billing', folderName: 'first-folder' }]);
  });
});

describe('getAppFolderMappings', () => {
  beforeEach(() => {
    vscodeConfigState.value = undefined;
  });

  it('returns the normalized configured value', () => {
    vscodeConfigState.value = [
      { appName: 'sample-service-billing', folderName: 'billing-internal' },
      { appName: 'sample-service-billing', folderName: 'duplicate-ignored' },
      'invalid-entry',
    ];
    expect(getAppFolderMappings()).toEqual([
      { appName: 'sample-service-billing', folderName: 'billing-internal' },
    ]);
  });

  it('returns an empty array when the setting is unset', () => {
    expect(getAppFolderMappings()).toEqual([]);
  });
});
