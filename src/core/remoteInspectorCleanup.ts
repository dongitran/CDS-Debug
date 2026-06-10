import * as vscode from 'vscode';
import { relative } from 'node:path';
import { cfRestartApp } from './cfClient';
import { scanForDebuggerLiterals, type DebuggerLiteralMatch } from './debuggerLiteralScanner';
import { getDebugSessionsForApp } from './debugSessionRegistry';
import { logError, logInfo, logWarn, showLogChannel } from './logger';
import { incrementLocalTelemetryCounter } from './localTelemetry';
import {
  clearOpenedPackageUris,
  findOpenedPackageSourceByUri,
  getOpenedPackageUris,
} from './packageSourceBrowser';
import { getRemoteInspectorCleanupSettings } from './remoteInspectorSettings';

const RESTART_ACTION = 'Restart App';
const DISABLE_ACTION = "Don't show again";
const OPEN_FIRST_MATCH_ACTION = 'Open First Match';
const SHOW_ALL_ACTION = 'Show All';
const IGNORE_SESSION_ACTION = 'Ignore for Session';
const REMOTE_INSPECTOR_REMINDER_DEBOUNCE_MS = 60_000;
// Sized for slow CF regions (ap10/jp10): a setBreakpoints round-trip through the cf ssh
// tunnel can exceed 500 ms there, and a clear that times out leaves the remote inspector
// holding the breakpoint until `cf restart` — the exact bug this pass exists to prevent.
// Requests run in parallel, so the total cap (not request × count) bounds Stop latency,
// and both only bite when the tunnel is half-open; healthy adapters answer in tens of ms.
const CLEAR_BREAKPOINT_REQUEST_TIMEOUT_MS = 1_500;
const CLEAR_BREAKPOINT_TOTAL_TIMEOUT_MS = 4_000;
const MAX_LOGGED_DEBUGGER_MATCHES = 20;

const lastReminderByApp = new Map<string, number>();
const debuggerWarningsByLifecycle = new Set<string>();

export async function handleRemoteInspectorAfterStop(appName: string): Promise<void> {
  const settings = getRemoteInspectorCleanupSettings();
  // Node cannot close an inspector listener from outside the process.
  if (settings.autoRestartAppAfterStop) {
    await restartAppAfterStop(appName);
    return;
  }
  await notifyRemoteInspectorStillOpen(appName);
}

export async function notifyRemoteInspectorStillOpen(appName: string): Promise<void> {
  const settings = getRemoteInspectorCleanupSettings();
  if (!settings.warnRemoteInspectorAfterStop) return;
  if (isReminderDebounced(appName)) return;

  lastReminderByApp.set(appName, Date.now());
  const choice = await vscode.window.showInformationMessage(
    `CDS Debug: Node inspector for ${appName} may remain open in Cloud Foundry until the app restarts.`,
    RESTART_ACTION,
    DISABLE_ACTION,
  );
  void incrementLocalTelemetryCounter('remoteInspectorReminderShown');
  logInfo(`[${appName}] Remote inspector reminder shown. Action: ${choice ?? 'dismissed'}.`);

  if (choice === RESTART_ACTION) {
    void incrementLocalTelemetryCounter('remoteInspectorRestartClicked');
    await restartAppAfterStop(appName);
    return;
  }
  if (choice === DISABLE_ACTION) {
    await vscode.workspace
      .getConfiguration('cdsDebug')
      .update('warnRemoteInspectorAfterStop', false, vscode.ConfigurationTarget.Global);
  }
}

