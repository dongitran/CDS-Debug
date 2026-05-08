import * as vscode from 'vscode';
import type { SharedCfScope } from '../types/index';

const SAP_CAP_CONFIG_SECTION = 'sapCap';
const CURRENT_SCOPE_KEY = 'currentScope';

export function regionCodeFromApiEndpoint(apiEndpoint: string): string | undefined {
  const match = /^https:\/\/api\.cf\.(.+?)\.(?:hana\.ondemand\.com|platform\.sapcloud\.cn)$/.exec(apiEndpoint);
  return match?.[1];
}

function isSharedCfScope(value: unknown): value is SharedCfScope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.regionCode === 'string'
    && typeof record.orgName === 'string'
    && typeof record.spaceName === 'string';
}

function scopesEqual(left: SharedCfScope | undefined, right: SharedCfScope): boolean {
  return left?.regionCode === right.regionCode
    && left.orgName === right.orgName
    && left.spaceName === right.spaceName;
}

export function readCurrentScope(): SharedCfScope | undefined {
  const value = vscode.workspace
    .getConfiguration(SAP_CAP_CONFIG_SECTION)
    .get<unknown>(CURRENT_SCOPE_KEY);
  return isSharedCfScope(value) ? value : undefined;
}

export async function writeScopeIfChanged(scope: SharedCfScope): Promise<void> {
  if (scopesEqual(readCurrentScope(), scope)) return;
  await vscode.workspace
    .getConfiguration(SAP_CAP_CONFIG_SECTION)
    .update(CURRENT_SCOPE_KEY, scope, vscode.ConfigurationTarget.Global);
}
