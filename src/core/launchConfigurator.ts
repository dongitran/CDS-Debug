import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { CapDebugConfig, DebugTarget, LaunchConfiguration, LaunchJson } from '../types/index';
import { readCapDebugConfig } from './capDebugConfig';
import { logWarn } from './logger';
import { parseRemoteRootSetting } from './remoteRootResolver';

export { readCapDebugConfig } from './capDebugConfig';

const LAUNCH_JSON_VERSION = '0.2.0';
const SKIP_FILES = ['<node_internals>/**'];
export const DEBUG_CONFIG_PREFIX = 'Debug: ';

// Glob folders that may contain runtime JS for a typical SAP CAP service. `srv` is the
// canonical handler location per https://cap.cloud.sap/docs/node.js/cds-serve, while
// `gen/srv` is emitted by `cds build` for deploy. The remaining folders cover common
// custom-bundling layouts (esbuild → dist, tsc → build, app-layer libs → app/lib).
const OUT_FILES_FOLDERS = ['srv', 'gen/srv', 'app', 'lib', 'dist', 'build'] as const;
// Package Browser explicitly debugs dependency sources; excluding `node_modules` keeps
// those visible breakpoints gray even when runtime mirroring can still pause execution.
const PACKAGE_OUT_FILES_FOLDER = 'node_modules';
const SCRIPT_GLOB_SUFFIX = '/**/*.{js,cjs,mjs}';
const MAX_PACKAGE_OUT_FILES_ANCESTORS = 6;

export interface LaunchGenerationOptions {
  resolvedRemoteRoots?: ReadonlyMap<string, string>;
  workspaceRoot?: string;
}

export interface LaunchConfigOverrides {
  outFiles?: string[];
  outFilesExtra?: string[];
  resolveSourceMapLocations?: string[] | null;
  sourceMapPathOverrides?: Record<string, string>;
}

export interface LaunchBuildOptions {
  packageOutFilesRoots?: readonly string[];
}

let launchJsonLock = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const currentLock = launchJsonLock;
  let release: (() => void) | undefined;
  launchJsonLock = new Promise((resolve) => { release = resolve; });
  
  await currentLock;
  try {
    return await fn();
  } finally {
    if (release) release();
  }
}

export function buildLaunchConfiguration(
  target: DebugTarget,
  remoteRoot: string | undefined,
  localRootOverride?: string,
  overrides?: LaunchConfigOverrides,
  options?: LaunchBuildOptions,
): LaunchConfiguration {
  const localRoot = localRootOverride ?? target.folderPath;
  const config: LaunchConfiguration = {
    type: 'node',
    request: 'attach',
    name: `${DEBUG_CONFIG_PREFIX}${target.appName}`,
    address: '127.0.0.1',
    port: target.port,
    localRoot,
    cdsDebugManaged: true,
    sourceMaps: true,
    skipFiles: SKIP_FILES,
    outFiles: resolveOutFiles(localRoot, overrides, options?.packageOutFilesRoots),
    // null disables the workspace-only filter. Required for attach-mode debugging
    // through SSH tunnels because source maps embed remote paths (/home/vcap/app/...)
    // that fall outside the workspace and would otherwise be silently dropped.
    // See microsoft/vscode-js-debug#759.
    resolveSourceMapLocations: overrides?.resolveSourceMapLocations !== undefined
      ? overrides.resolveSourceMapLocations
      : null,
    sourceMapPathOverrides: resolveSourceMapPathOverrides(localRoot, remoteRoot, overrides),
    // SAP CAP commonly spawns child processes (MTX sidecar, worker_threads, clusters);
    // attaching to them lets breakpoints bind in child code without manual setup.
    autoAttachChildProcesses: true,
  };

  if (remoteRoot !== undefined) {
    config.remoteRoot = remoteRoot;
  }

  return config;
}

