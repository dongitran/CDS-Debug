import { basename } from 'node:path';
import type { DebugTarget } from '../types/index';
import { DEBUG_BASE_PORT } from '../types/index';

/**
 * Gets candidate local folder names for a given CF app name.
 * CF often uses hyphens (-) while standard SAP CAP local folders use underscores (_).
 * But custom projects might use exact names. So we try both.
 */
export function getFolderNameCandidates(appName: string): string[] {
  const candidates = [appName];
  const dashReplaced = appName.replaceAll('-', '_');
  if (dashReplaced !== appName) {
    candidates.push(dashReplaced);
  }
  return candidates;
}

/**
 * Finds the full path of a repo folder from a list of scanned paths.
 * Performs match on folder basename against all candidates after normalizing separators.
 */
export function findFolderPath(appName: string, allFolderPaths: string[]): string | null {
  const candidates = getFolderNameCandidates(appName);
  return allFolderPaths.find((p) => candidates.includes(basename(p))) ?? null;
}

/**
 * Builds DebugTarget list from selected app names.
 * Considers existing port mappings and prevents overlapping with already used ports.
 * Apps that cannot be mapped to a local folder are included with folderPath = null
 * so the caller can decide how to handle them (skip or prompt user).
 */
export function buildDebugTargets(
  selectedAppNames: string[],
  allFolderPaths: string[],
  existingPorts: Record<string, number> = {},
  usedPorts = new Set<number>(),
  startPort = DEBUG_BASE_PORT,
): { targets: DebugTarget[]; unmapped: string[] } {
  const targets: DebugTarget[] = [];
  const unmapped: string[] = [];
  let port = startPort;

  for (const appName of selectedAppNames) {
    const folderPath = findFolderPath(appName, allFolderPaths);

    if (folderPath !== null) {
      if (existingPorts[appName]) {
        targets.push({ appName, folderPath, port: existingPorts[appName] });
        usedPorts.add(existingPorts[appName]);
      } else {
        while (usedPorts.has(port)) {
          port++;
        }
        targets.push({ appName, folderPath, port });
        usedPorts.add(port);
        port++;
      }
    } else {
      unmapped.push(appName);
    }
  }

  return { targets, unmapped };
}
