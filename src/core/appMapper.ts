import { basename } from 'node:path';
import type { DebugTarget } from '../types/index';
import { DEBUG_BASE_PORT } from '../types/index';

/**
 * Converts a CF app name to its expected local folder name.
 * CF uses hyphens (-), local folders use underscores (_).
 * Example: "prefix-srv-config-main" → "prefix_srv_config_main"
 */
export function cfAppNameToFolderName(appName: string): string {
  return appName.replaceAll('-', '_');
}

/**
 * Finds the full path of a repo folder from a list of scanned paths.
 * Performs exact match on folder basename after normalizing separators.
 */
export function findFolderPath(targetFolderName: string, allFolderPaths: string[]): string | null {
  return allFolderPaths.find((p) => basename(p) === targetFolderName) ?? null;
}

/**
 * Builds DebugTarget list from selected app names.
 * Apps that cannot be mapped to a local folder are included with folderPath = null
 * so the caller can decide how to handle them (skip or prompt user).
 */
export function buildDebugTargets(
  selectedAppNames: string[],
  allFolderPaths: string[],
  startPort = DEBUG_BASE_PORT,
): { targets: DebugTarget[]; unmapped: string[] } {
  const targets: DebugTarget[] = [];
  const unmapped: string[] = [];
  let port = startPort;

  for (const appName of selectedAppNames) {
    const folderName = cfAppNameToFolderName(appName);
    const folderPath = findFolderPath(folderName, allFolderPaths);

    if (folderPath !== null) {
      targets.push({ appName, folderPath, port });
      port++;
    } else {
      unmapped.push(appName);
    }
  }

  return { targets, unmapped };
}
