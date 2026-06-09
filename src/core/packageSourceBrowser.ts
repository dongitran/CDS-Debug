import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import { logInfo } from './logger';
import type {
  LoadedPackageEntry,
  LoadedPackageFile,
  LoadedPackageFileMatch,
  LoadedPackageFolderNode,
  LoadedPackageLeafNode,
  PackageSourceLocation,
  LoadedPackageSource,
  LoadedPackageTreeNode,
} from '../types/index';

type PackageBrowserLogFn = (message: string) => void;

interface LoadPackageEntriesOptions {
  maxAttempts?: number;
  emptyRetryDelayMs?: number;
  loadedSourcesRequestTimeoutMs?: number;
}

interface ParsedPackageFile {
  packageId: string;
  packageName: string;
  displayName: string;
  version?: string;
  relativePath: string;
  source: LoadedPackageSource;
}

interface FolderBuilderNode {
  name: string;
  path: string;
  folders: Map<string, FolderBuilderNode>;
  files: LoadedPackageLeafNode[];
}

type PackageSessionSource = readonly vscode.DebugSession[] | (() => readonly vscode.DebugSession[]);

export interface PackageSearchIndex {
  entries: LoadedPackageEntry[];
  contentCache: Map<string, Promise<string | null>>;
  localRoot?: string;
}

interface PackageSearchOptions {
  packageNameFilterRegex?: string | undefined;
}

export interface OpenedPackageSourceRecord {
  appName: string;
  uri: vscode.Uri;
  source?: LoadedPackageSource;
  sessionId?: string;
  sessionName?: string;
}

const DEFAULT_LOAD_PACKAGE_ENTRIES_OPTIONS: Required<LoadPackageEntriesOptions> = {
  maxAttempts: 30,
  emptyRetryDelayMs: 1_000,
  loadedSourcesRequestTimeoutMs: 10_000,
};

const SOURCE_URI_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSourcePath(rawPath: string): string {
  const decoded = rawPath.startsWith('file://')
    ? decodeURIComponent(rawPath.slice('file://'.length))
    : decodeURIComponent(rawPath);
  return decoded.replaceAll('\\', '/');
}

function toReadableLocalSourcePath(source: LoadedPackageSource): string | null {
  if (!source.path) return null;
  if (source.path.startsWith('file://')) {
    return normalizeSourcePath(source.path);
  }
  if (SOURCE_URI_PATTERN.test(source.path)) {
    return null;
  }
  return normalizeSourcePath(source.path);
}

function extractPackagePath(normalizedPath: string): string | null {
  const marker = '/node_modules/';
  const markerIndex = normalizedPath.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const packagePath = normalizedPath.slice(markerIndex + marker.length);
  if (!packagePath || packagePath.startsWith('.bin/')) return null;
  return packagePath;
}

function extractNodeModulesSuffix(normalizedPath: string): string | null {
  const marker = '/node_modules/';
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex === -1) return null;
  const suffix = normalizedPath.slice(markerIndex + marker.length);
  if (!suffix) return null;
  return suffix;
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

function createFolderBuilder(name: string, path: string): FolderBuilderNode {
  return {
    name,
    path,
    folders: new Map<string, FolderBuilderNode>(),
    files: [],
  };
}

function createFileLeafNode(fileName: string, file: LoadedPackageFile): LoadedPackageLeafNode {
  return {
    id: file.id,
    kind: 'file',
    name: fileName,
    path: file.relativePath,
    file,
  };
}

function getOrCreateFolderBuilder(
  parent: FolderBuilderNode,
  segment: string,
  path: string,
): FolderBuilderNode {
  const existing = parent.folders.get(segment);
  if (existing) return existing;
  const next = createFolderBuilder(segment, path);
  parent.folders.set(segment, next);
  return next;
}

function insertFileIntoFolderTree(root: FolderBuilderNode, file: LoadedPackageFile): void {
  const segments = file.relativePath.split('/').filter(Boolean);
  const fileName = segments.pop();
  if (!fileName) return;

  let cursor = root;
  for (const segment of segments) {
    const nextPath = cursor.path ? `${cursor.path}/${segment}` : segment;
    cursor = getOrCreateFolderBuilder(cursor, segment, nextPath);
  }

  cursor.files.push(createFileLeafNode(fileName, file));
}

function compareTreeNodeNames(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}

