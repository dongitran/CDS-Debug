import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllRegions: vi.fn(),
  getRegion: vi.fn(),
  cfApi: vi.fn(),
  cfAuth: vi.fn(),
  cfOrgs: vi.fn(),
  cfTargetSpace: vi.fn(),
  cfAppDetails: vi.fn(),
  readStructure: vi.fn(),
  persistRegion: vi.fn(),
  createCfProcessEnv: vi.fn(),
}));

vi.mock('@saptools/cf-sync', () => ({
  getAllRegions: mocks.getAllRegions,
  getRegion: mocks.getRegion,
  cfApi: mocks.cfApi,
  cfAuth: mocks.cfAuth,
  cfOrgs: mocks.cfOrgs,
  cfTargetSpace: mocks.cfTargetSpace,
  cfAppDetails: mocks.cfAppDetails,
  readStructure: mocks.readStructure,
  persistRegion: mocks.persistRegion,
}));

vi.mock('../../src/core/cfEnvironment', () => ({
  createCfProcessEnv: mocks.createCfProcessEnv,
}));

import {
  refreshCfSyncRegionOrgs,
  refreshCfSyncSpace,
  resolveRegionKeyForEndpoint,
} from '../../src/core/cfSpaceRefresh';

const EU10 = {
  key: 'eu10',
  label: 'Europe (Frankfurt)',
  apiEndpoint: 'https://api.cf.eu10.hana.ondemand.com',
} as const;
const EU10_002 = {
  key: 'eu10-002',
  label: 'Europe (Frankfurt) - AWS (eu10-002)',
  apiEndpoint: 'https://api.cf.eu10-002.hana.ondemand.com',
} as const;
const US10_004_ENDPOINT = 'https://api.cf.us10-004.hana.ondemand.com';

