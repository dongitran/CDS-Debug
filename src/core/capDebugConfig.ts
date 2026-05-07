import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CapDebugConfig } from '../types/index';
import { isValidGitBranchName } from './gitOperations';
import { logWarn } from './logger';

const CAP_DEBUG_CONFIG_FILE = 'cap-debug-config.json';
const SHARED_CAP_DEBUG_CONFIG_KEY = 'sharedCapDebugConfig';

export function normalizeCapDebugConfig(value: unknown): CapDebugConfig | null {
  return normalizeCapDebugConfigFromSource(value, 'CAP debug config');
}

function normalizeCapDebugConfigFromSource(value: unknown, source: string): CapDebugConfig | null {
  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;
  if (hasUnsafeBranchValue(record, source)) return null;

  const normalized: CapDebugConfig = {};

  if (typeof record.remoteRoot === 'string') normalized.remoteRoot = record.remoteRoot;
  if (typeof record.branch === 'string') normalized.branch = record.branch;

  const orgBranchMap = normalizeOrgBranchMap(record.orgBranchMap);
  if (orgBranchMap !== undefined) normalized.orgBranchMap = orgBranchMap;

  return normalized;
}

function hasUnsafeBranchValue(record: Record<string, unknown>, source: string): boolean {
  if (typeof record.branch === 'string' && !isValidGitBranchName(record.branch)) {
    warnUnsafeBranch(source, 'branch');
    return true;
  }

  const orgBranchMap = record.orgBranchMap;
  if (typeof orgBranchMap !== 'object' || orgBranchMap === null) return false;

  for (const value of Object.values(orgBranchMap)) {
    if (typeof value === 'string' && !isValidGitBranchName(value)) {
      warnUnsafeBranch(source, 'orgBranchMap');
      return true;
    }
  }

  return false;
}

function warnUnsafeBranch(source: string, field: 'branch' | 'orgBranchMap'): void {
  const message = `Rejected unsafe git branch in ${source} (${field}). `
    + 'Use only letters, numbers, ".", "_", "-", and "/" in git branch values.';
  logWarn(`[Security] ${message}`);
  void vscode.window.showWarningMessage(`CDS Debug: ${message}`);
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
    return normalizeCapDebugConfigFromSource(JSON.parse(raw) as unknown, configPath);
  } catch {
    return null;
  }
}

export function getUserCapDebugConfig(): CapDebugConfig | null {
  const inspectResult = vscode.workspace
    .getConfiguration('cdsDebug')
    .inspect<unknown>(SHARED_CAP_DEBUG_CONFIG_KEY);

  const normalized = normalizeCapDebugConfigFromSource(
    inspectResult?.globalValue,
    `user setting cdsDebug.${SHARED_CAP_DEBUG_CONFIG_KEY}`,
  );
  return hasConfigValues(normalized) ? normalized : null;
}

export async function resolveSharedCapDebugConfig(workspacePath: string): Promise<CapDebugConfig | null> {
  const userConfig = getUserCapDebugConfig();
  if (userConfig !== null) return userConfig;

  const workspaceConfig = await readCapDebugConfig(join(workspacePath, '.vscode'));
  return hasConfigValues(workspaceConfig) ? workspaceConfig : null;
}
