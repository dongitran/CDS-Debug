import type { RemoteRootResolution } from '../core/remoteRootResolver';
import * as vscode from 'vscode';
import { z } from 'zod';
import type { CfApp, ExtensionConfig, WebviewMessage, BreakpointContextSnapshot } from '../types/index';

export interface ServiceBranchInfo {
  appName: string;
  folderPath: string;
  repoRoot: string | null;
  targetBranch: string | null;
  currentBranch: string | null;
}

export const MIN_BADGE_SCALE_INSTANCES = 1;

export const SSH_PROXY_PAYLOAD_SCHEMA = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(253)
    .refine((value) => !value.includes('://') && !hasControlCharacters(value) && !/\s/.test(value), 'Enter a host name or IP address without a URL scheme.'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(128)
    .refine((value) => !hasControlCharacters(value), 'Enter a valid SSH username.'),
  password: z.string().max(4096).optional(),
}).strict();

export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function buildLoginConfig(
  apiEndpoint: string,
  orgs: string[],
  existing: ExtensionConfig | undefined,
): ExtensionConfig {
  return {
    apiEndpoint,
    orgs,
    orgGroupMappings: existing?.orgGroupMappings ?? [],
  };
}

export function isWebviewMessage(value: unknown): value is WebviewMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as Record<string, unknown>).type === 'string'
  );
}

export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function validateBadgeScaleRequest(app: CfApp | undefined, targetInstances: number): string | null {
  if (!app) return 'App is no longer available in this space.';
  if (app.state !== 'started') return 'Only started apps can be scaled from this badge.';
  if (typeof app.runningInstances !== 'number' || typeof app.totalInstances !== 'number') {
    return 'Current instance counts are unavailable. Refresh apps and try again.';
  }
  if (app.instanceProcessCount !== undefined && app.instanceProcessCount > 1) {
    return 'Scaling multiple CF processes is not supported from this badge yet.';
  }
  if (app.runningInstances !== app.totalInstances) {
    return 'Wait until current instances are running before scaling.';
  }

  const delta = targetInstances - app.totalInstances;
  if (delta !== 1 && delta !== -1) return 'Scale one instance at a time from this badge.';
  return null;
}

export function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

export interface CfTargetScope {
  apiEndpoint: string;
  org: string;
  space: string;
}

export function firstMappedRoute(apps: CfApp[] | undefined, appName: string): string | undefined {
  const urls = apps?.find((app) => app.name === appName)?.urls;
  return urls?.find((url) => url.trim().length > 0);
}

export function apiEndpointHost(apiEndpoint: string): string {
  try {
    return new URL(apiEndpoint).host;
  } catch {
    return apiEndpoint;
  }
}

export function toSafeHttpUri(rawUrl: string): vscode.Uri | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return vscode.Uri.parse(parsed.toString());
  } catch {
    return null;
  }
}

export function describeRemoteRootResolution(result: RemoteRootResolution): string {
  switch (result.status) {
    case 'invalid-regex':
      return `invalid regex (${result.error})`;
    case 'unmatched':
      return `no remote folder matched ${result.pattern}`;
    case 'none':
      return 'remoteRoot is not configured';
    case 'literal':
      return `literal remoteRoot ${result.remoteRoot}`;
    case 'resolved':
      return `resolved remoteRoot ${result.remoteRoot}`;
  }
}

export function isBreakpointSnapshot(value: unknown): value is BreakpointContextSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string'
    && typeof rec.appName === 'string'
    && typeof rec.sessionName === 'string'
    && Array.isArray(rec.scopes)
  );
}