function resolveSourceMapPathOverrides(
  localRoot: string,
  remoteRoot: string | undefined,
  overrides: LaunchConfigOverrides | undefined,
): Record<string, string> {
  // Defaults cover (a) vscode-js-debug's webpack patterns we do not want to break and
  // (b) the Cloud Foundry runtime layout, where app source lives at /home/vcap/app/...
  // and dependencies live at /home/vcap/deps/0/node_modules/... per the CF Node buildpack.
  const defaults: Record<string, string> = {
    'webpack:///./~/*': `${localRoot}/node_modules/*`,
    'webpack:////*': '/*',
    'webpack://?:*/*': `${localRoot}/*`,
    '/home/vcap/app/*': `${localRoot}/*`,
    '/home/vcap/deps/0/node_modules/*': `${localRoot}/node_modules/*`,
  };
  if (remoteRoot !== undefined && remoteRoot !== '/home/vcap/app' && remoteRoot !== localRoot) {
    defaults[`${remoteRoot}/*`] = `${localRoot}/*`;
  }
  // User keys win on collision so explicit configuration always overrides our heuristics.
  return { ...defaults, ...overrides?.sourceMapPathOverrides };
}

function resolveOutFiles(
  localRoot: string,
  overrides: LaunchConfigOverrides | undefined,
  packageOutFilesRoots: readonly string[] | undefined,
): string[] {
  if (overrides?.outFiles !== undefined) return [...overrides.outFiles];

  const defaults = buildOutFilesGlobs(localRoot, packageOutFilesRoots);
  const extra = overrides?.outFilesExtra;
  if (extra === undefined || extra.length === 0) return defaults;

  return [...defaults, ...extra];
}

function buildOutFilesGlobs(
  localRoot: string,
  packageOutFilesRoots: readonly string[] | undefined,
): string[] {
  const appFolders = OUT_FILES_FOLDERS
    .map((folder) => `${join(localRoot, folder)}${SCRIPT_GLOB_SUFFIX}`);
  const packageRoots = collectPackageOutFilesRoots(localRoot, packageOutFilesRoots);
  const packageFolders = packageRoots.map((root) => `${join(root, PACKAGE_OUT_FILES_FOLDER)}${SCRIPT_GLOB_SUFFIX}`);
  return [...appFolders, ...packageFolders];
}

