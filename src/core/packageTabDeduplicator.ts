import * as vscode from 'vscode';
import { getDebugSessionsForApp } from './debugSessionRegistry';
import { logInfo, logWarn } from './logger';
import {
  extractSessionIdFromDebugUri,
  findAppForOpenedPath,
  getOpenedPackageUris,
  trackOpenedPackageUri,
  unregisterOpenedPackageUri,
} from './packageSourceBrowser';
import { getProcessOutputChannel } from './processManager';

// Background:
//
// vscode-js-debug mints a fresh `debug:` URI for every (session, sourceReference) pair
// when it serves a source-mapped file. The same `.ts` file lives in N sessions (parent +
// Remote Process + worker threads) with N different references, so the URI VS Code
// opens when the runtime pauses in a worker is provably distinct from the URI the
// Package browser opened earlier — even though both decode to the same file path.
//
// This module watches for newly opened tabs whose URI `path` matches a path the
// Package browser previously opened for the same app, and tries to collapse them onto
// the Package browser's canonical URI. Three reactive listeners are wired in because
// VS Code can populate a debug-paused tab through multiple internal code paths and
// `tabGroups.onDidChangeTabs` alone misses some of them (`vscode.TabInputText`
// instanceof can also fail across extension/runtime boundaries — see the duck-typed
// extraction below).

let disposables: vscode.Disposable[] = [];
const dedupeInFlight = new Set<string>();

// Tracks session IDs that are currently paused (received DAP `stopped` event and
// have not yet emitted `continued`). When a new `debug:` URI tab opens for a session
// in this set, that tab is the live paused-frame view — closing it would strip the
// user of the yellow arrow indicator and cursor placement at the debug line.
const pausedSessionIds = new Set<string>();

export function initializePackageTabDeduplicator(): void {
  if (disposables.length > 0) return;

  // Single source of truth: only react to NEWLY opened tabs. We deliberately do not
  // subscribe to `onDidChangeActiveTextEditor` — that fires every time the user
  // clicks on a tab, and reacting to it created a feedback loop where the moment the
  // user clicked the runtime-opened duplicate tab, we forced focus back to the
  // canonical Package browser tab. The dedupe must happen exactly once, when the
  // duplicate first appears, and not interfere with user navigation afterwards.
  disposables.push(vscode.window.tabGroups.onDidChangeTabs((event) => {
    for (const tab of event.opened) {
      void handleTab(tab);
    }
  }));

  // Track which sessions are currently paused. `stopped` is emitted before VS Code
  // opens the frame source tab, so by the time our `tabGroups.onDidChangeTabs.opened`
  // handler runs, the session id is already in `pausedSessionIds`. This lets the
  // handler distinguish a "duplicate to be closed" (any other tab open) from "the
  // live paused-frame view" (which must replace the canonical and KEEP the yellow
  // arrow + cursor on the right line).
  disposables.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
      return {
        onDidSendMessage(message: unknown): void {
          if (typeof message !== 'object' || message === null) return;
          const record = message as { type?: unknown; event?: unknown };
          if (record.type !== 'event') return;
          if (record.event === 'stopped') {
            pausedSessionIds.add(session.id);
          } else if (record.event === 'continued' || record.event === 'terminated') {
            pausedSessionIds.delete(session.id);
          }
        },
        onWillStopSession(): void {
          pausedSessionIds.delete(session.id);
        },
      };
    },
  }));
}

export function disposePackageTabDeduplicator(): void {
  for (const d of disposables) d.dispose();
  disposables = [];
  dedupeInFlight.clear();
  pausedSessionIds.clear();
}

// Duck-typed URI extraction: `instanceof vscode.TabInputText` is unreliable across the
// extension/runtime boundary (the class reference inside the extension host can differ
// from VS Code core's, especially for `debug:` URI tabs). Check shape instead.
function extractTabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (typeof input !== 'object' || input === null) return undefined;
  const inputAsRecord = input as { uri?: unknown };
  const uri = inputAsRecord.uri;
  return uri instanceof vscode.Uri ? uri : undefined;
}

function findTabByUriString(uriString: string): vscode.Tab | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const tabUri = extractTabUri(tab);
      if (tabUri?.toString() === uriString) return tab;
    }
  }
  return undefined;
}