export async function restartAppAfterStop(appName: string): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CDS Debug: restarting ${appName} to close the Node inspector...`,
      },
      async () => {
        await cfRestartApp(appName);
      },
    );
    logInfo(`[${appName}] App restarted after debug stop to close the remote inspector.`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`[${appName}] Failed to restart app after debug stop: ${message}`);
    await vscode.window.showWarningMessage(`CDS Debug: failed to restart ${appName}. Check the output channel for details.`);
  }
}

export async function clearBreakpointsBeforeStop(
  appName: string,
  session: vscode.DebugSession | undefined,
): Promise<void> {
  if (!getRemoteInspectorCleanupSettings().clearRemoteBreakpointsBeforeStop) return;

  // `session` may be undefined on the external-stop path (VS Code's red square): the
  // root session is already untracked by the time the terminate event reaches us, but
  // child sessions often survive a beat longer and can still accept the clear. Fall
  // back to whatever the registry still tracks; with nothing left, degrade to pure
  // VS Code-state cleanup of the now-dead Package-browser breakpoints.
  const appSessions = collectAppSessions(appName, session);
  if (appSessions.length === 0) {
    removeDeadPackageUriBreakpoints(appName);
    return;
  }

  // Three breakpoint categories require different clear strategies:
  //
  // 1. Workspace `file://` paths — the user set the breakpoint on a local file. vscode-js-debug
  //    matches by path; sending `setBreakpoints({source:{path}, breakpoints:[]})` to the root
  //    session clears across the whole adapter (children share the source registry).
  //
  // 2. `debug:` URIs from `vscode.debug.asDebugSourceUri` — opened via Package browser when the
  //    `.ts` file does not exist locally. The URI carries both `?session=<id>` and `?ref=<n>`.
  //    VS Code sent the original `setBreakpoints` with **both** `source.path` AND
  //    `source.sourceReference`; per DAP spec the adapter binds by `sourceReference` when it
  //    is non-zero, so a path-only clear DOES NOT MATCH and the breakpoint persists in the
  //    Node inspector — exactly the bug the user reported requiring `cf restart`.
  //    We must mirror the original descriptor: `{path, sourceReference}` for the tagged
  //    session, and a path-only fallback for sibling sessions where the same source may
  //    have been propagated by `autoAttachChildProcesses`.
  //
  // 3. Package-browser `file:` URIs (materialized `.ts` under node_modules) — VS Code binds
  //    by the local fsPath, but the breakpoint mirror additionally binds the inspector by
  //    the ORIGINAL source path + per-session `sourceReference`. A path-only fsPath clear
  //    misses those copies, so we run the mirror-bound paths through the same ref-aware
  //    broadcast as category 2 (but keep the breakpoint in VS Code state — the file exists).
  //
  // 4. Anything else (rare) — best-effort clear by URI path.
  const sessions = appSessions;
  const primarySession = session ?? sessions[0];
  const appSessionIds = new Set(sessions.map((s) => s.id));
  const workspacePaths = new Set<string>();
  const debugBreakpoints: DebugUriBreakpointRecord[] = [];
  // Logical source paths the breakpoint mirror may have bound for Package-browser `file:`
  // URIs (materialized `.ts` under node_modules). VS Code binds these by the local fsPath,
  // but the mirror ALSO binds them in the Node inspector keyed by the ORIGINAL remote
  // source path + a session-scoped sourceReference. Those ref-bound copies survive a
  // path-only fsPath clear, so we collect every path the mirror may have used and run them
  // through the same ref-aware broadcast as `debug:` URIs.
  const trackedFilePackagePaths = new Set<string>();

  // Pre-build the set of URI string forms that the Package browser opened for this app.
  // Any breakpoint on one of these URIs must be cleared on Stop regardless of whether the
  // URI's path falls inside the VS Code workspace, because pnpm-hoisted node_modules
  // typically live at the monorepo root (outside the app's mapped folder) and the legacy
  // `isInsideWorkspace` filter would silently drop them — leaving the Node inspector with
  // a permanent breakpoint until `cf restart`.
  const trackedPackageUriStrings = new Set(
    getOpenedPackageUris(appName).map((uri) => uri.toString()),
  );

  for (const breakpoint of vscode.debug.breakpoints) {
    if (!(breakpoint instanceof vscode.SourceBreakpoint)) continue;
    if (!breakpoint.enabled) continue;
    const uri = breakpoint.location.uri;
    const isTrackedPackageUri = trackedPackageUriStrings.has(uri.toString());

    if (uri.scheme === 'file') {
      if (isTrackedPackageUri) {
        // Package-browser `file:` URI (e.g. a materialized `.ts`). Route every path the
        // mirror may have bound through the ref-aware broadcast below; do NOT add it to
        // VS Code's orphan-removal set because the local file still exists and the
        // breakpoint stays valid for the next session.
        for (const candidate of collectMirrorBoundPaths(uri)) trackedFilePackagePaths.add(candidate);
        continue;
      }
      // Workspace files use path-based binding via vscode-js-debug's source registry.
      if (isInsideWorkspace(uri.fsPath)) workspacePaths.add(uri.fsPath);
      continue;
    }

    const taggedSessionId = extractDebugUriSessionId(uri);
    // Ignore breakpoints tagged with sessions we do not own — clearing third-party state as
    // a side effect of stopping a CDS Debug session would surprise users. Tracked Package
    // URIs are always considered owned, even when the URI lacks a `session=<id>` query.
    if (!isTrackedPackageUri && taggedSessionId !== null && !appSessionIds.has(taggedSessionId)) continue;

    debugBreakpoints.push({
      breakpoint,
      // For non-file URIs `uri.path` is the canonical URL path (forward-slash). `fsPath` may
      // mangle separators on Windows, so prefer `path` when available.
      remotePath: uri.path && uri.path.length > 0 ? uri.path : uri.fsPath,
      sourceReference: extractDebugUriSourceReference(uri),
      taggedSessionId,
      scheme: uri.scheme,
    });
  }

  logBreakpointCleanupSummary(appName, sessions, workspacePaths, debugBreakpoints);
  if (trackedFilePackagePaths.size > 0) {
    logInfo(`[BreakpointCleanup ${appName}] trackedFilePackagePaths=${trackedFilePackagePaths.size.toString()} paths: ${[...trackedFilePackagePaths].join(', ')}`);
  }
  logInfo(`[BreakpointCleanup ${appName}] session ids: ${sessions.map((s) => `${s.name}=${s.id}`).join(' | ')}`);

  const requests: Promise<boolean>[] = [];

  if (primarySession !== undefined) {
    for (const path of [...workspacePaths].sort()) {
      requests.push(clearBreakpointsForSourceDescriptor(primarySession, { path }));
    }
  }

  // Reverse-lookup: each session has its own `sourceReference` number for the same
  // logical source. vscode-js-debug binds the breakpoint by the sourceReference VS Code
  // sent at set-time, and a clear sent with only `path` (or with a sibling session's
  // sourceReference) silently misses. Pre-query every session's loadedSources to build a
  // `path → sourceReference` map per session, so the clear request we send to each
  // session uses that session's OWN sourceReference for the same file. Skip the query
  // entirely when there are no debug-URI breakpoints — only those bound by reference
  // need session-specific descriptors.
  const needsSessionSourceMaps = debugBreakpoints.length > 0 || trackedFilePackagePaths.size > 0;
  const sessionSourceMaps = needsSessionSourceMaps
    ? await loadSessionSourceMaps(sessions)
    : new Map<string, Map<string, number>>();
  if (debugBreakpoints.length > 0) {
    for (const target of sessions) {
      const map = sessionSourceMaps.get(target.id);
      const sample: string[] = [];
      if (map) {
        for (const record of debugBreakpoints) {
          if (!record.remotePath) continue;
          const ref = map.get(record.remotePath);
          sample.push(`${record.remotePath}→${ref === undefined ? 'NOT_FOUND' : ref.toString()}`);
        }
      }
      logInfo(`[BreakpointCleanup ${appName}] session=${target.id} loadedSources size=${(map?.size ?? 0).toString()} matched: ${sample.join(', ') || '<none>'}`);
    }
  }

  for (const record of debugBreakpoints) {
    if (!record.remotePath) continue;
    for (const target of sessions) {
      const sessionMap = sessionSourceMaps.get(target.id);
      const sessionRef = sessionMap?.get(record.remotePath);
      const isTaggedSession = record.taggedSessionId !== null && record.taggedSessionId === target.id;

      // Prefer the session-specific sourceReference (either looked up just now, or the
      // one minted in the URI for the tagged session). Without a ref, adapters that
      // bound by reference will not match the clear.
      const refForThisSession = sessionRef
        ?? (isTaggedSession && record.sourceReference !== null ? record.sourceReference : null);

      if (refForThisSession !== null) {
        requests.push(clearBreakpointsForSourceDescriptor(target, {
          path: record.remotePath,
          sourceReference: refForThisSession,
        }));
      }
      // Always send the path-only fallback too — covers adapters that bind by path and
      // the (rare) case where loadedSources returned 0/undefined for sourceReference.
      requests.push(clearBreakpointsForSourceDescriptor(target, { path: record.remotePath }));
    }
  }

  // Package-browser `file:` URIs: the mirror bound these by the original source path +
  // each session's own sourceReference, so a path-only clear of the local fsPath misses.
  // Broadcast both a ref-keyed clear (when the session knows the source) and a path-only
  // clear to every session, mirroring the `debug:` URI handling above.
  for (const remotePath of trackedFilePackagePaths) {
    for (const target of sessions) {
      const sessionRef = sessionSourceMaps.get(target.id)?.get(remotePath);
      if (sessionRef !== undefined) {
        requests.push(clearBreakpointsForSourceDescriptor(target, {
          path: remotePath,
          sourceReference: sessionRef,
        }));
      }
      requests.push(clearBreakpointsForSourceDescriptor(target, { path: remotePath }));
    }
  }

  if (requests.length > 0) {
    const results = await withTimeout(Promise.all(requests), CLEAR_BREAKPOINT_TOTAL_TIMEOUT_MS, []);
    const cleared = results.filter((result) => result).length;
    logInfo(`[${appName}] Pre-stop cleared breakpoints: ${cleared.toString()}/${requests.length.toString()} setBreakpoints request(s) succeeded across ${sessions.length.toString()} session(s).`);
  }

  // Drop the orphan debug-URI breakpoints from VS Code's own state. After Stop the URI's
  // `sourceReference` becomes unresolvable, the editor tab cannot load content, and the
  // user often cannot remove the breakpoint via the editor margin. Removing here keeps
  // VS Code's breakpoint list clean for the next session.
  if (debugBreakpoints.length > 0) {
    vscode.debug.removeBreakpoints(debugBreakpoints.map((record) => record.breakpoint));
    logInfo(`[${appName}] Removed ${debugBreakpoints.length.toString()} orphan debug-URI breakpoint(s) from VS Code state.`);
  }

  // Forget the Package browser URIs for this app — they are now meaningless (the debug
  // session that minted them has ended) and will only confuse the next session's clear
  // pass if left behind.
  clearOpenedPackageUris(appName);
}