function toFolderTreeNodes(builder: FolderBuilderNode): LoadedPackageTreeNode[] {
  const folders: LoadedPackageFolderNode[] = Array.from(builder.folders.values())
    .sort(compareTreeNodeNames)
    .map((folder) => ({
      id: `folder:${folder.path}`,
      kind: 'folder',
      name: folder.name,
      path: folder.path,
      children: toFolderTreeNodes(folder),
    }));
  const files = builder.files
    .slice()
    .sort(compareTreeNodeNames);
  return [...folders, ...files];
}

export function buildPackageFileTree(files: LoadedPackageFile[]): LoadedPackageTreeNode[] {
  const root = createFolderBuilder('', '');
  for (const file of files) {
    insertFileIntoFolderTree(root, file);
  }
  return toFolderTreeNodes(root);
}

function clonePackageFile(file: LoadedPackageFile, match?: LoadedPackageFileMatch): LoadedPackageFile {
  const nextFile: LoadedPackageFile = {
    ...file,
    source: { ...file.source },
  };
  if (match) nextFile.match = { ...match };
  return nextFile;
}

function clonePackageEntry(entry: LoadedPackageEntry, files: LoadedPackageFile[]): LoadedPackageEntry {
  const nextEntry: LoadedPackageEntry = {
    ...entry,
    files,
    tree: buildPackageFileTree(files),
  };
  return nextEntry;
}

function normalizePackageSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

function createPackageNameFilterRegex(regexSource: string | undefined): RegExp | null {
  if (!regexSource) return null;
  const trimmed = regexSource.trim();
  if (!trimmed) return null;
  try {
    return new RegExp(trimmed);
  } catch {
    return null;
  }
}

function matchesPackageEntryQuery(entry: LoadedPackageEntry, query: string): boolean {
  return entry.name.toLowerCase().includes(query) || entry.displayName.toLowerCase().includes(query);
}

function matchesPackageFilePath(file: LoadedPackageFile, query: string): boolean {
  return file.label.toLowerCase().includes(query) || file.relativePath.toLowerCase().includes(query);
}

function createContentPreview(line: string): string {
  const preview = line.trim();
  return preview.length <= 160 ? preview : `${preview.slice(0, 157)}...`;
}

function buildContentMatch(text: string, query: string): LoadedPackageFileMatch | null {
  const contentIndex = text.toLowerCase().indexOf(query);
  if (contentIndex === -1) return null;
  return createContentMatchAtIndex(text, contentIndex);
}

function createContentMatchAtIndex(text: string, contentIndex: number): LoadedPackageFileMatch {
  const beforeMatch = text.slice(0, contentIndex);
  const line = beforeMatch.split(/\r?\n/u).length;
  const lineStartIndex = beforeMatch.lastIndexOf('\n') + 1;
  const lineEndIndex = text.indexOf('\n', contentIndex);
  const lineText = text.slice(lineStartIndex, lineEndIndex === -1 ? undefined : lineEndIndex).replace(/\r/u, '');

  return {
    kind: 'content',
    line,
    column: contentIndex - lineStartIndex + 1,
    preview: createContentPreview(lineText),
  };
}

function buildLocalRootSourcePath(localRoot: string, source: LoadedPackageSource): string | null {
  if (!source.path) return null;
  const nodeModulesSuffix = extractNodeModulesSuffix(normalizeSourcePath(source.path));
  if (!nodeModulesSuffix) return null;
  return join(localRoot, 'node_modules', ...nodeModulesSuffix.split('/'));
}

function getReadableSourcePathCandidates(
  index: PackageSearchIndex,
  file: LoadedPackageFile,
): string[] {
  const candidates = new Set<string>();
  const directPath = toReadableLocalSourcePath(file.source);
  if (directPath) candidates.add(directPath);
  if (index.localRoot) {
    const localRootFallback = buildLocalRootSourcePath(index.localRoot, file.source);
    if (localRootFallback) candidates.add(localRootFallback);
  }
  return Array.from(candidates);
}

async function readSourceContentFromCandidates(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      continue;
    }
  }
  return null;
}

function getCachedPackageFileContent(
  index: PackageSearchIndex,
  file: LoadedPackageFile,
): Promise<string | null> {
  const cached = index.contentCache.get(file.id);
  if (cached) return cached;

  const contentPromise = (async (): Promise<string | null> => {
    const readablePaths = getReadableSourcePathCandidates(index, file);
    if (readablePaths.length === 0) return null;
    return readSourceContentFromCandidates(readablePaths);
  })();

  index.contentCache.set(file.id, contentPromise);
  return contentPromise;
}

