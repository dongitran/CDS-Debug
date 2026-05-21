import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';
import type { LoadedPackageSource } from '../types/index';

interface DapSourceResponse {
  content?: unknown;
}

interface MaterializationOptions {
  localRoot?: string;
  // Extension-scoped fallback when no local candidate is safe (e.g. cross-app
  // pnpm-hoisted packages whose source path prefix points at a different CF app
  // container than the user's workspace localRoot). Materializing under the
  // extension's globalStorage keeps the file URI stable across debug sessions
  // and avoids polluting any workspace tree.
  packageCacheRoot?: string;
}

const LEADING_SLASHES_PATTERN = /^\/{2,}/u;
const UNSAFE_FILENAME_CHARS_PATTERN = /[<>:"|?*]/gu;

export async function materializePackageSourceContent(
  session: vscode.DebugSession,
  source: LoadedPackageSource,
  candidatePaths: readonly string[],
  options: MaterializationOptions = {},
): Promise<string | null> {
  if (typeof source.sourceReference !== 'number' || source.sourceReference <= 0) return null;
  const targetPath = selectMaterializationTarget(source, candidatePaths, options.localRoot, options.packageCacheRoot);
  if (targetPath === null) return null;

  try {
    const content = await requestSourceContent(session, source);
    if (content === null) return null;
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
    logInfo(`[PackageSource] materialized sourceRef=${source.sourceReference.toString()} path=${targetPath}`);
    return targetPath;
  } catch (err: unknown) {
    logWarn(`[PackageSource] materialize failed for ${targetPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function selectMaterializationTarget(
  source: LoadedPackageSource,
  candidatePaths: readonly string[],
  localRoot: string | undefined,
  packageCacheRoot: string | undefined,
): string | null {
  const candidates = collectMaterializationCandidates(source, candidatePaths);
  const target = candidates.find((candidate) => isSafePackageMaterializationPath(candidate, localRoot)) ?? null;
  if (target !== null) return target;
  const cacheTarget = buildPackageCacheTarget(source, packageCacheRoot);
  if (cacheTarget !== null) {
    logInfo(`[PackageSource] using extension cache fallback path=${cacheTarget}`);
    return cacheTarget;
  }
  logSkippedMaterialization(source, candidates, localRoot);
  return null;
}

// When the remote source path's package root sits outside any local workspace or
// localRoot ancestor (e.g. pnpm-hoisted package whose path prefix names a
// different CF app container), there is no safe filesystem destination tied to
// the user's project. Falling back to a stable extension-scoped cache lets us
// materialize the source content into a real `file:` URI so the user can read
// the `.ts` source, set breakpoints, and avoid the `debug:` URI path entirely.
function buildPackageCacheTarget(
  source: LoadedPackageSource,
  packageCacheRoot: string | undefined,
): string | null {
  if (packageCacheRoot === undefined) return null;
  if (!source.path) return null;
  const normalized = source.path
    .replaceAll('\\', '/')
    .replace(LEADING_SLASHES_PATTERN, '/');
  if (!normalized.includes('/node_modules/')) return null;
  const marker = '/node_modules/';
  const lastMarkerIndex = normalized.lastIndexOf(marker);
  if (lastMarkerIndex === -1) return null;
  const packagePath = normalized.slice(lastMarkerIndex + marker.length);
  if (!packagePath || packagePath.startsWith('.bin/')) return null;
  const safeSegments = packagePath
    .split('/')
    .map((segment) => segment.replace(UNSAFE_FILENAME_CHARS_PATTERN, '_'))
    .filter((segment) => segment.length > 0);
  if (safeSegments.length === 0) return null;
  return join(packageCacheRoot, ...safeSegments);
}

function collectMaterializationCandidates(
  source: LoadedPackageSource,
  candidatePaths: readonly string[],
): string[] {
  const candidates: string[] = [];
  const directPath = toLocalSourcePath(source);
  if (directPath !== null) pushUnique(candidates, directPath);
  for (const path of candidatePaths) pushUnique(candidates, path);
  return candidates;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function toLocalSourcePath(source: LoadedPackageSource): string | null {
  if (!source.path) return null;
  if (source.path.startsWith('file://')) return decodeURIComponent(source.path.slice('file://'.length));
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source.path)) return null;
  return source.path.replace(LEADING_SLASHES_PATTERN, '/');
}

function isSafePackageMaterializationPath(filePath: string, localRoot: string | undefined): boolean {
  if (!isAbsolute(filePath)) return false;
  if (!pathContainsNodeModules(filePath)) return false;
  return isInsideWorkspace(filePath) || isInsideLocalRootPackageAncestor(filePath, localRoot);
}

function pathContainsNodeModules(filePath: string): boolean {
  return filePath.split(/[\\/]+/u).includes('node_modules');
}

function isInsideWorkspace(filePath: string): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0) return false;
  return folders.some((folder) => {
    const rel = relative(folder.uri.fsPath, filePath);
    return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

function isInsideLocalRootPackageAncestor(filePath: string, localRoot: string | undefined): boolean {
  if (localRoot === undefined || !isAbsolute(localRoot)) return false;
  const packageRoot = extractPackageRoot(filePath);
  return packageRoot !== null && isParentOrSamePath(packageRoot, localRoot);
}

function extractPackageRoot(filePath: string): string | null {
  const normalized = filePath.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex <= 0) return null;
  return normalized.slice(0, markerIndex);
}

function isParentOrSamePath(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel));
}

function logSkippedMaterialization(
  source: LoadedPackageSource,
  candidates: readonly string[],
  localRoot: string | undefined,
): void {
  if (source.path === undefined || !pathContainsNodeModules(source.path)) return;
  logInfo(
    `[PackageSource] skipped materialize unsafe path=${source.path} localRoot=${localRoot ?? '<none>'} candidates=${candidates.length.toString()}`,
  );
}

async function requestSourceContent(
  session: vscode.DebugSession,
  source: LoadedPackageSource,
): Promise<string | null> {
  const response = await session.customRequest('source', {
    source: toDapSource(source),
    sourceReference: source.sourceReference,
  }) as DapSourceResponse | undefined;
  return typeof response?.content === 'string' ? response.content : null;
}

function toDapSource(source: LoadedPackageSource): { name?: string; path?: string; sourceReference?: number } {
  const dapSource: { name?: string; path?: string; sourceReference?: number } = {};
  if (source.name !== undefined) dapSource.name = source.name;
  if (source.path !== undefined) dapSource.path = source.path;
  if (source.sourceReference !== undefined) dapSource.sourceReference = source.sourceReference;
  return dapSource;
}