// Evict any tracked URIs whose `session=<id>` query points to a debug session that no
// longer exists. Stale entries survive across debug sessions inside the same extension
// host (the tracker is just an in-memory Map) and would otherwise be picked as the
// "canonical" URI on the next run — VS Code cannot load content for a debug URI whose
// session has terminated, so the user is silently redirected onto a ghost editor that
// cannot bind breakpoints (Breakpoints panel shows them, but the editor margin stays
// empty and `setBreakpoints` to the dead session is a no-op).
function pruneStalePackageUris(appName: string): void {
  const liveSessionIds = new Set(getDebugSessionsForApp(appName).map((s) => s.id));
  if (liveSessionIds.size === 0) return;
  const removed: string[] = [];
  for (const uri of getOpenedPackageUris(appName)) {
    if (uri.scheme !== 'debug') continue;
    const sessionId = extractSessionIdFromDebugUri(uri);
    if (sessionId === null) continue;
    if (liveSessionIds.has(sessionId)) continue;
    unregisterOpenedPackageUri(appName, uri);
    removed.push(uri.toString());
  }
  if (removed.length > 0) {
    logInfo(`[TabDedupe ${appName}] pruned ${removed.length.toString()} stale tracked URI(s) whose session ended`);
    getProcessOutputChannel(appName)?.appendLine(`[Extension] [TabDedupe] pruned ${removed.length.toString()} stale URI(s) from previous debug session`);
  }
}

async function handleTab(tab: vscode.Tab): Promise<void> {
  const uri = extractTabUri(tab);
  if (uri === undefined) return;
  if (uri.scheme !== 'debug' && uri.scheme !== 'file') return;

  const appName = findAppForOpenedPath(uri.path);
  if (appName === undefined) return;

  pruneStalePackageUris(appName);

  const trackedUris = getOpenedPackageUris(appName);
  const canonical = trackedUris.find((candidate) => candidate.path === uri.path);
  if (canonical === undefined) return;
  if (canonical.toString() === uri.toString()) return;

  const newUriString = uri.toString();
  const dedupeKey = `${appName}::${newUriString}`;
  if (dedupeInFlight.has(dedupeKey)) return;
  dedupeInFlight.add(dedupeKey);

  try {
    // Two outcomes possible at this point:
    //
    //  (1) "Live-paused swap" — the freshly opened tab IS the runtime's paused-frame
    //      view (VS Code auto-opens this on DAP `stopped`). It carries the yellow
    //      arrow indicator AND the cursor positioned at the paused line. Closing it
    //      would strip both. Instead we promote the live URI to canonical, migrate
    //      the user's breakpoints onto it (so the red margin dot follows the pause
    //      context), and close the OLD canonical (the Package browser's pre-pause
    //      stamp, which is tagged with a session that is not currently executing
    //      the line and therefore reports `verified: false` — the "gray BP" the user
    //      reported).
    //
    //  (2) Otherwise it's a stray duplicate we should close, keeping the canonical
    //      tab the user already has focused.
    const newSessionId = extractSessionIdFromDebugUri(uri);
    const newIsPaused = newSessionId !== null && pausedSessionIds.has(newSessionId);

    if (newIsPaused) {
      await swapCanonicalToLivePaused(appName, canonical, uri, tab);
    } else {
      await closeDuplicate(appName, canonical, uri, newUriString, tab);
    }
  } finally {
    setTimeout(() => dedupeInFlight.delete(dedupeKey), 500);
  }
}

