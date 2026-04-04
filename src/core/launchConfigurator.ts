import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { DebugTarget, LaunchConfiguration, LaunchJson } from '../types/index';

const LAUNCH_JSON_VERSION = '0.2.0';
const SKIP_FILES = ['<node_internals>/**'];

export function generateLaunchConfigurations(targets: DebugTarget[]): LaunchConfiguration[] {
  return targets.map((target) => ({
    type: 'node',
    request: 'attach',
    name: `Debug: ${target.appName}`,
    port: target.port,
    localRoot: target.folderPath,
    remoteRoot: '/home/vcap/app', // cspell:ignore vcap
    sourceMaps: true,
    restart: true,
    skipFiles: SKIP_FILES,
  }));
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
  const newConfigs = generateLaunchConfigurations(targets);
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
