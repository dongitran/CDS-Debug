import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SharedCfScope } from '../../src/types/index';

const vscodeMock = vi.hoisted(() => {
  const state: {
    currentScope: SharedCfScope | undefined;
    update: ReturnType<typeof vi.fn>;
  } = {
    currentScope: undefined,
    update: vi.fn((_key: string, value: SharedCfScope | undefined): Promise<void> => {
      state.currentScope = value;
      return Promise.resolve();
    }),
  };
  return state;
});

vi.mock('vscode', () => ({
  ConfigurationTarget: {
    Global: 'global',
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string): SharedCfScope | undefined => (
        section === 'sapCap' && key === 'currentScope'
          ? vscodeMock.currentScope
          : undefined
      ),
      update: vscodeMock.update,
    }),
  },
}));

import {
  buildCfApiEndpoint,
  readCurrentScope,
  regionCodeFromApiEndpoint,
  writeScopeIfChanged,
} from '../../src/storage/scopeSync';

describe('scopeSync', () => {
  beforeEach(() => {
    vscodeMock.currentScope = undefined;
    vscodeMock.update.mockClear();
  });

  it.each([
    ['https://api.cf.us10.hana.ondemand.com', 'us10'],
    ['https://api.cf.eu10.hana.ondemand.com', 'eu10'],
    ['https://api.cf.ap21.hana.ondemand.com', 'ap21'],
    ['https://api.cf.cn40.platform.sapcloud.cn', 'cn40'],
  ])('parses %s to %s', (apiEndpoint, expected) => {
    expect(regionCodeFromApiEndpoint(apiEndpoint)).toBe(expected);
  });

  it.each([
    'http://api.cf.us10.hana.ondemand.com',
    'https://api.cf.us10.example.com',
    'https://api.cf.hana.ondemand.com',
    'https://example.com/api.cf.us10.hana.ondemand.com',
  ])('returns undefined for invalid endpoint %s', (apiEndpoint) => {
    expect(regionCodeFromApiEndpoint(apiEndpoint)).toBeUndefined();
  });

  it.each([
    ['us10', 'https://api.cf.us10.hana.ondemand.com'],
    ['eu10', 'https://api.cf.eu10.hana.ondemand.com'],
    ['cn40', 'https://api.cf.cn40.platform.sapcloud.cn'],
  ])('builds %s API endpoint as %s', (regionCode, expected) => {
    expect(buildCfApiEndpoint(regionCode)).toBe(expected);
  });

  it('reads the current shared scope from sapCap.currentScope', () => {
    const scope: SharedCfScope = {
      regionCode: 'eu10',
      orgName: 'sample-org',
      spaceName: 'app',
    };
    vscodeMock.currentScope = scope;

    expect(readCurrentScope()).toEqual(scope);
  });

  it('does not update sapCap.currentScope when the scope is unchanged', async () => {
    const scope: SharedCfScope = {
      regionCode: 'eu10',
      orgName: 'sample-org',
      spaceName: 'app',
    };
    vscodeMock.currentScope = scope;

    await writeScopeIfChanged(scope);

    expect(vscodeMock.update).not.toHaveBeenCalled();
  });

  it('updates sapCap.currentScope globally when the scope changes', async () => {
    const nextScope: SharedCfScope = {
      regionCode: 'us10',
      orgName: 'sample-org',
      spaceName: 'dev',
    };
    vscodeMock.currentScope = {
      regionCode: 'eu10',
      orgName: 'sample-org',
      spaceName: 'app',
    };

    await writeScopeIfChanged(nextScope);

    expect(vscodeMock.update).toHaveBeenCalledWith('currentScope', nextScope, 'global');
    expect(vscodeMock.currentScope).toEqual(nextScope);
  });
});
