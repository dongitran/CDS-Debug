import * as vscode from 'vscode';
import type { LoadedPackageEntry, LoadedPackageFile, LoadedPackageSource } from '../types/index';

interface ParsedPackageFile {
  packageId: string;
  packageName: string;
  displayName: string;
  version?: string;
  relativePath: string;
  source: LoadedPackageSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSourcePath(rawPath: string): string {
  const decoded = rawPath.startsWith('file://')
    ? decodeURIComponent(rawPath.slice('file://'.length))
    : decodeURIComponent(rawPath);
  return decoded.replaceAll('\\', '/');
}

function extractPackagePath(normalizedPath: string): string | null {
  const marker = '/node_modules/';
  const markerIndex = normalizedPath.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const packagePath = normalizedPath.slice(markerIndex + marker.length);
  if (!packagePath || packagePath.startsWith('.bin/')) return null;
  return packagePath;
}

function parsePackageSegments(packagePath: string): { packageName: string; relativePath: string } | null {
  const segments = packagePath.split('/').filter(Boolean);
  const firstSegment = segments[0];
  if (!firstSegment) return null;
  if (firstSegment.startsWith('@')) {
    const secondSegment = segments[1];
    const rest = segments.slice(2);
    if (!secondSegment || rest.length === 0) return null;
    return {
      packageName: `${firstSegment}/${secondSegment}`,
      relativePath: rest.join('/'),
    };
  }
  const rest = segments.slice(1);
  if (rest.length === 0) return null;
  return {
    packageName: firstSegment,
    relativePath: rest.join('/'),
  };
}

function extractPnpmVersion(normalizedPath: string): string | undefined {
  const pnpmMatch = /\/node_modules\/\.pnpm\/([^/]+)\/node_modules\//.exec(normalizedPath);
  if (!pnpmMatch) return undefined;
  const encodedPackage = pnpmMatch[1];
  if (!encodedPackage) return undefined;
  const versionIndex = encodedPackage.lastIndexOf('@');
  if (versionIndex <= 0 || versionIndex === encodedPackage.length - 1) return undefined;
  return encodedPackage.slice(versionIndex + 1);
}

function toLoadedPackageSource(value: unknown): LoadedPackageSource | null {
  if (!isRecord(value)) return null;
  const source: LoadedPackageSource = {};
  if (typeof value.name === 'string') source.name = value.name;
  if (typeof value.path === 'string') source.path = value.path;
  if (typeof value.sourceReference === 'number') source.sourceReference = value.sourceReference;
  if (typeof value.origin === 'string') source.origin = value.origin;
  if (typeof value.presentationHint === 'string') source.presentationHint = value.presentationHint;
  if (!source.path && !source.name) return null;
  return source;
}

function parsePackageFile(source: LoadedPackageSource): ParsedPackageFile | null {
  if (!source.path) return null;
  const normalizedPath = normalizeSourcePath(source.path);
  const packagePath = extractPackagePath(normalizedPath);
  if (!packagePath) return null;
  const parsedSegments = parsePackageSegments(packagePath);
  if (!parsedSegments) return null;
  const version = extractPnpmVersion(normalizedPath);
  const parsed: ParsedPackageFile = {
    packageId: version ? `${parsedSegments.packageName}@${version}` : parsedSegments.packageName,
    packageName: parsedSegments.packageName,
    displayName: version ? `${parsedSegments.packageName}@${version}` : parsedSegments.packageName,
    relativePath: parsedSegments.relativePath,
    source,
  };
  if (version) parsed.version = version;
  return parsed;
}

function getLoadedSourcesResponseSources(response: unknown): LoadedPackageSource[] {
  if (!isRecord(response) || !Array.isArray(response.sources)) {
    throw new Error('Debugger did not return loaded sources.');
  }
  return response.sources
    .map(toLoadedPackageSource)
    .filter((source): source is LoadedPackageSource => source !== null);
}

function toOpenUri(session: vscode.DebugSession, source: LoadedPackageSource): vscode.Uri {
  if (typeof source.sourceReference === 'number' && source.sourceReference > 0) {
    return vscode.debug.asDebugSourceUri(source as vscode.DebugProtocolSource, session);
  }
  if (!source.path) {
    throw new Error('Package source cannot be opened because it has no path.');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(source.path)) {
    return vscode.Uri.parse(source.path);
  }
  return vscode.Uri.file(source.path);
}

export function buildPackageEntries(sources: LoadedPackageSource[]): LoadedPackageEntry[] {
  const entriesById = new Map<string, { entry: LoadedPackageEntry; fileIds: Set<string> }>();

  for (const source of sources) {
    const parsed = parsePackageFile(source);
    if (!parsed) continue;

    const existing = entriesById.get(parsed.packageId);
    const fileId = `${parsed.packageId}:${parsed.relativePath}`;
    const file: LoadedPackageFile = {
      id: fileId,
      label: parsed.relativePath,
      relativePath: parsed.relativePath,
      source: parsed.source,
    };

    if (!existing) {
      const entry: LoadedPackageEntry = {
        id: parsed.packageId,
        name: parsed.packageName,
        displayName: parsed.displayName,
        files: [file],
      };
      if (parsed.version) entry.version = parsed.version;
      entriesById.set(parsed.packageId, {
        entry,
        fileIds: new Set([fileId]),
      });
      continue;
    }

    if (existing.fileIds.has(fileId)) continue;
    existing.fileIds.add(fileId);
    existing.entry.files.push(file);
  }

  return Array.from(entriesById.values())
    .map(({ entry }) => ({
      ...entry,
      files: entry.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function loadPackageEntries(session: vscode.DebugSession): Promise<LoadedPackageEntry[]> {
  const response = await session.customRequest('loadedSources', {}) as unknown;
  const sources = getLoadedSourcesResponseSources(response);
  return buildPackageEntries(sources);
}

export async function openPackageSource(
  session: vscode.DebugSession,
  source: LoadedPackageSource,
): Promise<void> {
  const uri = toOpenUri(session, source);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: true });
}
