import { describe, expect, it } from 'vitest';

import {
  selectPreferredOrgMapping,
  upsertWebviewOrgMapping,
} from '../../src/webview/mappingState';
import type { OrgGroupMapping } from '../../src/types/index';

describe('webview mapping state', () => {
  it('returns null when saved mappings are outside the current region org list', () => {
    const mappings: OrgGroupMapping[] = [
      { cfOrg: 'sample-org-eu', cfSpace: 'app', groupFolderPath: '/sample/eu', lastUsedAt: 300 },
      { cfOrg: 'sample-org-ap', cfSpace: 'app', groupFolderPath: '/sample/ap', lastUsedAt: 200 },
    ];

    expect(selectPreferredOrgMapping(['sample-org-us'], mappings)).toBeNull();
  });

  it('chooses the most recently used mapping among compatible orgs', () => {
    const older: OrgGroupMapping = {
      cfOrg: 'sample-org-a',
      cfSpace: 'app',
      groupFolderPath: '/sample/a',
      lastUsedAt: 100,
    };
    const newer: OrgGroupMapping = {
      cfOrg: 'sample-org-b',
      cfSpace: 'app',
      groupFolderPath: '/sample/b',
      lastUsedAt: 500,
    };
    const incompatible: OrgGroupMapping = {
      cfOrg: 'sample-org-c',
      cfSpace: 'app',
      groupFolderPath: '/sample/c',
      lastUsedAt: 1_000,
    };

    expect(selectPreferredOrgMapping(['sample-org-a', 'sample-org-b'], [older, incompatible, newer]))
      .toEqual(newer);
  });

  it('keeps legacy mappings without lastUsedAt compatible but lower priority', () => {
    const legacy: OrgGroupMapping = {
      cfOrg: 'sample-org-a',
      cfSpace: 'app',
      groupFolderPath: '/sample/a',
    };
    const recent: OrgGroupMapping = {
      cfOrg: 'sample-org-b',
      cfSpace: 'app',
      groupFolderPath: '/sample/b',
      lastUsedAt: 1,
    };

    expect(selectPreferredOrgMapping(['sample-org-a', 'sample-org-b'], [legacy, recent]))
      .toEqual(recent);
  });

  it('merges a new mapping without truncating existing mappings', () => {
    const existing: OrgGroupMapping[] = [
      { cfOrg: 'sample-org-a', cfSpace: 'app', groupFolderPath: '/sample/a', lastUsedAt: 100 },
    ];
    const incoming: OrgGroupMapping = {
      cfOrg: 'sample-org-b',
      cfSpace: 'app',
      groupFolderPath: '/sample/b',
      lastUsedAt: 200,
    };

    expect(upsertWebviewOrgMapping(existing, incoming)).toEqual([
      { cfOrg: 'sample-org-a', cfSpace: 'app', groupFolderPath: '/sample/a', lastUsedAt: 100 },
      incoming,
    ]);
  });

  it('replaces the same org and space while preserving other mappings', () => {
    const existing: OrgGroupMapping[] = [
      { cfOrg: 'sample-org-a', cfSpace: 'app', groupFolderPath: '/sample/a-old', lastUsedAt: 100 },
      { cfOrg: 'sample-org-b', cfSpace: 'dev', groupFolderPath: '/sample/b', lastUsedAt: 200 },
    ];
    const incoming: OrgGroupMapping = {
      cfOrg: 'sample-org-a',
      cfSpace: 'app',
      groupFolderPath: '/sample/a-new',
      lastUsedAt: 300,
    };

    expect(upsertWebviewOrgMapping(existing, incoming)).toEqual([
      incoming,
      { cfOrg: 'sample-org-b', cfSpace: 'dev', groupFolderPath: '/sample/b', lastUsedAt: 200 },
    ]);
  });

  it('treats missing cfSpace as the default app space during upsert', () => {
    const existing: OrgGroupMapping[] = [
      { cfOrg: 'sample-org-a', groupFolderPath: '/sample/a-legacy', lastUsedAt: 100 },
    ];
    const incoming: OrgGroupMapping = {
      cfOrg: 'sample-org-a',
      cfSpace: 'app',
      groupFolderPath: '/sample/a-app',
      lastUsedAt: 200,
    };

    expect(upsertWebviewOrgMapping(existing, incoming)).toEqual([incoming]);
  });
});
