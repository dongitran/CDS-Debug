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
 * Allocates a port for an app, respecting existingPorts and usedPorts.
 * Mutates usedPorts so subsequent calls in the same batch never collide.
 */
function allocatePort(
  appName: string,
  existingPorts: Record<string, number>,
  usedPorts: Set<number>,
  cursor: { port: number },
): number {
  const existing = existingPorts[appName];
  if (existing !== undefined) {
    usedPorts.add(existing);
    return existing;
  }
  while (usedPorts.has(cursor.port)) cursor.port++;
  const assigned = cursor.port;
  usedPorts.add(assigned);
  cursor.port++;
  return assigned;
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
  const cursor = { port: startPort };

  for (const appName of selectedAppNames) {
    const folderPath = findFolderPath(appName, allFolderPaths);
    if (folderPath !== null) {
      targets.push({ appName, folderPath, port: allocatePort(appName, existingPorts, usedPorts, cursor) });
    } else {
      unmapped.push(appName);
    }
  }

  return { targets, unmapped };
}

/**
 * Builds fallback DebugTarget list for apps that could not be mapped to a local folder.
 * Uses the provided folderPath (e.g. workspace root) for all targets and marks each
 * with noLocalFolder = true so the UI can signal that source maps are unavailable.
 */
export function buildFallbackTargets(
  appNames: string[],
  folderPath: string,
  existingPorts: Record<string, number> = {},
  usedPorts = new Set<number>(),
  startPort = DEBUG_BASE_PORT,
): DebugTarget[] {
  const cursor = { port: startPort };
  return appNames.map((appName) => ({
    appName,
    folderPath,
    port: allocatePort(appName, existingPorts, usedPorts, cursor),
    noLocalFolder: true,
  }));
}