function collectPackageOutFilesRoots(
  localRoot: string,
  packageOutFilesRoots: readonly string[] | undefined,
): string[] {
  const roots: string[] = [];
  pushUnique(roots, localRoot);
  for (const root of packageOutFilesRoots ?? []) {
    pushUnique(roots, root);
  }
  return roots;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function collectWorkspacePackageRoots(
  localRoot: string,
  rawLocalRoot: string,
  workspaceRoot: string | undefined,
): string[] {
  if (workspaceRoot === undefined) return [];
  if (!isParentOrSamePath(workspaceRoot, localRoot) && !isParentOrSamePath(workspaceRoot, rawLocalRoot)) return [];
  return [workspaceRoot];
}

function collectAncestorPackageRoots(startPath: string): string[] {
  if (!isAbsolute(startPath)) return [];
  const roots: string[] = [];
  let current = dirname(startPath);
  for (let depth = 0; depth < MAX_PACKAGE_OUT_FILES_ANCESTORS; depth += 1) {
    const next = dirname(current);
    if (next === current) break;
    pushUnique(roots, current);
    current = next;
  }
  return roots;
}

function collectGeneratedPackageRoots(
  localRoot: string,
  rawLocalRoot: string,
  workspaceRoot: string | undefined,
): string[] {
  const roots: string[] = [];
  for (const root of collectWorkspacePackageRoots(localRoot, rawLocalRoot, workspaceRoot)) {
    pushUnique(roots, root);
  }
  for (const root of collectAncestorPackageRoots(localRoot)) {
    pushUnique(roots, root);
  }
  for (const root of collectAncestorPackageRoots(rawLocalRoot)) {
    pushUnique(roots, root);
  }
  return roots;
}

function isParentOrSamePath(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function resolveLocalRootSafe(rawPath: string): Promise<string> {
  try {
    const resolved = await realpath(rawPath);
    if (typeof resolved !== 'string' || resolved.length === 0) return rawPath;
    if (resolved !== rawPath) {
      logWarn(`[LaunchConfig] localRoot resolved via symlink: ${rawPath} → ${resolved}`);
    }
    return resolved;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn(`[LaunchConfig] failed to resolve realpath for ${rawPath} (${message}); using raw path`);
    return rawPath;
  }
}

export async function generateLaunchConfigurations(
  targets: DebugTarget[],
  fallbackConfig: CapDebugConfig | null = null,
  options: LaunchGenerationOptions = {},
): Promise<LaunchConfiguration[]> {
  const configs: LaunchConfiguration[] = [];
  for (const target of targets) {
    const appConfig = await readCapDebugConfig(target.folderPath);
    // Per-app config takes priority; workspace-level .vscode/cap-debug-config.json is the fallback
    const configuredRemoteRoot = appConfig?.remoteRoot ?? fallbackConfig?.remoteRoot;
    const localRoot = await resolveLocalRootSafe(target.folderPath);
    const remoteRoot = resolveLaunchRemoteRoot(
      configuredRemoteRoot,
      options.resolvedRemoteRoots?.get(target.appName),
      localRoot,
    );
    const overrides = mergeLaunchConfigOverrides(appConfig, fallbackConfig);
    configs.push(buildLaunchConfiguration(target, remoteRoot, localRoot, overrides, {
      packageOutFilesRoots: collectGeneratedPackageRoots(localRoot, target.folderPath, options.workspaceRoot),
    }));
  }
  return configs;
}

function mergeLaunchConfigOverrides(
  appConfig: CapDebugConfig | null,
  fallbackConfig: CapDebugConfig | null,
): LaunchConfigOverrides {
  // Per-service config beats the workspace/user fallback for every override field.
  // resolveSourceMapLocations needs an explicit `in` check because `null` is a meaningful
  // user value (keep VS Code's filter disabled) and would collapse under nullish coalescing.
  const resolveSourceMapLocations = appConfig?.resolveSourceMapLocations !== undefined
    ? appConfig.resolveSourceMapLocations
    : fallbackConfig?.resolveSourceMapLocations;
  const overrides: LaunchConfigOverrides = {};
  const outFiles = appConfig?.outFiles ?? fallbackConfig?.outFiles;
  if (outFiles !== undefined) overrides.outFiles = outFiles;
  const outFilesExtra = appConfig?.outFilesExtra ?? fallbackConfig?.outFilesExtra;
  if (outFilesExtra !== undefined) overrides.outFilesExtra = outFilesExtra;
  if (resolveSourceMapLocations !== undefined) overrides.resolveSourceMapLocations = resolveSourceMapLocations;
  const sourceMapPathOverrides = appConfig?.sourceMapPathOverrides ?? fallbackConfig?.sourceMapPathOverrides;
  if (sourceMapPathOverrides !== undefined) overrides.sourceMapPathOverrides = sourceMapPathOverrides;
  return overrides;
}

export async function getExistingLaunchConfigs(workspacePath: string): Promise<LaunchJson> {
  const launchJsonPath = join(workspacePath, '.vscode', 'launch.json');
  let existing: LaunchJson = { version: LAUNCH_JSON_VERSION, configurations: [] };
  try {
    const raw = await readFile(launchJsonPath, 'utf8');
    existing = normalizeLaunchJson(JSON.parse(raw) as unknown);
  } catch {
    // File does not exist yet — start fresh
  }
  return existing;
}

export async function mergeLaunchJson(
  workspacePath: string,
  targets: DebugTarget[],
  fallbackConfig: CapDebugConfig | null = null,
  options: LaunchGenerationOptions = {},
): Promise<void> {
  return withLock(async () => {
    const launchJsonPath = join(workspacePath, '.vscode', 'launch.json');
    const newConfigs = await generateLaunchConfigurations(targets, fallbackConfig, {
      ...options,
      workspaceRoot: options.workspaceRoot ?? workspacePath,
    });
    const newNames = new Set(newConfigs.map((c) => c.name));

    const existing = await getExistingLaunchConfigs(workspacePath);

    const kept = existing.configurations.filter((c) => !newNames.has(c.name));
    const merged: LaunchJson = {
      version: existing.version || LAUNCH_JSON_VERSION,
      configurations: [...kept, ...newConfigs],
    };

    await mkdir(dirname(launchJsonPath), { recursive: true });
    await writeFile(launchJsonPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  });
}

function resolveLaunchRemoteRoot(
  configuredRemoteRoot: string | undefined,
  resolvedRemoteRoot: string | undefined,
  localRoot: string,
): string | undefined {
  const setting = parseRemoteRootSetting(configuredRemoteRoot);
  if (setting.kind === 'literal') return setting.value;
  if (setting.kind !== 'regex') return undefined;
  if (resolvedRemoteRoot !== undefined) return resolvedRemoteRoot;
  // Sprint 1 Fix #1 — regex configured but the lookup has not yet produced a match.
  // Falling back to localRoot guarantees launch.json includes a remoteRoot so VS Code
  // installs a path-mapping rule. Without this, source maps with embedded remote paths
  // are silently dropped and breakpoints stay unbound until a Stop+Start cycle warms
  // the resolver cache.
  logWarn(
    `[LaunchConfig] regex remoteRoot "${setting.pattern}" did not resolve; falling back to localRoot ${localRoot}`,
  );
  return localRoot;
}

// Removes configurations with the given debug names (e.g. "Debug: my-app")
// from launch.json. Called on stop to keep the file clean.
export async function removeLaunchConfigs(workspacePath: string, appNames: string[]): Promise<void> {
  return withLock(async () => {
    if (appNames.length === 0) return;

    const launchJsonPath = join(workspacePath, '.vscode', 'launch.json');
    const existing = await getExistingLaunchConfigs(workspacePath);

    const namesToRemove = new Set(appNames.map((n) => `${DEBUG_CONFIG_PREFIX}${n}`));
    const kept = existing.configurations.filter((c) => !(namesToRemove.has(c.name) && isManagedDebugConfig(c)));

    // Nothing changed — skip the write to avoid unnecessary disk I/O
    if (kept.length === existing.configurations.length) return;

    const updated: LaunchJson = {
      version: existing.version || LAUNCH_JSON_VERSION,
      configurations: kept,
    };

    await mkdir(dirname(launchJsonPath), { recursive: true });
    await writeFile(launchJsonPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  });
}

// Removes all auto-generated debug configurations (prefixed with DEBUG_CONFIG_PREFIX) from
// launch.json. Called on extension activation to clean up configs left by a previous session
// that ended without proper cleanup (e.g. VS Code was force-killed while debugging).
// Safe to call unconditionally on startup because no debug sessions can be active when the
// extension is first loading into a new VS Code instance.
export async function cleanStaleDebugConfigs(workspacePath: string): Promise<void> {
  return withLock(async () => {
    const existing = await getExistingLaunchConfigs(workspacePath);
    const kept = existing.configurations.filter((c) => !isManagedDebugConfig(c));

    // Nothing to clean — skip disk I/O
    if (kept.length === existing.configurations.length) return;

    const updated: LaunchJson = {
      version: existing.version || LAUNCH_JSON_VERSION,
      configurations: kept,
    };

    const launchJsonPath = join(workspacePath, '.vscode', 'launch.json');
    await mkdir(dirname(launchJsonPath), { recursive: true });
    await writeFile(launchJsonPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
  });
}

function isManagedDebugConfig(config: LaunchConfiguration): boolean {
  if (config.cdsDebugManaged === true) return true;

  // Backward compatibility: older extension versions generated configs without
  // cdsDebugManaged. Restrict legacy detection to the exact attach shape used
  // by CDS Debug to avoid deleting user-defined "Debug: ..." entries.
  return (
    config.name.startsWith(DEBUG_CONFIG_PREFIX)
    && config.type === 'node'
    && config.request === 'attach'
    && config.address === '127.0.0.1'
  );
}

function normalizeLaunchJson(value: unknown): LaunchJson {
  if (typeof value !== 'object' || value === null) {
    return { version: LAUNCH_JSON_VERSION, configurations: [] };
  }

  const record = value as Record<string, unknown>;
  const version = typeof record.version === 'string' && record.version.trim().length > 0
    ? record.version
    : LAUNCH_JSON_VERSION;
  const configurations = normalizeConfigurations(record.configurations);

  return { version, configurations };
}

function normalizeConfigurations(value: unknown): LaunchConfiguration[] {
  if (!Array.isArray(value)) return [];

  return value.filter((item): item is LaunchConfiguration => {
    if (typeof item !== 'object' || item === null) return false;
    const config = item as Record<string, unknown>;
    return typeof config.name === 'string';
  });
}
