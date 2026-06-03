import * as vscode from 'vscode';
import { getDebugSessionsForApp } from './debugSessionRegistry';
import { logInfo, logWarn } from './logger';
import {
  findOpenedPackageSourceByUri,
  trackOpenedPackageUri,
  type OpenedPackageSourceRecord,
} from './packageSourceBrowser';
import type { LoadedPackageSource } from '../types/index';

// Background:
//
// When the Package browser opens a `.ts` source served by vscode-js-debug, the URI is
// produced by `vscode.debug.asDebugSourceUri(source, session)`. For sources with a
// non-zero `sourceReference` (the common case for source-mapped files served from
// `sourcesContent`), the URI shape is `debug:<encoded-path>?session=<id>&ref=<n>`.
// Both the session id and the source reference are session-scoped — the SAME logical
// `.ts` file loaded in parent + child + worker sessions has different references in
// each session.
//
// VS Code only sends `setBreakpoints` to the session embedded in the URI's query when
// the user clicks the margin of a `debug:` URI editor. Children of that session do
// inherit breakpoints through vscode-js-debug's internal session manager, but the
// inheritance is best-effort and does not guarantee that every sibling worker thread
// receives a precisely-targeted binding. With CAP topologies that spawn many worker
// threads (Remote Process + N WorkerThreads), the breakpoint frequently fails to
// fire in the worker that actually executes the code — even though the runtime
// physically loaded the same source under a different reference.
//
// This module closes that gap. Whenever the user adds, removes, or edits a breakpoint
// on a URI opened via the Package browser, we query every app session's `loadedSources`
// to find that session's OWN `sourceReference` for the same file path, then issue a
// targeted `setBreakpoints` request to each session with its own descriptor and the
// current breakpoint set. Result: the breakpoint is bound everywhere the source lives,
// regardless of which worker the runtime ultimately picks.

interface DapSourceListResponse {
  sources?: { path?: unknown; sourceReference?: unknown }[];
}

interface DapSetBreakpointsResponse {
  breakpoints?: { verified?: unknown }[];
}

interface DapSourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

interface DapSourceDescriptor {
  path: string;
  sourceReference?: number;
}

interface AffectedPackageSource {
  appName: string;
  uri: vscode.Uri;
  sourcePath: string;
  sourceName?: string;
  sourceReference?: number;
  sourceSessionId?: string;
}

interface MirrorTargetResult {
  session: vscode.DebugSession;
  descriptor: DapSourceDescriptor;
  verified: boolean;
}

const MIRROR_REQUEST_TIMEOUT_MS = 1_500;
const MIGRATION_GUARD_MS = 500;
const SOURCE_URI_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

let listener: vscode.Disposable | undefined;
const inFlightByKey = new Map<string, Promise<void>>();
const migrationGuardUris = new Set<string>();
// Tracks which (verifying session, source, line) breakpoints we have already nudged VS Code
// to re-verify on a `debug:` URI, so the remove+add poke fires at most once per breakpoint
// per session — no repeated flicker. See `nudgeDebugUriBreakpointsForUiVerificationOnce`.
const uiVerifiedKeys = new Set<string>();

export function initializePackageBreakpointMirror(): void {
  if (listener !== undefined) return;
  listener = vscode.debug.onDidChangeBreakpoints((event) => {
    void handleBreakpointChange(event);
  });
}

export function disposePackageBreakpointMirror(): void {
  listener?.dispose();
  listener = undefined;
  inFlightByKey.clear();
  migrationGuardUris.clear();
  uiVerifiedKeys.clear();
}

async function handleBreakpointChange(event: vscode.BreakpointsChangeEvent): Promise<void> {
  const affected = collectAffectedPackageSources(event);
  if (affected.size === 0) return;

  logInfo(`[BPMirror] event added=${event.added.length.toString()} removed=${event.removed.length.toString()} changed=${event.changed.length.toString()} affected=${affected.size.toString()}`);
  const tasks: Promise<void>[] = [];
  for (const source of affected.values()) {
    const key = `${source.appName}::${source.sourcePath}`;
    // Serialize mirror operations per logical source — a fast add+remove burst would
    // otherwise race and leave the adapter with a stale breakpoint set.
    const previous = inFlightByKey.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => mirrorBreakpointsForSource(source));
    inFlightByKey.set(key, next);
    tasks.push(next.finally(() => {
      if (inFlightByKey.get(key) === next) inFlightByKey.delete(key);
    }));
  }
  await Promise.allSettled(tasks);
}

