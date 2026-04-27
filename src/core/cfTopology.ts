import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { cfStructurePath } from '@saptools/cf-sync';
import type { CfStructure, RegionNode, OrgNode } from '@saptools/cf-sync';
import type { CfTopology, CfTopologyOrg } from '../types/index';

const CF_STRUCTURE_PATH_ENV = 'CDS_DEBUG_CF_STRUCTURE_PATH';

function structurePath(): string {
  return process.env[CF_STRUCTURE_PATH_ENV] ?? cfStructurePath();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSpaceNode(value: unknown): boolean {
  return isRecord(value) && typeof value.name === 'string' && Array.isArray(value.apps);
}

function isOrgNode(value: unknown): value is OrgNode {
  return isRecord(value)
    && typeof value.name === 'string'
    && Array.isArray(value.spaces)
    && value.spaces.every(isSpaceNode);
}

function isRegionNode(value: unknown): value is RegionNode {
  return isRecord(value)
    && typeof value.key === 'string'
    && typeof value.label === 'string'
    && typeof value.apiEndpoint === 'string'
    && typeof value.accessible === 'boolean'
    && Array.isArray(value.orgs)
    && value.orgs.every(isOrgNode);
}

function parseStructure(value: unknown): CfStructure | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.syncedAt !== 'string' || !Array.isArray(value.regions)) return undefined;
  if (!value.regions.every(isRegionNode)) return undefined;
  return {
    syncedAt: value.syncedAt,
    regions: value.regions,
  };
}

function buildOrgEntries(structure: CfStructure): CfTopologyOrg[] {
  const entries: CfTopologyOrg[] = [];
  for (const region of structure.regions) {
    if (!region.accessible) continue;
    if (region.orgs.length === 0) continue;
    for (const org of region.orgs) {
      entries.push(buildOrgEntry(region, org));
    }
  }
  entries.sort((left, right) => {
    const orgCompare = left.orgName.localeCompare(right.orgName);
    if (orgCompare !== 0) return orgCompare;
    return left.regionKey.localeCompare(right.regionKey);
  });
  return entries;
}

function buildOrgEntry(region: RegionNode, org: OrgNode): CfTopologyOrg {
  const spaces = org.spaces.map((space) => space.name);
  return {
    regionKey: region.key,
    regionLabel: region.label,
    apiEndpoint: region.apiEndpoint,
    orgName: org.name,
    spaces,
  };
}

function readStructureSync(): CfStructure | undefined {
  try {
    const raw = fs.readFileSync(structurePath(), 'utf8');
    return parseStructure(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

async function readStructureStable(): Promise<CfStructure | undefined> {
  try {
    const raw = await fsPromises.readFile(structurePath(), 'utf8');
    return parseStructure(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function getTopologySnapshotSync(): CfTopology {
  const structure = readStructureSync();
  if (!structure) {
    return { ready: false, accounts: [] };
  }
  const accounts = buildOrgEntries(structure);
  return {
    ready: accounts.length > 0,
    accounts,
  };
}

export async function getTopologySnapshot(): Promise<CfTopology> {
  const structure = await readStructureStable();
  if (!structure) {
    return { ready: false, accounts: [] };
  }
  const accounts = buildOrgEntries(structure);
  return {
    ready: accounts.length > 0,
    accounts,
  };
}