async function findPackageFileContentMatch(
  index: PackageSearchIndex,
  file: LoadedPackageFile,
  query: string,
): Promise<LoadedPackageFileMatch | null> {
  const content = await getCachedPackageFileContent(index, file);
  if (!content) return null;
  return buildContentMatch(content, query);
}

async function findMatchingFiles(
  index: PackageSearchIndex,
  entry: LoadedPackageEntry,
  query: string,
): Promise<Map<string, LoadedPackageFileMatch>> {
  const matches = new Map<string, LoadedPackageFileMatch>();

  await Promise.all(entry.files.map(async (file) => {
    if (matchesPackageFilePath(file, query)) {
      matches.set(file.id, { kind: 'path' });
      return;
    }

    const contentMatch = await findPackageFileContentMatch(index, file, query);
    if (contentMatch) matches.set(file.id, contentMatch);
  }));

  return matches;
}

function buildSearchResultEntry(
  entry: LoadedPackageEntry,
  fileMatches: Map<string, LoadedPackageFileMatch>,
  packageMatches: boolean,
): LoadedPackageEntry | null {
  if (!packageMatches && fileMatches.size === 0) return null;

  const files = packageMatches
    ? entry.files.map((file) => clonePackageFile(file, fileMatches.get(file.id)))
    : entry.files
      .filter((file) => fileMatches.has(file.id))
      .map((file) => clonePackageFile(file, fileMatches.get(file.id)));

  return clonePackageEntry(entry, files);
}

function describeSession(session: vscode.DebugSession): string {
  const type = session.type || 'unknown';
  return `"${session.name}" [${session.id}] type=${type}`;
}

function stampSourceSession(
  source: LoadedPackageSource,
  session: vscode.DebugSession,
): LoadedPackageSource {
  return {
    ...source,
    debugSessionId: session.id,
    debugSessionName: session.name,
  };
}

function normalizeLoadPackageEntriesOptions(
  options: LoadPackageEntriesOptions | undefined,
): Required<LoadPackageEntriesOptions> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_LOAD_PACKAGE_ENTRIES_OPTIONS.maxAttempts;
  const emptyRetryDelayMs = options?.emptyRetryDelayMs ?? DEFAULT_LOAD_PACKAGE_ENTRIES_OPTIONS.emptyRetryDelayMs;
  const loadedSourcesRequestTimeoutMs = options?.loadedSourcesRequestTimeoutMs
    ?? DEFAULT_LOAD_PACKAGE_ENTRIES_OPTIONS.loadedSourcesRequestTimeoutMs;

  return {
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0
      ? Math.floor(maxAttempts)
      : DEFAULT_LOAD_PACKAGE_ENTRIES_OPTIONS.maxAttempts,
    emptyRetryDelayMs: Number.isFinite(emptyRetryDelayMs) && emptyRetryDelayMs >= 0
      ? Math.floor(emptyRetryDelayMs)
      : DEFAULT_LOAD_PACKAGE_ENTRIES_OPTIONS.emptyRetryDelayMs,
    loadedSourcesRequestTimeoutMs: Number.isFinite(loadedSourcesRequestTimeoutMs) && loadedSourcesRequestTimeoutMs > 0
      ? Math.floor(loadedSourcesRequestTimeoutMs)
      : DEFAULT_LOAD_PACKAGE_ENTRIES_OPTIONS.loadedSourcesRequestTimeoutMs,
  };
}

function buildLoadedSourcesTimeoutMessage(
  session: vscode.DebugSession,
  timeoutMs: number,
): string {
  return `loadedSources timed out for ${describeSession(session)} after ${timeoutMs.toString()}ms.`;
}

function isLoadedSourcesTimeoutMessage(message: string): boolean {
  return message.includes('loadedSources timed out');
}

async function requestLoadedSourcesWithTimeout(
  session: vscode.DebugSession,
  timeoutMs: number,
): Promise<unknown> {
  return Promise.race([
    session.customRequest('loadedSources', {}) as Promise<unknown>,
    delay(timeoutMs).then(() => {
      throw new Error(buildLoadedSourcesTimeoutMessage(session, timeoutMs));
    }),
  ]);
}