export async function scanAndWarnForDebuggerLiterals(
  appName: string,
  localRoot: string,
  lifecycleVersion: number,
  channel?: vscode.OutputChannel,
): Promise<void> {
  const settings = getRemoteInspectorCleanupSettings();
  if (!settings.warnDebuggerLiteralOnAttach) return;

  const warningKey = `${appName}:${lifecycleVersion.toString()}`;
  if (debuggerWarningsByLifecycle.has(warningKey)) return;
  debuggerWarningsByLifecycle.add(warningKey);

  const startedAt = Date.now();
  try {
    const matches = await scanForDebuggerLiterals(localRoot);
    const elapsedMs = Date.now() - startedAt;
    logInfo(`[${appName}] debugger literal scan found ${matches.length.toString()} match(es) in ${elapsedMs.toString()}ms.`);
    if (matches.length === 0) return;
    await showDebuggerLiteralWarning(appName, matches, channel);
  } catch (err: unknown) {
    logWarn(`[${appName}] debugger literal scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function showDebuggerLiteralWarning(
  appName: string,
  matches: DebuggerLiteralMatch[],
  channel: vscode.OutputChannel | undefined,
): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `CDS Debug: ${matches.length.toString()} local source file line(s) contain debugger; and may pause ${appName} when any inspector client is attached.`,
    OPEN_FIRST_MATCH_ACTION,
    SHOW_ALL_ACTION,
    IGNORE_SESSION_ACTION,
  );
  void incrementLocalTelemetryCounter('debuggerLiteralWarningShown');

  if (choice === OPEN_FIRST_MATCH_ACTION) {
    await openDebuggerLiteralMatch(matches[0]);
    return;
  }
  if (choice === SHOW_ALL_ACTION) {
    logDebuggerLiteralMatches(appName, matches, channel);
  }
}

async function openDebuggerLiteralMatch(match: DebuggerLiteralMatch | undefined): Promise<void> {
  if (match === undefined) return;
  const document = await vscode.workspace.openTextDocument(match.filePath);
  const editor = await vscode.window.showTextDocument(document);
  const line = Math.max(0, match.line - 1);
  const range = new vscode.Range(line, 0, line, 0);
  editor.selection = new vscode.Selection(line, 0, line, 0);
  editor.revealRange(range);
}

function logDebuggerLiteralMatches(
  appName: string,
  matches: DebuggerLiteralMatch[],
  channel: vscode.OutputChannel | undefined,
): void {
  const lines = matches.slice(0, MAX_LOGGED_DEBUGGER_MATCHES).map((match) =>
    `${match.filePath}:${match.line.toString()} ${match.preview}`,
  );
  channel?.appendLine(`[Extension] ${appName} debugger; literal matches:`);
  for (const line of lines) {
    channel?.appendLine(`[Extension] ${line}`);
    logWarn(`[${appName}] debugger; literal: ${line}`);
  }
  showLogChannel();
}

function isReminderDebounced(appName: string): boolean {
  const lastShownAt = lastReminderByApp.get(appName);
  return lastShownAt !== undefined && Date.now() - lastShownAt < REMOTE_INSPECTOR_REMINDER_DEBOUNCE_MS;
}

interface DebugUriBreakpointRecord {
  breakpoint: vscode.SourceBreakpoint;
  remotePath: string;
  sourceReference: number | null;
  taggedSessionId: string | null;
  scheme: string;
}

function extractDebugUriSessionId(uri: vscode.Uri): string | null {
  return parseDebugUriQuery(uri).get('session') ?? null;
}

function extractDebugUriSourceReference(uri: vscode.Uri): number | null {
  const raw = parseDebugUriQuery(uri).get('ref');
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

// `vscode.debug.asDebugSourceUri` constructs the query by URL-encoding the entire
// `session=<id>&ref=<n>` substring, so by the time the URI roundtrips through
// `Uri.parse`, `uri.query` reads back as `session%3D...%26ref%3D...` (the delimiters
// `=` and `&` themselves are percent-encoded). Feeding that directly into
// `URLSearchParams` treats the whole blob as one key with no value — the previous
// implementation therefore silently returned `null` for both session and ref, breaking
// every downstream consumer (per-session BP cleanup, BP mirror) that relied on them.
//
// Decode the query string FIRST so the literal delimiters are restored, then parse.
function parseDebugUriQuery(uri: vscode.Uri): Map<string, string> {
  const result = new Map<string, string>();
  const raw = uri.query;
  if (!raw) return result;
  const decoded = safeDecodeURIComponent(raw);
  // Use the decoded form when it contains delimiters; otherwise fall back to the raw
  // form (some VS Code versions hand back already-decoded queries).
  const queryString = decoded.includes('=') || decoded.includes('&') ? decoded : raw;
  for (const pair of queryString.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) {
      result.set(safeDecodeURIComponent(pair), '');
      continue;
    }
    const key = safeDecodeURIComponent(pair.slice(0, eq));
    const value = safeDecodeURIComponent(pair.slice(eq + 1));
    result.set(key, value);
  }
  return result;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectAppSessions(
  appName: string,
  fallback: vscode.DebugSession | undefined,
): vscode.DebugSession[] {
  const tracked = getDebugSessionsForApp(appName);
  if (tracked.length > 0) return tracked;
  // Registry has not yet seen the session (e.g. external retry path that bypassed
  // trackStartedDebugSession). Fall back to the explicitly passed root session so the
  // clear is still attempted somewhere.
  return fallback !== undefined ? [fallback] : [];
}

// External stop with no surviving session: a DAP clear is impossible, but the
// Package-browser `debug:` URIs are now permanently unresolvable — their breakpoints
// would linger in the Breakpoints panel with no editor able to remove them. Drop the
// non-file ones and forget the tracker. `file:` URIs keep their breakpoints because the
// local file still exists and stays valid for the next session.
function removeDeadPackageUriBreakpoints(appName: string): void {
  const trackedUris = new Set(getOpenedPackageUris(appName).map((uri) => uri.toString()));
  if (trackedUris.size > 0) {
    const orphans = vscode.debug.breakpoints.filter((bp): bp is vscode.SourceBreakpoint =>
      bp instanceof vscode.SourceBreakpoint
      && bp.location.uri.scheme !== 'file'
      && trackedUris.has(bp.location.uri.toString()));
    if (orphans.length > 0) {
      vscode.debug.removeBreakpoints(orphans);
      logInfo(`[${appName}] Removed ${orphans.length.toString()} dead Package-browser breakpoint(s) with no live session.`);
    }
  }
  clearOpenedPackageUris(appName);
}

// Returns the full source list, which slow CF regions have needed up to 10 s to produce
// for the Package browser. 3 s balances clear coverage against Stop latency; a miss only
// degrades to the path-only fallback clear, never to a hang.
const LOADED_SOURCES_QUERY_TIMEOUT_MS = 3_000;

interface DapSourceListResponse {
  sources?: { path?: unknown; sourceReference?: unknown }[];
}

// vscode-js-debug assigns each loaded source a session-scoped `sourceReference` (a stable
// integer derived from the source's identity within that session). The same `.ts` file
// loaded in parent + child + worker sessions therefore has THREE DIFFERENT
// sourceReferences. To clear a breakpoint bound by reference we must use the correct
// session's reference, which we cannot infer from the URI alone — the URI only carries
// the reference of the session that originally minted it. Querying every session's
// `loadedSources` once per Stop builds the `path → ref` map we need to send a precisely-
// targeted clear to each session.
async function loadSessionSourceMaps(
  sessions: readonly vscode.DebugSession[],
): Promise<Map<string, Map<string, number>>> {
  const result = new Map<string, Map<string, number>>();
  await Promise.all(sessions.map(async (session) => {
    const map = new Map<string, number>();
    try {
      const response = await withTimeout(
        Promise.resolve(session.customRequest('loadedSources', {})) as Promise<DapSourceListResponse | undefined>,
        LOADED_SOURCES_QUERY_TIMEOUT_MS,
        undefined,
      );
      const sources = response?.sources;
      if (Array.isArray(sources)) {
        for (const source of sources) {
          const path = typeof source.path === 'string' ? source.path : null;
          const ref = typeof source.sourceReference === 'number' ? source.sourceReference : 0;
          if (path !== null && ref > 0) map.set(path, ref);
        }
      }
    } catch (err: unknown) {
      logWarn(`[BreakpointCleanup] loadedSources query failed for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    result.set(session.id, map);
  }));
  return result;
}