function collectAffectedPackageSources(event: vscode.BreakpointsChangeEvent): Map<string, AffectedPackageSource> {
  const result = new Map<string, AffectedPackageSource>();
  const consider = (bp: vscode.Breakpoint): void => {
    if (!(bp instanceof vscode.SourceBreakpoint)) return;
    const uri = bp.location.uri;
    if (migrationGuardUris.has(uri.toString())) return;
    const source = toAffectedPackageSource(uri);
    if (source === undefined) return;
    result.set(`${source.appName}::${source.sourcePath}::${source.uri.toString()}`, source);
  };
  event.added.forEach(consider);
  event.removed.forEach(consider);
  event.changed.forEach(consider);
  return result;
}

function toAffectedPackageSource(uri: vscode.Uri): AffectedPackageSource | undefined {
  const record = findOpenedPackageSourceByUri(uri);
  if (record === undefined) return undefined;
  const sourcePath = record.source?.path ?? uri.path;
  if (!sourcePath) return undefined;
  return buildAffectedPackageSource(record, uri, sourcePath);
}

function buildAffectedPackageSource(
  record: OpenedPackageSourceRecord,
  uri: vscode.Uri,
  sourcePath: string,
): AffectedPackageSource {
  const affected: AffectedPackageSource = {
    appName: record.appName,
    uri,
    sourcePath,
  };
  if (record.source?.name !== undefined) affected.sourceName = record.source.name;
  if (record.source?.sourceReference !== undefined) affected.sourceReference = record.source.sourceReference;
  if (record.sessionId !== undefined) affected.sourceSessionId = record.sessionId;
  return affected;
}

async function mirrorBreakpointsForSource(source: AffectedPackageSource): Promise<void> {
  const startedAt = Date.now();
  const sessions = getDebugSessionsForApp(source.appName);
  if (sessions.length === 0) return;

  const desired = collectDesiredBreakpoints(source);
  logInfo(`[BPMirror ${source.appName}] mirror start sessions=${sessions.length.toString()} desired=${desired.length.toString()} uriScheme=${source.uri.scheme} sourceRef=${String(source.sourceReference ?? 0)} path=${source.sourcePath}`);
  logInfo(`[BPMirror ${source.appName}] mirror sessions ${sessions.map(describeSession).join(' | ')}`);
  const results = await Promise.all(sessions.map((session) =>
    mirrorBreakpointsToSession(session, source, desired)));
  promoteBreakpointToVerifiedUri(source, results);
  logInfo(`[BPMirror ${source.appName}] mirror done sessions=${sessions.length.toString()} desired=${desired.length.toString()} verifiedSessions=${countVerifiedResults(results).toString()} duration=${elapsedMs(startedAt)} path=${source.sourcePath}`);
}

