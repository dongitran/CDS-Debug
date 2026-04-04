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

export async function mergeLaunchJson(workspacePath: string, targets: DebugTarget[]): Promise<void> {
  const launchJsonPath = join(workspacePath, '.vscode', 'launch.json');
  const newConfigs = generateLaunchConfigurations(targets);
  const newNames = new Set(newConfigs.map((c) => c.name));

  let existing: LaunchJson = { version: LAUNCH_JSON_VERSION, configurations: [] };
  try {
    const raw = await readFile(launchJsonPath, 'utf8');
    existing = JSON.parse(raw) as LaunchJson;
  } catch {
    // File does not exist yet — start fresh
  }

  const kept = existing.configurations.filter((c) => !newNames.has(c.name));
  const merged: LaunchJson = {
    version: LAUNCH_JSON_VERSION,
    configurations: [...kept, ...newConfigs],
  };

  await mkdir(dirname(launchJsonPath), { recursive: true });
  await writeFile(launchJsonPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}