function logBreakpointCleanupSummary(
  appName: string,
  sessions: readonly vscode.DebugSession[],
  workspacePaths: ReadonlySet<string>,
  debugBreakpoints: readonly DebugUriBreakpointRecord[],
): void {
  logInfo(`[BreakpointCleanup ${appName}] sessions=${sessions.length.toString()} workspaceBp=${workspacePaths.size.toString()} debugUriBp=${debugBreakpoints.length.toString()}`);
  for (const record of debugBreakpoints) {
    const ref = record.sourceReference === null ? 'none' : record.sourceReference.toString();
    const tagged = record.taggedSessionId ?? 'untagged';
    logInfo(`[BreakpointCleanup ${appName}] scheme=${record.scheme} path=${record.remotePath} ref=${ref} taggedSession=${tagged}`);
  }
}

// Every logical source path the breakpoint mirror may have used to bind a Package-browser
// `file:` URI. The mirror keys its `setBreakpoints` by `record.source.path` (the original
// loadedSources path — often a remote POSIX path or a `vscode-remote:` URI) and falls back
// to the URI's own path, so we clear all of them to guarantee the inspector copy is removed.
function collectMirrorBoundPaths(uri: vscode.Uri): string[] {
  const paths: string[] = [];
  const pushUnique = (value: string | undefined): void => {
    if (typeof value === 'string' && value.length > 0 && !paths.includes(value)) paths.push(value);
  };
  pushUnique(findOpenedPackageSourceByUri(uri)?.source?.path);
  pushUnique(uri.fsPath);
  pushUnique(uri.path);
  return paths;
}

