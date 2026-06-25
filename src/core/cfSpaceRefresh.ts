import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cfApi,
  cfAppDetails,
  cfAuth,
  cfOrgs,
  cfTargetSpace,
  getAllRegions,
  getRegion,
  persistRegion,
  readStructure,
} from '@saptools/cf-sync';
import type {
  CfExecContext,
  OrgNode,
  RegionKey,
  RegionNode,
  SpaceNode,
} from '@saptools/cf-sync';
import { CF_DEFAULT_SPACE } from '../types/index';
import { createCfProcessEnv } from './cfEnvironment';

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

async function withCfSession<T>(work: (context: CfExecContext) => Promise<T>): Promise<T> {
  const cfHome = await fs.mkdtemp(path.join(os.tmpdir(), 'saptools-cf-session-'));
  const context: CfExecContext = { env: await createCfProcessEnv({ CF_HOME: cfHome }) };
  try {
    return await work(context);
  } finally {
    await fs.rm(cfHome, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function authenticate(
  regionKey: RegionKey,
  email: string,
  password: string,
  context: CfExecContext,
): Promise<void> {
  await cfApi(getRegion(regionKey).apiEndpoint, context);
  await cfAuth(email, password, context);
}

async function existingRegion(regionKey: RegionKey): Promise<RegionNode | undefined> {
  return (await readStructure())?.regions.find((region) => region.key === regionKey);
}

function createRegionNode(regionKey: RegionKey, orgs: readonly OrgNode[]): RegionNode {
  const region = getRegion(regionKey);
  return {
    key: region.key,
    label: region.label,
    apiEndpoint: region.apiEndpoint,
    accessible: true,
    orgs,
  };
}

async function refreshRegionOrgs(
  regionKey: RegionKey,
  email: string,
  password: string,
): Promise<string[]> {
  return withCfSession(async (context) => {
    await authenticate(regionKey, email, password, context);
    const orgNames = [...await cfOrgs(context)];
    const previous = await existingRegion(regionKey);
    const orgs = orgNames.map((name): OrgNode => (
      previous?.orgs.find((org) => org.name === name) ?? { name, spaces: [] }
    ));
    await persistRegion(createRegionNode(regionKey, orgs));
    return orgNames;
  });
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
    const orgNames = await refreshRegionOrgs(regionKey, input.email, input.password);
    return { status: 'refreshed', regionKey, orgNames };
  } catch (error: unknown) {
    return { status: 'failed', regionKey, error };
  }
}

function replaceSpace(org: OrgNode | undefined, space: SpaceNode): OrgNode {
  const otherSpaces = org?.spaces.filter((candidate) => candidate.name !== space.name) ?? [];
  return { name: org?.name ?? '', spaces: [...otherSpaces, space] };
}

async function refreshSpace(
  regionKey: RegionKey,
  orgName: string,
  spaceName: string,
  email: string,
  password: string,
): Promise<number> {
  return withCfSession(async (context) => {
    await authenticate(regionKey, email, password, context);
    await cfTargetSpace(orgName, spaceName, context);
    const apps = await cfAppDetails(context);
    const previous = await existingRegion(regionKey);
    const oldOrg = previous?.orgs.find((org) => org.name === orgName);
    const refreshedOrg = { ...replaceSpace(oldOrg, { name: spaceName, apps }), name: orgName };
    const otherOrgs = previous?.orgs.filter((org) => org.name !== orgName) ?? [];
    await persistRegion(createRegionNode(regionKey, [...otherOrgs, refreshedOrg]));
    return apps.length;
  });
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
    const appCount = await refreshSpace(
      regionKey,
      input.orgName,
      input.spaceName ?? CF_DEFAULT_SPACE,
      input.email,
      input.password,
    );
    return { status: 'refreshed', regionKey, appCount };
  } catch (error: unknown) {
    return { status: 'failed', regionKey, error };
  }
}