async function requestLoadedSources(
  session: vscode.DebugSession,
  timeoutMs: number,
  log?: PackageBrowserLogFn,
): Promise<LoadedPackageSource[]> {
  const response = await requestLoadedSourcesWithTimeout(session, timeoutMs);
  const sources = getLoadedSourcesResponseSources(response)
    .map((source) => stampSourceSession(source, session));
  log?.(`[Packages] loadedSources from ${describeSession(session)} -> ${sources.length.toString()} source(s)`);
  return sources;
}

function logSessionCandidates(
  appName: string,
  sessions: readonly vscode.DebugSession[],
  log?: PackageBrowserLogFn,
): void {
  if (!log) return;
  log(`[Packages] Resolving session tree for ${appName}: ${sessions.length.toString()} candidate(s)`);
  for (const session of sessions) {
    const parentName = session.parentSession?.name ?? 'none';
    const parentId = session.parentSession?.id ?? 'none';
    log(`[Packages] Candidate ${describeSession(session)} parent="${parentName}" [${parentId}]`);
  }
}

function resolvePackageSessions(sessionSource: PackageSessionSource): vscode.DebugSession[] {
  const sessions = typeof sessionSource === 'function'
    ? sessionSource()
    : sessionSource;
  return Array.from(sessions);
}

function mergeLoadedSources(batches: readonly LoadedPackageSource[][]): LoadedPackageSource[] {
  return batches.flat();
}

function toOpenUri(
  session: vscode.DebugSession,
  source: LoadedPackageSource,
  options?: { localRoot?: string },
): vscode.Uri {
  // Prefer a `file:` URI whenever the source path ALREADY resolves to a local file on
  // disk, ahead of the `sourceReference > 0` check. Rationale:
  //
  // vscode-js-debug, when a paused frame's source path exists locally, advertises that
  // source in `stackTrace` with `sourceReference = 0` and the resolvable local path,
  // and VS Code opens it as a `file:` URI. If our Package browser uses
  // `asDebugSourceUri` instead (because `loadedSources` had a non-zero ref), the two
  // URIs differ even though they point to the same on-disk file — producing the
  // user-visible "two tabs at the same path" symptom across the
  // Package-browser-open → runtime-pause transition.
  //
  // Keep the workspace-mapped candidate string instead of resolving pnpm/workspace
  // package symlinks. The generated launch config maps remote package paths to
  // `${localRoot}/node_modules/...`; opening that same URI gives VS Code's breakpoint
  // verifier the same path identity that js-debug receives from source-map overrides.
  //
  // NOTE: we only OPEN files that already exist — CDS Debug never writes package source
  // to disk. A `.ts` that exists only as `sourcesContent` (no on-disk file) falls through
  // to the `debug:` URI below, where vscode-js-debug binds the breakpoint by
  // `sourceReference` and the pre-stop cleanup (clearBreakpointsBeforeStop) clears it.
  const localCandidates = collectLocalFileCandidates(source, options?.localRoot);
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) return vscode.Uri.file(candidate);
  }

  // No file exists on disk. Use the debug-source URI for sources that vscode-js-debug
  // serves via embedded `sourcesContent` (common for `.ts` files whose source-map-embedded
  // path differs from the actual installed pnpm hash, e.g. when the package was built
  // against one peer-dep resolution but installed against another).
  if (typeof source.sourceReference === 'number' && source.sourceReference > 0) {
    return vscode.debug.asDebugSourceUri(source, session);
  }
  if (!source.path) {
    throw new Error('Package source cannot be opened because it has no path.');
  }
  if (SOURCE_URI_PATTERN.test(source.path)) {
    return vscode.Uri.parse(source.path);
  }
  const direct = toReadableLocalSourcePath(source);
  if (direct !== null) return vscode.Uri.file(direct);
  return vscode.Uri.file(source.path);
}

function collectLocalFileCandidates(
  source: LoadedPackageSource,
  localRoot: string | undefined,
): string[] {
  const candidates: string[] = [];
  if (localRoot !== undefined) {
    for (const root of collectLocalRootCandidates(localRoot)) {
      const mapped = buildLocalRootSourcePath(root, source);
      if (mapped) pushUnique(candidates, mapped);
    }
  }
  const direct = toReadableLocalSourcePath(source);
  if (direct) pushUnique(candidates, direct);
  return candidates;
}