function isInsideWorkspace(sourcePath: string): boolean {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders === undefined || workspaceFolders.length === 0) return true;
  return workspaceFolders.some((folder) => {
    const rel = relative(folder.uri.fsPath, sourcePath);
    return rel.length === 0 || (!rel.startsWith('..') && !rel.startsWith('/'));
  });
}

interface DapSourceDescriptor {
  path?: string;
  sourceReference?: number;
}

async function clearBreakpointsForSourceDescriptor(
  session: vscode.DebugSession,
  source: DapSourceDescriptor,
): Promise<boolean> {
  // vscode-js-debug matches a setBreakpoints request to its source registry by
  // `sourceReference` first (when non-zero) and falls back to `path`. To clear a breakpoint
  // that was originally set with `sourceReference > 0`, the empty-breakpoints request must
  // mirror that descriptor — a path-only clear silently misses, leaving the inspector with
  // a stale breakpoint that survives the debug session.
  return withTimeout(
    Promise.resolve(session.customRequest('setBreakpoints', {
      source,
      breakpoints: [],
      sourceModified: false,
    })).then(
      () => true,
      (err: unknown) => {
        const descriptor = source.sourceReference !== undefined
          ? `ref=${source.sourceReference.toString()}${source.path ? ` path=${source.path}` : ''}`
          : `path=${source.path ?? '<none>'}`;
        logWarn(`[BreakpointCleanup] setBreakpoints([]) failed for ${descriptor}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      },
    ),
    CLEAR_BREAKPOINT_REQUEST_TIMEOUT_MS,
    false,
  );
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
