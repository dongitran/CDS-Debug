import type * as vscode from 'vscode';
import type { ExtensionConfig, OrgGroupMapping } from '../types/index';

const CONFIG_KEY = 'cds-debug.config';

let _context: vscode.ExtensionContext | undefined;

export function initConfigStore(context: vscode.ExtensionContext): void {
  _context = context;
}

function getContext(): vscode.ExtensionContext {
  if (_context === undefined) {
    throw new Error('ConfigStore not initialized. Call initConfigStore() first.');
  }
  return _context;
}

export function getConfig(): ExtensionConfig | undefined {
  return getContext().globalState.get<ExtensionConfig>(CONFIG_KEY);
}

export async function saveConfig(config: ExtensionConfig): Promise<void> {
  await getContext().globalState.update(CONFIG_KEY, config);
}

export async function clearConfig(): Promise<void> {
  await getContext().globalState.update(CONFIG_KEY, undefined);
}

/**
 * Merges incoming org-folder mappings into an existing array, using `cfOrg` as the key.
 * Existing mappings for orgs NOT in `incoming` are preserved.
 * Existing mappings for orgs IN `incoming` are replaced with the incoming value.
 * Does not mutate either input array.
 */
export function upsertOrgMappings(
  existing: OrgGroupMapping[],
  incoming: OrgGroupMapping[],
): OrgGroupMapping[] {
  const orgMap = new Map(existing.map((m) => [m.cfOrg, m]));
  for (const mapping of incoming) {
    orgMap.set(mapping.cfOrg, mapping);
  }
  return Array.from(orgMap.values());
}