async function mirrorBreakpointsToSession(
  session: vscode.DebugSession,
  source: AffectedPackageSource,
  desired: DapSourceBreakpoint[],
): Promise<MirrorTargetResult | null> {
  const sourceRef = await lookupSourceReferenceForPath(session, source.sourcePath, source.appName);
  const descriptor = buildSourceDescriptor(session, source, sourceRef);
  if (descriptor === null) {
    logInfo(`[BPMirror ${source.appName}] session=${session.id} skipped no source descriptor path=${source.sourcePath}`);
    return null;
  }
  const startedAt = Date.now();
  try {
    const response = await session.customRequest('setBreakpoints', {
      source: descriptor,
      breakpoints: desired,
      sourceModified: false,
    }) as DapSetBreakpointsResponse | undefined;
    const verifiedCount = countVerifiedBreakpoints(response);
    const verified = verifiedCount > 0;
    logInfo(`[BPMirror ${source.appName}] session=${session.id} setBreakpoints count=${desired.length.toString()} verified=${verified.toString()} verifiedCount=${verifiedCount.toString()} returned=${countReturnedBreakpoints(response).toString()} ref=${String(descriptor.sourceReference ?? 0)} duration=${elapsedMs(startedAt)} path=${source.sourcePath}`);
    return { session, descriptor, verified };
  } catch (err: unknown) {
    logWarn(`[BPMirror ${source.appName}] session=${session.id} setBreakpoints failed duration=${elapsedMs(startedAt)} path=${source.sourcePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function buildSourceDescriptor(
  session: vscode.DebugSession,
  source: AffectedPackageSource,
  sourceRef: number | null,
): DapSourceDescriptor | null {
  const fallbackRef = session.id === source.sourceSessionId ? source.sourceReference : undefined;
  const refForSession = sourceRef ?? fallbackRef;
  if (refForSession === undefined) return null;
  const descriptor: DapSourceDescriptor = { path: source.sourcePath };
  if (refForSession > 0) descriptor.sourceReference = refForSession;
  return descriptor;
}

function collectDesiredBreakpoints(source: AffectedPackageSource): DapSourceBreakpoint[] {
  const result: DapSourceBreakpoint[] = [];
  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!breakpoint.enabled) continue;
    if (!breakpointMatchesSource(breakpoint, source)) continue;
    const descriptor: DapSourceBreakpoint = {
      line: breakpoint.location.range.start.line + 1,
      column: breakpoint.location.range.start.character + 1,
    };
    if (breakpoint.condition !== undefined && breakpoint.condition.length > 0) {
      descriptor.condition = breakpoint.condition;
    }
    if (breakpoint.hitCondition !== undefined && breakpoint.hitCondition.length > 0) {
      descriptor.hitCondition = breakpoint.hitCondition;
    }
    if (breakpoint.logMessage !== undefined && breakpoint.logMessage.length > 0) {
      descriptor.logMessage = breakpoint.logMessage;
    }
    result.push(descriptor);
  }
  return result;
}

function breakpointMatchesSource(
  breakpoint: vscode.SourceBreakpoint,
  source: AffectedPackageSource,
): boolean {
  if (breakpoint.location.uri.toString() === source.uri.toString()) return true;
  const record = findOpenedPackageSourceByUri(breakpoint.location.uri);
  if (record?.appName !== source.appName) return false;
  return (record.source?.path ?? breakpoint.location.uri.path) === source.sourcePath;
}

function countVerifiedBreakpoints(response: DapSetBreakpointsResponse | undefined): number {
  const breakpoints = response?.breakpoints;
  if (!Array.isArray(breakpoints)) return 0;
  return breakpoints.filter((breakpoint) => breakpoint.verified === true).length;
}

function countReturnedBreakpoints(response: DapSetBreakpointsResponse | undefined): number {
  const breakpoints = response?.breakpoints;
  return Array.isArray(breakpoints) ? breakpoints.length : 0;
}

function promoteBreakpointToVerifiedUri(
  source: AffectedPackageSource,
  results: readonly (MirrorTargetResult | null)[],
): void {
  const startedAt = Date.now();
  const target = findPromotionTarget(source, results);
  if (target === null) {
    logInfo(`[BPMirror ${source.appName}] promotion target=none verifiedSessions=${countVerifiedResults(results).toString()} duration=${elapsedMs(startedAt)} path=${source.sourcePath}`);
    return;
  }
  const targetUri = buildVerifiedSourceUri(source, target);
  logInfo(`[BPMirror ${source.appName}] promotion target=${target.session.id} targetScheme=${targetUri.scheme} sameUri=${(targetUri.toString() === source.uri.toString()).toString()} ref=${String(target.descriptor.sourceReference ?? 0)} verifiedSessions=${countVerifiedResults(results).toString()} duration=${elapsedMs(startedAt)} path=${source.sourcePath}`);
  if (targetUri.toString() === source.uri.toString()) {
    if (source.uri.scheme === 'file') {
      refreshVerifiedBreakpointsOnSameUri(source, targetUri);
    } else {
      nudgeDebugUriBreakpointsForUiVerificationOnce(source, target);
    }
    return;
  }
  const breakpointsToMigrate = collectBreakpointsForMigration(source, targetUri);
  if (breakpointsToMigrate.length === 0) return;
  const replacements = breakpointsToMigrate.map((bp) => new vscode.SourceBreakpoint(
    new vscode.Location(targetUri, bp.location.range),
    bp.enabled,
    bp.condition,
    bp.hitCondition,
    bp.logMessage,
  ));
  runWithMigrationGuard([source.uri, targetUri], () => {
    trackOpenedPackageUri(source.appName, targetUri, toLoadedPackageSource(source, target), target.session);
    vscode.debug.addBreakpoints(replacements);
    vscode.debug.removeBreakpoints(breakpointsToMigrate);
  });
  void focusVerifiedUri(source.appName, targetUri);
}

function refreshVerifiedBreakpointsOnSameUri(source: AffectedPackageSource, uri: vscode.Uri): void {
  if (source.uri.scheme !== 'file' || (source.sourceReference ?? 0) > 0) return;
  const breakpointsToRefresh = collectBreakpointsForRefresh(source);
  if (breakpointsToRefresh.length === 0) return;
  const startedAt = Date.now();
  const replacements = breakpointsToRefresh.map((bp) => new vscode.SourceBreakpoint(
    new vscode.Location(uri, bp.location.range),
    bp.enabled,
    bp.condition,
    bp.hitCondition,
    bp.logMessage,
  ));
  runWithMigrationGuard([uri], () => {
    vscode.debug.removeBreakpoints(breakpointsToRefresh);
    vscode.debug.addBreakpoints(replacements);
  });
  logInfo(`[BPMirror ${source.appName}] refreshed ${breakpointsToRefresh.length.toString()} verified file breakpoint(s) uriScheme=${uri.scheme} duration=${elapsedMs(startedAt)} path=${source.sourcePath}`);
}

// VS Code only flips a breakpoint's gutter to "verified" (red) from its OWN setBreakpoints
// round-trips; the mirror binds via `customRequest`, which the gutter ignores. For `debug:`
// URIs — package sources opened from the Package Browser when the `.ts` is not on disk —
// there is no local file to anchor to, so the breakpoint stays gray even though it is bound
// (execution pauses). Nudge VS Code to re-send its own setBreakpoints by removing and
// re-adding the breakpoint on the same `debug:` URI. Gated to once per (verifying session,
// source, line) so it cannot flicker on repeated breakpoint-change events.
function nudgeDebugUriBreakpointsForUiVerificationOnce(
  source: AffectedPackageSource,
  target: MirrorTargetResult,
): void {
  const startedAt = Date.now();
  const toRefresh = vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint => {
    if (!(bp instanceof vscode.SourceBreakpoint)) return false;
    if (!breakpointMatchesSource(bp, source)) return false;
    const { start } = bp.location.range;
    const key = `${target.session.id}::${source.sourcePath}::${start.line.toString()}:${start.character.toString()}`;
    if (uiVerifiedKeys.has(key)) return false;
    uiVerifiedKeys.add(key);
    return true;
  });
  if (toRefresh.length === 0) return;
  const replacements = toRefresh.map((bp) => new vscode.SourceBreakpoint(
    new vscode.Location(source.uri, bp.location.range),
    bp.enabled,
    bp.condition,
    bp.hitCondition,
    bp.logMessage,
  ));
  runWithMigrationGuard([source.uri], () => {
    vscode.debug.removeBreakpoints(toRefresh);
    vscode.debug.addBreakpoints(replacements);
  });
  logInfo(`[BPMirror ${source.appName}] UI re-verify nudge: re-added ${toRefresh.length.toString()} breakpoint(s) uriScheme=${source.uri.scheme} duration=${elapsedMs(startedAt)} path=${source.sourcePath}`);
}

function findPromotionTarget(
  source: AffectedPackageSource,
  results: readonly (MirrorTargetResult | null)[],
): MirrorTargetResult | null {
  if (isMaterializedFileSource(source)) return null;
  const verified = results.filter((result): result is MirrorTargetResult =>
    result?.verified === true);
  if (verified.length === 0) return null;
  const referenced = verified.find((result) => (result.descriptor.sourceReference ?? 0) > 0) ?? null;
  if (source.uri.scheme !== 'file') {
    return referenced;
  }
  if (referenced !== null) return referenced;
  if (isUriLikeSourcePath(source.sourcePath)) return verified.at(-1) ?? null;
  return verified.at(-1) ?? null;
}

function isMaterializedFileSource(source: AffectedPackageSource): boolean {
  return source.uri.scheme === 'file' && (source.sourceReference ?? 0) > 0;
}

function isUriLikeSourcePath(path: string): boolean {
  return SOURCE_URI_PATTERN.test(path);
}

function buildVerifiedSourceUri(source: AffectedPackageSource, target: MirrorTargetResult): vscode.Uri {
  if ((target.descriptor.sourceReference ?? 0) <= 0 && isUriLikeSourcePath(source.sourcePath)) {
    if (source.uri.scheme === 'file') return source.uri;
    return vscode.Uri.parse(source.sourcePath);
  }
  return vscode.debug.asDebugSourceUri(toLoadedPackageSource(source, target), target.session);
}

function toLoadedPackageSource(source: AffectedPackageSource, target: MirrorTargetResult): LoadedPackageSource {
  const loadedSource: LoadedPackageSource = { path: source.sourcePath };
  if (source.sourceName !== undefined) loadedSource.name = source.sourceName;
  if (target.descriptor.sourceReference !== undefined) {
    loadedSource.sourceReference = target.descriptor.sourceReference;
  }
  return loadedSource;
}

function collectBreakpointsForMigration(
  source: AffectedPackageSource,
  targetUri: vscode.Uri,
): vscode.SourceBreakpoint[] {
  return vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint =>
    bp instanceof vscode.SourceBreakpoint
    && bp.location.uri.toString() !== targetUri.toString()
    && breakpointMatchesSource(bp, source));
}

function collectBreakpointsForRefresh(source: AffectedPackageSource): vscode.SourceBreakpoint[] {
  return vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint =>
    bp instanceof vscode.SourceBreakpoint && breakpointMatchesSource(bp, source));
}

function countVerifiedResults(results: readonly (MirrorTargetResult | null)[]): number {
  return results.filter((result) => result?.verified === true).length;
}

function runWithMigrationGuard(uris: readonly vscode.Uri[], migrate: () => void): void {
  for (const uri of uris) migrationGuardUris.add(uri.toString());
  migrate();
  setTimeout(() => {
    for (const uri of uris) migrationGuardUris.delete(uri.toString());
  }, MIGRATION_GUARD_MS);
}

async function focusVerifiedUri(appName: string, uri: vscode.Uri): Promise<void> {
  try {
    await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: false });
  } catch (err: unknown) {
    logWarn(`[BPMirror ${appName}] verified URI focus failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function lookupSourceReferenceForPath(
  session: vscode.DebugSession,
  path: string,
  appName: string,
): Promise<number | null> {
  const startedAt = Date.now();
  try {
    const response = await withTimeout(
      Promise.resolve(session.customRequest('loadedSources', {})) as Promise<DapSourceListResponse | undefined>,
      MIRROR_REQUEST_TIMEOUT_MS,
      undefined,
    );
    const sources = response?.sources;
    if (!Array.isArray(sources)) {
      logInfo(`[BPMirror ${appName}] lookup session=${session.id} matched=false sources=invalid duration=${elapsedMs(startedAt)} path=${path}`);
      return null;
    }
    for (const source of sources) {
      if (typeof source.path !== 'string' || source.path !== path) continue;
      const ref = typeof source.sourceReference === 'number' ? source.sourceReference : 0;
      // Return 0 explicitly when the source exists but is path-only — the caller still
      // wants to send the clear with `path` alone.
      logInfo(`[BPMirror ${appName}] lookup session=${session.id} matched=true ref=${ref.toString()} sources=${sources.length.toString()} duration=${elapsedMs(startedAt)} path=${path}`);
      return ref;
    }
    logInfo(`[BPMirror ${appName}] lookup session=${session.id} matched=false sources=${sources.length.toString()} duration=${elapsedMs(startedAt)} path=${path}`);
    return null;
  } catch {
    logWarn(`[BPMirror ${appName}] lookup session=${session.id} failed duration=${elapsedMs(startedAt)} path=${path}`);
    return null;
  }
}

function describeSession(session: vscode.DebugSession): string {
  return `${session.name}=${session.id}`;
}

function elapsedMs(startedAt: number): string {
  return `${(Date.now() - startedAt).toString()}ms`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(fallback);
    });
  });
}
