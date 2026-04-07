import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { DebugTarget, LaunchConfiguration, LaunchJson } from '../types/index';

const LAUNCH_JSON_VERSION = '0.2.0';
const SKIP_FILES = ['<node_internals>/**', '**/node_modules/**'];
const GEN_SRV_SUFFIX = 'gen/srv';

// Schema for the optional per-project config file.
interface CapDebugConfig {
  remoteRoot?: string;
}

// Reads cap-debug-config.json from the app's root folder.
// Returns null if the file does not exist or is malformed.
export async function readCapDebugConfig(folderPath: string): Promise<CapDebugConfig | null> {
  const configPath = join(folderPath, 'cap-debug-config.json');
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.remoteRoot === 'string') {
      return { remoteRoot: record.remoteRoot };
    }
    return {};
  } catch {
    // File absent or cannot be parsed — caller falls back to defaults
    return null;
  }
}

export function buildLaunchConfiguration(
  target: DebugTarget,
  remoteRoot: string | undefined,
): LaunchConfiguration {
  const localRoot = join(target.folderPath, GEN_SRV_SUFFIX);
  const config: LaunchConfiguration = {
    type: 'node',
    request: 'attach',
    name: `Debug: ${target.appName}`,
    address: '127.0.0.1',
    port: target.port,
    localRoot,
    sourceMaps: true,
    restart: true,
    skipFiles: SKIP_FILES,
    outFiles: [`${localRoot}/**/*.js`],
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
): Promise<LaunchConfiguration[]> {
  const configs: LaunchConfiguration[] = [];
  for (const target of targets) {
    const capConfig = await readCapDebugConfig(target.folderPath);
    // capConfig.remoteRoot is used when set; undefined means field is omitted
    configs.push(buildLaunchConfiguration(target, capConfig?.remoteRoot));
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

export async function mergeLaunchJson(workspacePath: string, targets: DebugTarget[]): Promise<void> {
  const launchJsonPath = join(workspacePath, '.vscode', 'launch.json');
  const newConfigs = await generateLaunchConfigurations(targets);
  const newNames = new Set(newConfigs.map((c) => c.name));

  const existing = await getExistingLaunchConfigs(workspacePath);

  const kept = existing.configurations.filter((c) => !newNames.has(c.name));
  const merged: LaunchJson = {
    version: existing.version || LAUNCH_JSON_VERSION,
    configurations: [...kept, ...newConfigs],
  };

  await mkdir(dirname(launchJsonPath), { recursive: true });
  await writeFile(launchJsonPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

// Removes configurations with the given debug names (e.g. "Debug: my-app")
// from launch.json. Called on stop to keep the file clean.
export async function removeLaunchConfigs(workspacePath: string, appNames: string[]): Promise<void> {
  if (appNames.length === 0) return;

  const launchJsonPath = join(workspacePath, '.vscode', 'launch.json');
  const existing = await getExistingLaunchConfigs(workspacePath);

  const namesToRemove = new Set(appNames.map((n) => `Debug: ${n}`));
  const kept = existing.configurations.filter((c) => !namesToRemove.has(c.name));

  // Nothing changed — skip the write to avoid unnecessary disk I/O
  if (kept.length === existing.configurations.length) return;

  const updated: LaunchJson = {
    version: existing.version || LAUNCH_JSON_VERSION,
    configurations: kept,
  };

  await mkdir(dirname(launchJsonPath), { recursive: true });
  await writeFile(launchJsonPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
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
