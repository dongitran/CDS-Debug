import type * as vscode from 'vscode';
import type { ExtensionConfig, OrgGroupMapping } from '../types/index';

const CONFIG_KEY = 'cds-debug.config';

let _context: vscode.ExtensionContext | undefined;
let _configCache: ExtensionConfig | undefined;

export function initConfigStore(context: vscode.ExtensionContext | undefined): void {
  _context = context;
  _configCache = context === undefined
    ? undefined
    : context.globalState.get<ExtensionConfig>(CONFIG_KEY);
}

function getContext(): vscode.ExtensionContext {
  if (_context === undefined) {
    throw new Error('ConfigStore not initialized. Call initConfigStore() first.');
  }
  return _context;
}

export function getConfig(): ExtensionConfig | undefined {
  getContext();
  return _configCache;
}

export async function saveConfig(config: ExtensionConfig): Promise<void> {
  const context = getContext();
  // Update the in-memory snapshot first so back-to-back webview messages
  // (save mapping -> load apps -> start debug) all observe the latest config.
  _configCache = config;
  try {
    await context.globalState.update(CONFIG_KEY, config);
  } catch (error: unknown) {
    _configCache = context.globalState.get<ExtensionConfig>(CONFIG_KEY);
    throw error;
  }
}

export async function clearConfig(): Promise<void> {
  const context = getContext();
  _configCache = undefined;
  try {
    await context.globalState.update(CONFIG_KEY, undefined);
  } catch (error: unknown) {
    _configCache = context.globalState.get<ExtensionConfig>(CONFIG_KEY);
    throw error;
  }
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