function collectLocalRootCandidates(localRoot: string): string[] {
  const candidates: string[] = [];
  const resolved = tryRealpath(localRoot);
  if (resolved !== null) candidates.push(resolved);
  pushUnique(candidates, localRoot);
  return candidates;
}

function tryRealpath(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
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
        tree: [],
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
    .map(({ entry }) => {
      const files = entry.files
        .slice()
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      return {
        ...entry,
        files,
        tree: buildPackageFileTree(files),
      };
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function loadPackageEntries(session: vscode.DebugSession): Promise<LoadedPackageEntry[]> {
  const options = normalizeLoadPackageEntriesOptions(undefined);
  const sources = await requestLoadedSources(session, options.loadedSourcesRequestTimeoutMs);
  return buildPackageEntries(sources);
}

export function createPackageSearchIndex(
  entries: LoadedPackageEntry[],
  options?: { localRoot?: string },
): PackageSearchIndex {
  const index: PackageSearchIndex = {
    entries: entries.map((entry) => clonePackageEntry(entry, entry.files.map((file) => clonePackageFile(file)))),
    contentCache: new Map<string, Promise<string | null>>(),
  };
  if (options?.localRoot) index.localRoot = options.localRoot;
  return index;
}

export async function searchPackageEntries(
  index: PackageSearchIndex,
  query: string,
  options?: PackageSearchOptions,
): Promise<LoadedPackageEntry[]> {
  const normalizedQuery = normalizePackageSearchQuery(query);
  const nameFilterRegex = createPackageNameFilterRegex(options?.packageNameFilterRegex);

  if (!normalizedQuery) {
    return index.entries
      .filter((entry) => !nameFilterRegex || nameFilterRegex.test(entry.name))
      .map((entry) => clonePackageEntry(entry, entry.files.map((file) => clonePackageFile(file))));
  }

  const results: LoadedPackageEntry[] = [];
  for (const entry of index.entries) {
    if (nameFilterRegex && !nameFilterRegex.test(entry.name)) continue;
    const fileMatches = await findMatchingFiles(index, entry, normalizedQuery);
    const packageMatches = matchesPackageEntryQuery(entry, normalizedQuery);
    const resultEntry = buildSearchResultEntry(entry, fileMatches, packageMatches);
    if (resultEntry) results.push(resultEntry);
  }

  return results.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export async function loadPackageEntriesFromSessions(
  appName: string,
  sessions: PackageSessionSource,
  log?: PackageBrowserLogFn,
  options?: LoadPackageEntriesOptions,
): Promise<LoadedPackageEntry[]> {
  if (Array.isArray(sessions) && sessions.length === 0) {
    throw new Error(`No active debug session found for ${appName}.`);
  }

  const resolvedOptions = normalizeLoadPackageEntriesOptions(options);
  let lastNonTimeoutError: string | null = null;
  let sawAnySessions = false;

  for (let attempt = 1; attempt <= resolvedOptions.maxAttempts; attempt += 1) {
    const currentSessions = resolvePackageSessions(sessions);
    const loadedSourceBatches: LoadedPackageSource[][] = [];
    let sawMissingSessions = false;
    let sawEmptySources = false;
    let sawTimeout = false;

    log?.(`[Packages] Attempt ${attempt.toString()}/${resolvedOptions.maxAttempts.toString()} for ${appName}.`);
    if (currentSessions.length === 0) {
      sawMissingSessions = true;
      log?.(`[Packages] No candidate debug sessions are available yet for ${appName}.`);
    } else {
      sawAnySessions = true;
      logSessionCandidates(appName, currentSessions, log);
    }

    // Iterate deepest sessions first so `buildPackageEntries`'s first-wins dedupe
    // stamps each shared file with a WORKER session URI rather than the parent
    // Remote Process URI.
    //
    // Why this matters: when VS Code sends `setBreakpoints` for a `debug:` URI tagged
    // with session=Remote Process [0], the adapter for that session looks up the source
    // by reference, translates `.ts:line N` to `.js:line M` via the source map, and
    // calls `Debugger.setBreakpoint`. But Node's main process only knows the `.js` as
    // a source-map artifact — it does not run that code itself; the actual execution
    // happens in worker threads. `Debugger.setBreakpoint` returns unverified, and the
    // user sees a GRAY breakpoint dot.
    //
    // Stamping the URI with a worker session means `setBreakpoints` goes to a session
    // whose Node inspector actually loaded the `.js`, so the binding verifies and the
    // dot turns red. The runtime pause still happens in whichever worker is free at
    // the time; if it is the same worker we stamped, the URI matches and VS Code
    // reuses the existing tab — eliminating the duplicate-tab effect entirely.
    const sessionsForCollection = [...currentSessions].reverse();
    for (const session of sessionsForCollection) {
      try {
        const sources = await requestLoadedSources(session, resolvedOptions.loadedSourcesRequestTimeoutMs, log);
        if (sources.length > 0) {
          loadedSourceBatches.push(sources);
          continue;
        }
        sawEmptySources = true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (isLoadedSourcesTimeoutMessage(message)) {
          sawTimeout = true;
        } else {
          lastNonTimeoutError = message;
        }
        log?.(`[Packages] loadedSources failed for ${describeSession(session)}: ${message}`);
      }
    }

    const sources = mergeLoadedSources(loadedSourceBatches);
    if (sources.length > 0) {
      const packages = buildPackageEntries(sources);
      const packageLabel = packages.length === 1 ? 'package entry' : 'package entries';
      log?.(`[Packages] Parsed ${packages.length.toString()} ${packageLabel} from ${sources.length.toString()} loaded source(s)`);
      if (packages.length === 0) {
        log?.('[Packages] Loaded sources exist, but none matched node_modules package paths.');
      }
      return packages;
    }

    if (sawTimeout) {
      throw new Error(`Timed out waiting for loaded sources for ${appName}.`);
    }

    if ((sawMissingSessions || sawEmptySources) && attempt < resolvedOptions.maxAttempts) {
      log?.(
        `[Packages] Package sources are not ready yet for ${appName}. Retrying in ${resolvedOptions.emptyRetryDelayMs.toString()}ms.`,
      );
      if (resolvedOptions.emptyRetryDelayMs > 0) {
        await delay(resolvedOptions.emptyRetryDelayMs);
      }
      continue;
    }
  }

  if (lastNonTimeoutError) {
    throw new Error(`Failed to load package sources for ${appName}: ${lastNonTimeoutError}`);
  }

  if (!sawAnySessions) {
    throw new Error(`No active debug session found for ${appName}.`);
  }

  throw new Error(`No loaded sources were returned by any debug session for ${appName}.`);
}

// Tracks the URIs we have opened on behalf of each app via the Package browser. The
// `clearBreakpointsBeforeStop` path uses this registry to clear breakpoints set on URIs
// that fall outside the VS Code workspace (typical for pnpm-hoisted `node_modules` —
// the package files live under the monorepo root, not inside the app's mapped folder),
// which the existing workspace filter would otherwise silently skip.
const openedPackageUrisByApp = new Map<string, Map<string, OpenedPackageSourceRecord>>();

export function trackOpenedPackageUri(
  appName: string,
  uri: vscode.Uri,
  source?: LoadedPackageSource,
  session?: vscode.DebugSession,
): void {
  let registry = openedPackageUrisByApp.get(appName);
  if (registry === undefined) {
    registry = new Map();
    openedPackageUrisByApp.set(appName, registry);
  }
  const existing = registry.get(uri.toString());
  registry.set(uri.toString(), createOpenedPackageSourceRecord(appName, uri, source, session, existing));
}

export function getOpenedPackageUris(appName: string): vscode.Uri[] {
  const registry = openedPackageUrisByApp.get(appName);
  return registry ? Array.from(registry.values()).map((record) => record.uri) : [];
}

export function clearOpenedPackageUris(appName: string): void {
  openedPackageUrisByApp.delete(appName);
}

function createOpenedPackageSourceRecord(
  appName: string,
  uri: vscode.Uri,
  source: LoadedPackageSource | undefined,
  session: vscode.DebugSession | undefined,
  existing: OpenedPackageSourceRecord | undefined,
): OpenedPackageSourceRecord {
  const record: OpenedPackageSourceRecord = { appName, uri };
  const sourceToStore = source ?? existing?.source;
  const sessionId = session?.id ?? existing?.sessionId;
  const sessionName = session?.name ?? existing?.sessionName;
  if (sourceToStore !== undefined) record.source = { ...sourceToStore };
  if (sessionId !== undefined) record.sessionId = sessionId;
  if (sessionName !== undefined) record.sessionName = sessionName;
  return record;
}

function cloneOpenedPackageSourceRecord(record: OpenedPackageSourceRecord): OpenedPackageSourceRecord {
  const clone: OpenedPackageSourceRecord = {
    appName: record.appName,
    uri: record.uri,
  };
  if (record.source !== undefined) clone.source = { ...record.source };
  if (record.sessionId !== undefined) clone.sessionId = record.sessionId;
  if (record.sessionName !== undefined) clone.sessionName = record.sessionName;
  return clone;
}

// Reverse lookup: given a URI's `.path` (the decoded URL path component, which equals
// the remote file path for `debug:` URIs and the local file path for `file:` URIs),
// return the app whose Package browser opened a URI with the same path. Allows external
// modules (e.g. the breakpoint mirror) to find the right session set without needing
// the URI's session-id query — the path is the stable cross-session identifier.
export function findAppForOpenedPath(path: string): string | undefined {
  for (const [appName, registry] of openedPackageUrisByApp) {
    for (const record of registry.values()) {
      if (record.uri.path === path) return appName;
    }
  }
  return undefined;
}

export function findOpenedPackageSourceByUri(uri: vscode.Uri): OpenedPackageSourceRecord | undefined {
  const uriString = uri.toString();
  for (const registry of openedPackageUrisByApp.values()) {
    const exact = registry.get(uriString);
    if (exact !== undefined) return cloneOpenedPackageSourceRecord(exact);
  }
  for (const registry of openedPackageUrisByApp.values()) {
    for (const record of registry.values()) {
      if (record.uri.path === uri.path) return cloneOpenedPackageSourceRecord(record);
    }
  }
  return undefined;
}

// Drop a single tracked URI by its `toString()` form. Used by TabDedupe's prune step
// to evict URIs whose tagged debug session has ended (otherwise they would be picked
// as "canonical" on the next debug run, redirecting the user onto a dead-session
// editor that VS Code cannot load content for — silent margin-dot regressions).
export function unregisterOpenedPackageUri(appName: string, uri: vscode.Uri): void {
  const registry = openedPackageUrisByApp.get(appName);
  if (registry === undefined) return;
  registry.delete(uri.toString());
  if (registry.size === 0) openedPackageUrisByApp.delete(appName);
}

// Extracts the `session=<id>` parameter from a `debug:` URI's query string.
// `vscode.debug.asDebugSourceUri` percent-encodes the entire `session=<id>&ref=<n>`
// substring (delimiters `=` and `&` themselves become `%3D` and `%26`), so the raw
// `uri.query` reads back as `session%3D...%26ref%3D...`. We must decode first before
// splitting; a naive `URLSearchParams(uri.query)` would treat the whole blob as one
// key with no value and silently return `null`.
export function extractSessionIdFromDebugUri(uri: vscode.Uri): string | null {
  const raw = uri.query;
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const queryString = decoded.includes('=') || decoded.includes('&') ? decoded : raw;
  for (const pair of queryString.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    if (key === 'session') {
      try {
        return decodeURIComponent(pair.slice(eq + 1));
      } catch {
        return pair.slice(eq + 1);
      }
    }
  }
  return null;
}

export async function openPackageSource(
  session: vscode.DebugSession,
  source: LoadedPackageSource,
  location?: PackageSourceLocation,
  options?: { localRoot?: string; appName?: string },
): Promise<vscode.Uri> {
  const uri = toOpenUri(session, source, options);
  logInfo(
    `[PackageBrowser] open scheme=${uri.scheme} path=${uri.path} fsPath=${uri.fsPath} query=${uri.query || '<none>'} sourceRef=${(source.sourceReference ?? 0).toString()} session=${session.id} toString=${uri.toString()}`,
  );
  if (options?.appName !== undefined) {
    trackOpenedPackageUri(options.appName, uri, source, session);
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const selection = location
    ? new vscode.Range(
      new vscode.Position(Math.max(0, location.line - 1), Math.max(0, (location.column ?? 1) - 1)),
      new vscode.Position(Math.max(0, location.line - 1), Math.max(0, (location.column ?? 1) - 1)),
    )
    : undefined;
  const showOptions: vscode.TextDocumentShowOptions = {
    preview: true,
  };
  if (selection) showOptions.selection = selection;
  const editor = await vscode.window.showTextDocument(document, showOptions);
  if (selection) {
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
  return uri;
}