async function swapCanonicalToLivePaused(
  appName: string,
  oldCanonical: vscode.Uri,
  newCanonical: vscode.Uri,
  newTab: vscode.Tab,
): Promise<void> {
  const swapMsg = `[TabDedupe ${appName}] LIVE-PAUSED SWAP new(live)=${newCanonical.toString()} old(stale)=${oldCanonical.toString()}`;
  logInfo(swapMsg);
  getProcessOutputChannel(appName)?.appendLine(`[Extension] ${swapMsg}`);

  // 1. Migrate breakpoints from the old (now stale) URI to the live URI. Each migrated
  //    breakpoint preserves the original line/column/condition. Without this step the
  //    user's BPs would stay anchored to the closed tab — invisible in the live view
  //    and unable to render the red margin dot the user is looking for.
  const breakpointsToMigrate = vscode.debug.breakpoints.filter(
    (bp): bp is vscode.SourceBreakpoint =>
      bp instanceof vscode.SourceBreakpoint && bp.location.uri.toString() === oldCanonical.toString(),
  );
  if (breakpointsToMigrate.length > 0) {
    const replacements = breakpointsToMigrate.map((bp) => new vscode.SourceBreakpoint(
      new vscode.Location(newCanonical, bp.location.range),
      bp.enabled,
      bp.condition,
      bp.hitCondition,
      bp.logMessage,
    ));
    vscode.debug.addBreakpoints(replacements);
    vscode.debug.removeBreakpoints(breakpointsToMigrate);
    const bpMsg = `[TabDedupe ${appName}] migrated ${breakpointsToMigrate.length.toString()} breakpoint(s) to live URI`;
    logInfo(bpMsg);
    getProcessOutputChannel(appName)?.appendLine(`[Extension] ${bpMsg}`);
  }

  // 2. Update the tracker — `newCanonical` is now the source of truth for this path.
  unregisterOpenedPackageUri(appName, oldCanonical);
  trackOpenedPackageUri(appName, newCanonical);

  // 3. Close the OLD tab (the Package browser's stale stamp). The new tab stays open
  //    so VS Code's debug service keeps showing the yellow arrow + cursor placement.
  const oldTab = findTabByUriString(oldCanonical.toString());
  if (oldTab !== undefined) {
    try {
      const closed = await vscode.window.tabGroups.close(oldTab, false);
      const msg = `[TabDedupe ${appName}] closed stale canonical tab: success=${closed.toString()}`;
      logInfo(msg);
      getProcessOutputChannel(appName)?.appendLine(`[Extension] ${msg}`);
    } catch (err: unknown) {
      const errMsg = `[TabDedupe ${appName}] close stale tab failed: ${err instanceof Error ? err.message : String(err)}`;
      logWarn(errMsg);
      getProcessOutputChannel(appName)?.appendLine(`[Extension] ${errMsg}`);
    }
  }

  // 4. Focus the new (live) tab so the user lands on the paused-frame view directly.
  try {
    await vscode.window.showTextDocument(newCanonical, {
      preview: false,
      viewColumn: newTab.group.viewColumn,
      preserveFocus: false,
    });
  } catch (err: unknown) {
    const errMsg = `[TabDedupe ${appName}] focus live tab failed: ${err instanceof Error ? err.message : String(err)}`;
    logWarn(errMsg);
    getProcessOutputChannel(appName)?.appendLine(`[Extension] ${errMsg}`);
  }
}

async function closeDuplicate(
  appName: string,
  canonical: vscode.Uri,
  duplicateUri: vscode.Uri,
  duplicateUriString: string,
  duplicateTab: vscode.Tab,
): Promise<void> {
  trackOpenedPackageUri(appName, duplicateUri);
  const detectMsg = `[TabDedupe ${appName}] DUPLICATE DETECTED new=${duplicateUriString} canonical=${canonical.toString()}`;
  logInfo(detectMsg);
  getProcessOutputChannel(appName)?.appendLine(`[Extension] ${detectMsg}`);

  try {
    await vscode.window.showTextDocument(canonical, {
      preview: false,
      viewColumn: duplicateTab.group.viewColumn,
      preserveFocus: false,
    });
  } catch (err: unknown) {
    const errMsg = `[TabDedupe ${appName}] focus canonical failed: ${err instanceof Error ? err.message : String(err)}`;
    logWarn(errMsg);
    getProcessOutputChannel(appName)?.appendLine(`[Extension] ${errMsg}`);
  }

  // Re-find the tab by URI string before closing — the `Tab` reference handed to us
  // by the event may already be stale (VS Code's preview-tab behaviour auto-closes
  // the duplicate when we shift focus, beating our async close call).
  const freshTab = findTabByUriString(duplicateUriString);
  if (freshTab === undefined) {
    const msg = `[TabDedupe ${appName}] duplicate already closed by VS Code (preview dismiss)`;
    logInfo(msg);
    getProcessOutputChannel(appName)?.appendLine(`[Extension] ${msg}`);
    return;
  }
  try {
    const closed = await vscode.window.tabGroups.close(freshTab, false);
    const resultMsg = `[TabDedupe ${appName}] closed duplicate tab: success=${closed.toString()}`;
    logInfo(resultMsg);
    getProcessOutputChannel(appName)?.appendLine(`[Extension] ${resultMsg}`);
  } catch (err: unknown) {
    const errMsg = `[TabDedupe ${appName}] close duplicate failed: ${err instanceof Error ? err.message : String(err)}`;
    logWarn(errMsg);
    getProcessOutputChannel(appName)?.appendLine(`[Extension] ${errMsg}`);
  }
}
