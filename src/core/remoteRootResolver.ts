import { dirname } from 'node:path';
import { cfFindRemotePackageJsonPaths } from './cfClient';

const REGEX_PREFIX = 'regex:';
const PACKAGE_JSON_SUFFIX = '/package.json';
const REGEX_FLAGS_PATTERN = /^[dgimsuvy]*$/;

export type RemoteRootSetting =
  | { kind: 'none' }
  | { kind: 'literal'; value: string }
  | { kind: 'regex'; pattern: string; flags: string; regex: RegExp }
  | { kind: 'invalid-regex'; value: string; error: string };

export type RemoteRootResolution =
  | { status: 'none' }
  | { status: 'literal'; remoteRoot: string }
  | { status: 'resolved'; remoteRoot: string; pattern: string }
  | { status: 'unmatched'; pattern: string }
  | { status: 'invalid-regex'; error: string };

export interface ResolveRemoteRootOptions {
  findPackageJsonPaths?: (appName: string) => Promise<string[]>;
}

export class RemoteRootLookupCoordinator {
  private readonly inFlight = new Map<string, Promise<RemoteRootResolution>>();

  public resolve(
    cacheKey: string,
    appName: string,
    configuredRemoteRoot: string,
    options: ResolveRemoteRootOptions = {},
  ): Promise<RemoteRootResolution> {
    const existing = this.inFlight.get(cacheKey);
    if (existing !== undefined) return existing;

    const lookup = resolveRemoteRootForApp(appName, configuredRemoteRoot, options)
      .finally(() => {
        if (this.inFlight.get(cacheKey) === lookup) {
          this.inFlight.delete(cacheKey);
        }
      });
    this.inFlight.set(cacheKey, lookup);
    return lookup;
  }
}

export function parseRemoteRootSetting(value: string | undefined): RemoteRootSetting {
  const trimmed = value?.trim();
  if (!trimmed) return { kind: 'none' };

  if (trimmed.startsWith(REGEX_PREFIX)) {
    return toRegexSetting(trimmed.slice(REGEX_PREFIX.length), '', trimmed);
  }

  const slashRegex = parseSlashDelimitedRegex(trimmed);
  if (slashRegex !== null) {
    return toRegexSetting(slashRegex.pattern, slashRegex.flags, trimmed);
  }

  return { kind: 'literal', value: trimmed };
}

export function normalizeRemotePackageJsonPath(filePath: string): string | null {
  const trimmed = filePath.trim();
  if (!trimmed.startsWith('/') || !trimmed.endsWith(PACKAGE_JSON_SUFFIX)) {
    return null;
  }

  const folder = trimTrailingSlash(dirname(trimmed));
  return folder.length > 0 ? folder : '/';
}

export async function resolveRemoteRootForApp(
  appName: string,
  configuredRemoteRoot: string | undefined,
  options: ResolveRemoteRootOptions = {},
): Promise<RemoteRootResolution> {
  const setting = parseRemoteRootSetting(configuredRemoteRoot);
  if (setting.kind === 'none') return { status: 'none' };
  if (setting.kind === 'literal') return { status: 'literal', remoteRoot: setting.value };
  if (setting.kind === 'invalid-regex') return { status: 'invalid-regex', error: setting.error };

  const findPackageJsonPaths = options.findPackageJsonPaths ?? cfFindRemotePackageJsonPaths;
  const packageJsonPaths = await findPackageJsonPaths(appName);
  const candidates = toSortedRemoteRootCandidates(packageJsonPaths);
  const matched = candidates.find((candidate) => regexTest(setting.regex, candidate));
  return matched
    ? { status: 'resolved', remoteRoot: matched, pattern: setting.pattern }
    : { status: 'unmatched', pattern: setting.pattern };
}

function toRegexSetting(pattern: string, flags: string, rawValue: string): RemoteRootSetting {
  try {
    return { kind: 'regex', pattern, flags, regex: new RegExp(pattern, flags) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'invalid-regex', value: rawValue, error: message };
  }
}

function parseSlashDelimitedRegex(value: string): { pattern: string; flags: string } | null {
  if (!value.startsWith('/')) return null;
  const closingSlash = findLastUnescapedSlash(value);
  if (closingSlash <= 0) return null;

  const flags = value.slice(closingSlash + 1);
  if (!REGEX_FLAGS_PATTERN.test(flags)) return null;

  return {
    pattern: value.slice(1, closingSlash),
    flags,
  };
}

function findLastUnescapedSlash(value: string): number {
  for (let index = value.length - 1; index > 0; index -= 1) {
    if (value[index] === '/' && !isEscaped(value, index)) return index;
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let backslashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}

function toSortedRemoteRootCandidates(packageJsonPaths: readonly string[]): string[] {
  const candidates = packageJsonPaths
    .map((path) => normalizeRemotePackageJsonPath(path))
    .filter((path): path is string => path !== null);

  return [...new Set(candidates)].sort(compareRemoteRootCandidates);
}

function compareRemoteRootCandidates(left: string, right: string): number {
  const depthDiff = remoteRootDepth(left) - remoteRootDepth(right);
  if (depthDiff !== 0) return depthDiff;

  const lengthDiff = left.length - right.length;
  return lengthDiff !== 0 ? lengthDiff : left.localeCompare(right);
}

function remoteRootDepth(value: string): number {
  return value.split('/').filter(Boolean).length;
}

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function regexTest(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}