describe('cfSpaceRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAllRegions.mockReturnValue([EU10, EU10_002]);
    mocks.getRegion.mockImplementation((key: string) => key === EU10.key ? EU10 : EU10_002);
    mocks.createCfProcessEnv.mockImplementation((overrides: NodeJS.ProcessEnv) => Promise.resolve({
      ...overrides,
      HTTPS_PROXY: 'socks5://127.0.0.1:49152',
    }));
    mocks.cfApi.mockResolvedValue(undefined);
    mocks.cfAuth.mockResolvedValue(undefined);
    mocks.cfOrgs.mockResolvedValue([]);
    mocks.cfTargetSpace.mockResolvedValue(undefined);
    mocks.cfAppDetails.mockResolvedValue([]);
    mocks.readStructure.mockResolvedValue(undefined);
    mocks.persistRegion.mockResolvedValue(undefined);
  });

  it('refreshes orgs with a proxy-aware isolated CF session and preserves known spaces', async () => {
    mocks.cfOrgs.mockResolvedValue(['sample-org-alpha', 'sample-org-beta']);
    mocks.readStructure.mockResolvedValue({
      syncedAt: '2026-06-25T00:00:00.000Z',
      regions: [{
        ...EU10,
        accessible: true,
        orgs: [{ name: 'sample-org-alpha', spaces: [{ name: 'app', apps: [{ name: 'existing-app' }] }] }],
      }],
    });

    const result = await refreshCfSyncRegionOrgs({
      apiEndpoint: EU10.apiEndpoint,
      email: 'demo@example.com',
      password: 'secret',
    });

    expect(result).toEqual({
      status: 'refreshed',
      regionKey: 'eu10',
      orgNames: ['sample-org-alpha', 'sample-org-beta'],
    });
    expect(mocks.createCfProcessEnv).toHaveBeenCalledWith({
      CF_HOME: expect.stringContaining('saptools-cf-session-'),
    });
    const context = expect.objectContaining({
      env: expect.objectContaining({ HTTPS_PROXY: 'socks5://127.0.0.1:49152' }),
    });
    expect(mocks.cfApi).toHaveBeenCalledWith(EU10.apiEndpoint, context);
    expect(mocks.cfAuth).toHaveBeenCalledWith('demo@example.com', 'secret', context);
    expect(mocks.cfOrgs).toHaveBeenCalledWith(context);
    expect(mocks.persistRegion).toHaveBeenCalledWith(expect.objectContaining({
      key: 'eu10',
      orgs: [
        { name: 'sample-org-alpha', spaces: [{ name: 'app', apps: [{ name: 'existing-app' }] }] },
        { name: 'sample-org-beta', spaces: [] },
      ],
    }));
  });

  it('refreshes one space while preserving other orgs and spaces', async () => {
    mocks.cfAppDetails.mockResolvedValue([{ name: 'new-app' }, { name: 'new-worker' }]);
    mocks.readStructure.mockResolvedValue({
      syncedAt: '2026-06-25T00:00:00.000Z',
      regions: [{
        ...EU10,
        accessible: true,
        orgs: [
          { name: 'demo-org', spaces: [{ name: 'dev', apps: [{ name: 'keep-me' }] }] },
          { name: 'other-org', spaces: [{ name: 'app', apps: [{ name: 'other-app' }] }] },
        ],
      }],
    });

    const result = await refreshCfSyncSpace({
      apiEndpoint: EU10.apiEndpoint,
      orgName: 'demo-org',
      email: 'demo@example.com',
      password: 'secret',
    });

    expect(result).toEqual({ status: 'refreshed', regionKey: 'eu10', appCount: 2 });
    expect(mocks.cfTargetSpace).toHaveBeenCalledWith('demo-org', 'app', expect.any(Object));
    expect(mocks.persistRegion).toHaveBeenCalledWith(expect.objectContaining({
      orgs: [
        { name: 'other-org', spaces: [{ name: 'app', apps: [{ name: 'other-app' }] }] },
        {
          name: 'demo-org',
          spaces: [
            { name: 'dev', apps: [{ name: 'keep-me' }] },
            { name: 'app', apps: [{ name: 'new-app' }, { name: 'new-worker' }] },
          ],
        },
      ],
    }));
  });

  it('refreshes a requested space and supplemental region', async () => {
    mocks.cfAppDetails.mockResolvedValue([{ name: 'sample-service' }]);

    const result = await refreshCfSyncSpace({
      apiEndpoint: EU10_002.apiEndpoint,
      orgName: 'demo-org',
      spaceName: 'dev',
      email: 'demo@example.com',
      password: 'secret',
    });

    expect(result).toEqual({ status: 'refreshed', regionKey: 'eu10-002', appCount: 1 });
    expect(mocks.cfTargetSpace).toHaveBeenCalledWith('demo-org', 'dev', expect.any(Object));
  });

  it('skips refreshes when credentials are missing', async () => {
    await expect(refreshCfSyncRegionOrgs({ apiEndpoint: EU10.apiEndpoint })).resolves.toEqual({
      status: 'skipped',
      reason: 'missing-credentials',
    });
    await expect(refreshCfSyncSpace({ apiEndpoint: EU10.apiEndpoint, orgName: 'demo-org' })).resolves.toEqual({
      status: 'skipped',
      reason: 'missing-credentials',
    });
    expect(mocks.cfApi).not.toHaveBeenCalled();
  });

  it('skips endpoints outside the cf-sync catalog', async () => {
    await expect(refreshCfSyncRegionOrgs({
      apiEndpoint: US10_004_ENDPOINT,
      email: 'demo@example.com',
      password: 'secret',
    })).resolves.toEqual({ status: 'skipped', reason: 'unknown-region' });
    await expect(refreshCfSyncSpace({
      apiEndpoint: 'https://api.cf.custom.example.com',
      orgName: 'demo-org',
      email: 'demo@example.com',
      password: 'secret',
    })).resolves.toEqual({ status: 'skipped', reason: 'unknown-region' });
  });

  it('returns failures so callers can fall back without corrupting topology', async () => {
    const error = new Error('auth failed');
    mocks.cfAuth.mockRejectedValue(error);

    await expect(refreshCfSyncRegionOrgs({
      apiEndpoint: EU10.apiEndpoint,
      email: 'demo@example.com',
      password: 'secret',
    })).resolves.toEqual({ status: 'failed', regionKey: 'eu10', error });
    expect(mocks.persistRegion).not.toHaveBeenCalled();
  });

  it('resolves built-in endpoints with normalization', () => {
    expect(resolveRegionKeyForEndpoint(EU10.apiEndpoint)).toBe('eu10');
    expect(resolveRegionKeyForEndpoint(`${EU10.apiEndpoint}/`)).toBe('eu10');
    expect(resolveRegionKeyForEndpoint(EU10_002.apiEndpoint)).toBe('eu10-002');
  });
});
