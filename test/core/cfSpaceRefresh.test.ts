import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAllRegionsMock = vi.hoisted(() => vi.fn());
const syncSpaceMock = vi.hoisted(() => vi.fn());

vi.mock('@saptools/cf-sync', () => ({
  getAllRegions: getAllRegionsMock,
  syncSpace: syncSpaceMock,
}));

import { refreshCfSyncSpace, resolveRegionKeyForEndpoint } from '../../src/core/cfSpaceRefresh';

const EU10_ENDPOINT = 'https://api.cf.eu10.hana.ondemand.com';

describe('cfSpaceRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllRegionsMock.mockReturnValue([
      { key: 'eu10', label: 'Europe (Frankfurt)', apiEndpoint: EU10_ENDPOINT },
      { key: 'ap11', label: 'Singapore', apiEndpoint: 'https://api.cf.ap11.hana.ondemand.com' },
    ]);
  });

  it('resolves a built-in region from its API endpoint', () => {
    expect(resolveRegionKeyForEndpoint(EU10_ENDPOINT)).toBe('eu10');
    expect(resolveRegionKeyForEndpoint(`${EU10_ENDPOINT}/`)).toBe('eu10');
  });

  it('refreshes the default app space and returns the app count', async () => {
    syncSpaceMock.mockResolvedValue({
      space: {
        name: 'app',
        apps: [{ name: 'sample-service-a' }, { name: 'sample-service-b' }],
      },
    });

    const result = await refreshCfSyncSpace({
      apiEndpoint: EU10_ENDPOINT,
      orgName: 'demo-org',
      email: 'demo@example.com',
      password: 'secret',
    });

    expect(syncSpaceMock).toHaveBeenCalledWith({
      regionKey: 'eu10',
      orgName: 'demo-org',
      spaceName: 'app',
      email: 'demo@example.com',
      password: 'secret',
    });
    expect(result).toEqual({ status: 'refreshed', regionKey: 'eu10', appCount: 2 });
  });

  it('refreshes the requested space when one is provided', async () => {
    syncSpaceMock.mockResolvedValue({
      space: {
        name: 'dev',
        apps: [{ name: 'sample-service-a' }],
      },
    });

    const result = await refreshCfSyncSpace({
      apiEndpoint: EU10_ENDPOINT,
      orgName: 'demo-org',
      spaceName: 'dev',
      email: 'demo@example.com',
      password: 'secret',
    });

    expect(syncSpaceMock).toHaveBeenCalledWith({
      regionKey: 'eu10',
      orgName: 'demo-org',
      spaceName: 'dev',
      email: 'demo@example.com',
      password: 'secret',
    });
    expect(result).toEqual({ status: 'refreshed', regionKey: 'eu10', appCount: 1 });
  });

  it('skips when credentials are missing', async () => {
    await expect(refreshCfSyncSpace({ apiEndpoint: EU10_ENDPOINT, orgName: 'demo-org' })).resolves.toEqual({
      status: 'skipped',
      reason: 'missing-credentials',
    });
    expect(syncSpaceMock).not.toHaveBeenCalled();
  });

  it('skips custom endpoints that are not in the built-in region catalog', async () => {
    await expect(
      refreshCfSyncSpace({
        apiEndpoint: 'https://api.cf.custom.example.com',
        orgName: 'demo-org',
        email: 'demo@example.com',
        password: 'secret',
      }),
    ).resolves.toEqual({ status: 'skipped', reason: 'unknown-region' });
    expect(syncSpaceMock).not.toHaveBeenCalled();
  });

  it('returns sync failures so the caller can decide how to surface them', async () => {
    const error = new Error('auth failed');
    syncSpaceMock.mockRejectedValue(error);

    await expect(
      refreshCfSyncSpace({
        apiEndpoint: EU10_ENDPOINT,
        orgName: 'demo-org',
        email: 'demo@example.com',
        password: 'secret',
      }),
    ).resolves.toEqual({ status: 'failed', regionKey: 'eu10', error });
  });
});
