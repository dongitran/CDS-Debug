import type { OrgGroupMapping } from '../types/index';

export function selectPreferredOrgMapping(
  orgs: readonly string[],
  mappings: readonly OrgGroupMapping[],
): OrgGroupMapping | null {
  const compatibleOrgs = new Set(orgs);
  const preferred = mappings
    .filter((mapping) => compatibleOrgs.has(mapping.cfOrg))
    .sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0))[0];

  return preferred ?? null;
}

export function upsertWebviewOrgMapping(
  existing: readonly OrgGroupMapping[],
  incoming: OrgGroupMapping,
): OrgGroupMapping[] {
  const mappingKey = (mapping: OrgGroupMapping): string => JSON.stringify([
    mapping.cfOrg,
    mapping.cfSpace ?? 'app',
  ]);
  const mappingsByTarget = new Map(existing.map((mapping) => [mappingKey(mapping), mapping]));
  mappingsByTarget.set(mappingKey(incoming), incoming);
  return Array.from(mappingsByTarget.values());
}
