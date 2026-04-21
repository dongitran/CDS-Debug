import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CapDebugConfig } from '../types/index';

const CAP_DEBUG_CONFIG_FILE = 'cap-debug-config.json';
const SHARED_CAP_DEBUG_CONFIG_KEY = 'sharedCapDebugConfig';

export function normalizeCapDebugConfig(value: unknown): CapDebugConfig | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  const normalized: CapDebugConfig = {};

  if (typeof record.remoteRoot === 'string') normalized.remoteRoot = record.remoteRoot;
  if (typeof record.branch === 'string') normalized.branch = record.branch;

  const orgBranchMap = normalizeOrgBranchMap(record.orgBranchMap);
  if (orgBranchMap !== undefined) normalized.orgBranchMap = orgBranchMap;

  return normalized;
}

function normalizeOrgBranchMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function hasConfigValues(config: CapDebugConfig | null): config is CapDebugConfig {
  return config !== null
    && (
      config.remoteRoot !== undefined
      || config.branch !== undefined
      || config.orgBranchMap !== undefined
    );
}

export async function readCapDebugConfig(folderPath: string): Promise<CapDebugConfig | null> {
  const configPath = join(folderPath, CAP_DEBUG_CONFIG_FILE);

  try {
    const raw = await readFile(configPath, 'utf8');
    return normalizeCapDebugConfig(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function getUserCapDebugConfig(): CapDebugConfig | null {
  const inspectResult = vscode.workspace
    .getConfiguration('cdsDebug')
    .inspect<unknown>(SHARED_CAP_DEBUG_CONFIG_KEY);

  const normalized = normalizeCapDebugConfig(inspectResult?.globalValue);
  return hasConfigValues(normalized) ? normalized : null;
}

export async function resolveSharedCapDebugConfig(workspacePath: string): Promise<CapDebugConfig | null> {
  const userConfig = getUserCapDebugConfig();
  if (userConfig !== null) return userConfig;

  const workspaceConfig = await readCapDebugConfig(join(workspacePath, '.vscode'));
  return hasConfigValues(workspaceConfig) ? workspaceConfig : null;
}
