import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { CapDebugConfig, DebugTarget, LaunchConfiguration, LaunchJson } from '../types/index';
import { readCapDebugConfig } from './capDebugConfig';

export { readCapDebugConfig } from './capDebugConfig';

const LAUNCH_JSON_VERSION = '0.2.0';
const GENERATED_SRV_PATH = 'gen/srv';
const SKIP_FILES = ['<node_internals>/**'];
export const DEBUG_CONFIG_PREFIX = 'Debug: ';

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
): LaunchConfiguration {
  const localRoot = localRootOverride ?? target.folderPath;
  const outFilesRoot = join(target.folderPath, GENERATED_SRV_PATH);
  const config: LaunchConfiguration = {
    type: 'node',
    request: 'attach',
    name: `${DEBUG_CONFIG_PREFIX}${target.appName}`,
    address: '127.0.0.1',
    port: target.port,
    localRoot,
    cdsDebugManaged: true,
    sourceMaps: true,
    restart: true,
    skipFiles: SKIP_FILES,
    outFiles: [`${outFilesRoot}/**/*.js`],
  };

  // Only include remoteRoot when explicitly provided — omitting it avoids
  // path-mapping errors when the remote and local paths happen to align.
  if (remoteRoot !== undefined) {
    config.remoteRoot = remoteRoot;
  }

  return config;
}

export async function generateLaunchConfigurations(
  targets: DebugTarget[],
  fallbackConfig: CapDebugConfig | null = null,
): Promise<LaunchConfiguration[]> {
  const configs: LaunchConfiguration[] = [];
  for (const target of targets) {
    const appConfig = await readCapDebugConfig(target.folderPath);
    // Per-app config takes priority; workspace-level .vscode/cap-debug-config.json is the fallback
    const remoteRoot = appConfig?.remoteRoot ?? fallbackConfig?.remoteRoot;
    configs.push(buildLaunchConfiguration(target, remoteRoot));
  }
  return configs;
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
): Promise<void> {
  return withLock(async () => {
    const launchJsonPath = join(workspacePath, '.vscode', 'launch.json');
    const newConfigs = await generateLaunchConfigurations(targets, fallbackConfig);
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
