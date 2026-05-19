import * as vscode from 'vscode';
import type { AppFolderMapping } from '../types/index';

const APP_FOLDER_MAPPINGS_KEY = 'appFolderMappings';

/**
 * Reads the `cdsDebug.appFolderMappings` setting. `scope: "application"` means only
 * User settings can set it, so `get` returns the user value or the `[]` default.
 */
export function getAppFolderMappings(): AppFolderMapping[] {
  const raw = vscode.workspace
    .getConfiguration('cdsDebug')
    .get<unknown>(APP_FOLDER_MAPPINGS_KEY, []);
  return normalizeAppFolderMappings(raw);
}

/**
 * Validates raw setting input into a clean mapping list: drops malformed entries,
 * trims values, and keeps the first entry on duplicate app names.
 */
export function normalizeAppFolderMappings(value: unknown): AppFolderMapping[] {
  if (!Array.isArray(value)) return [];
  const result: AppFolderMapping[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const mapping = normalizeEntry(entry);
    if (mapping === null || seen.has(mapping.appName)) continue;
    seen.add(mapping.appName);
    result.push(mapping);
  }
  return result;
}

function normalizeEntry(entry: unknown): AppFolderMapping | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const appName = typeof record.appName === 'string' ? record.appName.trim() : '';
  const folderName = typeof record.folderName === 'string' ? record.folderName.trim() : '';
  if (appName.length === 0 || folderName.length === 0) return null;
  return { appName, folderName };
}
