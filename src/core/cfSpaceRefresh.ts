import { getAllRegions, syncRegionOrgs, syncSpace } from '@saptools/cf-sync';
import type { RegionKey } from '@saptools/cf-sync';
import { CF_DEFAULT_SPACE } from '../types/index';

export type CfSyncRegionOrgRefreshResult =
  | { status: 'refreshed'; regionKey: RegionKey; orgNames: string[] }
  | { status: 'skipped'; reason: 'missing-credentials' | 'unknown-region' }
  | { status: 'failed'; regionKey: RegionKey; error: unknown };

export type CfSyncSpaceRefreshResult =
  | { status: 'refreshed'; regionKey: RegionKey; appCount: number }
  | { status: 'skipped'; reason: 'missing-credentials' | 'unknown-region' }
  | { status: 'failed'; regionKey: RegionKey; error: unknown };

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

export function resolveRegionKeyForEndpoint(apiEndpoint: string): RegionKey | undefined {
  const normalized = normalizeEndpoint(apiEndpoint);
  return getAllRegions().find((region) => normalizeEndpoint(region.apiEndpoint) === normalized)?.key;
}

export async function refreshCfSyncRegionOrgs(input: {
  apiEndpoint: string;
  email?: string;
  password?: string;
}): Promise<CfSyncRegionOrgRefreshResult> {
  const regionKey = resolveRegionKeyForEndpoint(input.apiEndpoint);
  if (!regionKey) return { status: 'skipped', reason: 'unknown-region' };
  if (!input.email || !input.password) return { status: 'skipped', reason: 'missing-credentials' };

  try {
    const result = await syncRegionOrgs({
      regionKey,
      email: input.email,
      password: input.password,
    });
    return {
      status: 'refreshed',
      regionKey,
      orgNames: [...result.orgNames],
    };
  } catch (error: unknown) {
    return { status: 'failed', regionKey, error };
  }
}

export async function refreshCfSyncSpace(input: {
  apiEndpoint: string;
  orgName: string;
  spaceName?: string;
  email?: string;
  password?: string;
}): Promise<CfSyncSpaceRefreshResult> {
  const regionKey = resolveRegionKeyForEndpoint(input.apiEndpoint);
  if (!regionKey) return { status: 'skipped', reason: 'unknown-region' };
  if (!input.email || !input.password) return { status: 'skipped', reason: 'missing-credentials' };

  try {
    const result = await syncSpace({
      regionKey,
      orgName: input.orgName,
      spaceName: input.spaceName ?? CF_DEFAULT_SPACE,
      email: input.email,
      password: input.password,
    });
    return {
      status: 'refreshed',
      regionKey,
      appCount: result.space.apps.length,
    };
  } catch (error: unknown) {
    return { status: 'failed', regionKey, error };
  }
}
