import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfStructurePathMock = vi.hoisted(() => vi.fn());

vi.mock('@saptools/cf-sync', () => ({
  cfStructurePath: cfStructurePathMock,
}));

import { getAppsFromTopologySync, getTopologySnapshot, getTopologySnapshotSync } from '../../src/core/cfTopology';
import type { CfStructure } from '@saptools/cf-sync';

let tempDir: string | undefined;
let structurePath: string;

const EU10_ENDPOINT = 'https://api.cf.eu10.hana.ondemand.com';
const US10_ENDPOINT = 'https://api.cf.us10.hana.ondemand.com';

function makeStructure(regions: CfStructure['regions']): CfStructure {
  return {
    syncedAt: '2026-04-27T00:00:00.000Z',
    regions,
  };
}

describe('cfTopology', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'cds-debug-cf-topology-'));
    structurePath = join(tempDir, 'cf-structure.json');
    cfStructurePathMock.mockReturnValue(structurePath);
  });

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('returns not-ready when no stable cf-sync structure exists', async () => {
    await expect(getTopologySnapshot()).resolves.toEqual({ ready: false, accounts: [] });
  });

  it('builds sorted org search accounts from the stable cf-sync structure', async () => {
    await writeFile(
      structurePath,
      JSON.stringify(makeStructure([
        {
          key: 'us10',
          label: 'US East (VA) - AWS (us10)',
          apiEndpoint: US10_ENDPOINT,
          accessible: true,
          orgs: [{ name: 'sample-org-z', spaces: [{ name: 'app', apps: [] }] }],
        },
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [{ name: 'demo-org-a', spaces: [{ name: 'app', apps: [] }, { name: 'dev', apps: [] }] }],
        },
        {
          key: 'ap11',
          label: 'Asia Pacific (Singapore) - AWS (ap11)',
          apiEndpoint: 'https://api.cf.ap11.hana.ondemand.com',
          accessible: false,
          orgs: [{ name: 'hidden-org', spaces: [{ name: 'app', apps: [] }] }],
        },
      ])),
      'utf8',
    );

    await expect(getTopologySnapshot()).resolves.toEqual({
      ready: true,
      accounts: [
        {
          regionKey: 'eu10',
          regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          orgName: 'demo-org-a',
          spaces: [
            { name: 'app', apps: [] },
            { name: 'dev', apps: [] },
          ],
        },
        {
          regionKey: 'us10',
          regionLabel: 'US East (VA) - AWS (us10)',
          apiEndpoint: US10_ENDPOINT,
          orgName: 'sample-org-z',
          spaces: [{ name: 'app', apps: [] }],
        },
      ],
    });
  });

  it('maps cf-sync apps into topology spaces using debuggable app states', async () => {
    await writeFile(
      structurePath,
      JSON.stringify(makeStructure([
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [{
            name: 'demo-org-a',
            spaces: [{
              name: 'app',
              apps: [
                {
                  name: 'sample-service-started',
                  requestedState: 'started',
                  runningInstances: 1,
                  totalInstances: 1,
                  routes: ['sample-service-started.cfapps.example.com'],
                },
                {
                  name: 'sample-service-empty',
                  requestedState: 'started',
                  runningInstances: 0,
                  totalInstances: 1,
                  routes: [],
                },
                {
                  name: 'sample-service-stopped',
                  requestedState: 'stopped',
                  runningInstances: 0,
                  totalInstances: 1,
                  routes: ['sample-service-stopped.cfapps.example.com'],
                },
              ],
            }],
          }],
        },
      ])),
      'utf8',
    );

    await expect(getTopologySnapshot()).resolves.toEqual({
      ready: true,
      accounts: [{
        regionKey: 'eu10',
        regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
        apiEndpoint: EU10_ENDPOINT,
        orgName: 'demo-org-a',
        spaces: [{
          name: 'app',
          apps: [
            {
              name: 'sample-service-started',
              state: 'started',
              urls: ['sample-service-started.cfapps.example.com'],
            },
            { name: 'sample-service-empty', state: 'empty', urls: [] },
            {
              name: 'sample-service-stopped',
              state: 'stopped',
              urls: ['sample-service-stopped.cfapps.example.com'],
            },
          ],
        }],
      }],
    });
  });

  it('preserves per-space sync errors instead of hiding the space', async () => {
    await writeFile(
      structurePath,
      JSON.stringify(makeStructure([
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [{
            name: 'demo-org-a',
            spaces: [{ name: 'app', apps: [], error: 'mock space sync failed' }],
          }],
        },
      ])),
      'utf8',
    );

    await expect(getTopologySnapshot()).resolves.toEqual({
      ready: true,
      accounts: [{
        regionKey: 'eu10',
        regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
        apiEndpoint: EU10_ENDPOINT,
        orgName: 'demo-org-a',
        spaces: [{ name: 'app', apps: [], error: 'mock space sync failed' }],
      }],
    });
  });

  it('finds apps synchronously for an endpoint org and space', async () => {
    await writeFile(
      structurePath,
      JSON.stringify(makeStructure([
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [{
            name: 'demo-org-a',
            spaces: [{
              name: 'app',
              apps: [{ name: 'sample-service-started', requestedState: 'started', runningInstances: 1 }],
            }],
          }],
        },
      ])),
      'utf8',
    );

    expect(getAppsFromTopologySync(EU10_ENDPOINT, 'demo-org-a', 'app')).toEqual([
      { name: 'sample-service-started', state: 'started', urls: [] },
    ]);
    expect(getAppsFromTopologySync(EU10_ENDPOINT, 'demo-org-a', 'missing')).toBeUndefined();
  });

  it('does not mark malformed stable structure data as ready', async () => {
    await writeFile(
      structurePath,
      JSON.stringify({ syncedAt: '2026-04-27T00:00:00.000Z', regions: [{ name: 'bad' }] }),
      'utf8',
    );

    await expect(getTopologySnapshot()).resolves.toEqual({ ready: false, accounts: [] });
  });

  it('reads the synchronous first-paint snapshot from cf-sync stable storage', async () => {
    await writeFile(
      structurePath,
      JSON.stringify(makeStructure([
        {
          key: 'eu10',
          label: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          accessible: true,
          orgs: [{ name: 'demo-org-a', spaces: [{ name: 'app', apps: [] }] }],
        },
      ])),
      'utf8',
    );

    expect(getTopologySnapshotSync()).toEqual({
      ready: true,
      accounts: [
        {
          regionKey: 'eu10',
          regionLabel: 'Europe (Frankfurt) - AWS (eu10)',
          apiEndpoint: EU10_ENDPOINT,
          orgName: 'demo-org-a',
          spaces: [{ name: 'app', apps: [] }],
        },
      ],
    });
  });

  it('treats unreadable synchronous snapshot data as not ready', async () => {
    await writeFile(structurePath, '{not-json', 'utf8');

    expect(getTopologySnapshotSync()).toEqual({ ready: false, accounts: [] });
  });
});
