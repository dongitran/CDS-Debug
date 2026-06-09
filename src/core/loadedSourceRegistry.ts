import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';
import type { LoadedPackageSource } from '../types/index';
import { stampSourceSession, toLoadedPackageSource } from './packageSourceBrowser';

// Push-based companion to the pull-based `loadedSources` request in packageSourceBrowser.
//
// The Debug Adapter Protocol emits a `loadedSource` event ({ reason, source }) every time
// the debuggee loads/changes/unloads a script. vscode-js-debug fires it from
// `src/adapter/sourceContainer.ts`. By tracking these events for every session — including
// the child "Remote Process [N]" sessions that hold the real sources (the root "binder"
// session always answers `loadedSources` with an empty list) — we accumulate the package
// source set continuously, even between the warm-up loop's polls and before the user ever
// opens the Package browser. On a slow CF region this removes the reliance on hitting a
// `loadedSources` request at exactly the right millisecond.

// Per debug session id: loaded sources seen via `loadedSource` events, keyed by a stable
// identity so 'changed' events overwrite rather than duplicate.
const sourcesBySessionId = new Map<string, Map<string, LoadedPackageSource>>();

const changeEmitter = new EventEmitter();
const CHANGE_EVENT = 'changed';
// Many concurrent package loads can subscribe; avoid Node's 10-listener warning.
changeEmitter.setMaxListeners(0);

interface LoadedSourceEventLike {
  reason: 'new' | 'changed' | 'removed';
  source: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseLoadedSourceEvent(message: unknown): LoadedSourceEventLike | null {
  if (!isRecord(message)) return null;
  if (message.type !== 'event' || message.event !== 'loadedSource') return null;
  if (!isRecord(message.body)) return null;
  const reason = message.body.reason;
  if (reason !== 'new' && reason !== 'changed' && reason !== 'removed') return null;
  return { reason, source: message.body.source };
}

function sourceIdentity(source: LoadedPackageSource): string {
  if (source.path) return `path:${source.path}`;
  if (typeof source.sourceReference === 'number' && source.sourceReference > 0) {
    return `ref:${source.sourceReference.toString()}`;
  }
  return `name:${source.name ?? ''}`;
}

// Applies one DAP message to the given store. Exported (and store-injected) so the parsing
// and dedupe logic can be unit-tested without a live debug adapter. Returns true when the
// store changed, so the caller can decide whether to notify subscribers.
export function applyLoadedSourceEvent(
  store: Map<string, Map<string, LoadedPackageSource>>,
  session: vscode.DebugSession,
  message: unknown,
): boolean {
  const event = parseLoadedSourceEvent(message);
  if (!event) return false;
  const parsed = toLoadedPackageSource(event.source);
  if (!parsed) return false;
  const stamped = stampSourceSession(parsed, session);
  const key = sourceIdentity(stamped);

  const existing = store.get(session.id);
  if (event.reason === 'removed') {
    if (!existing) return false;
    const deleted = existing.delete(key);
    if (existing.size === 0) store.delete(session.id);
    return deleted;
  }

  const sessionMap = existing ?? new Map<string, LoadedPackageSource>();
  if (!existing) store.set(session.id, sessionMap);
  sessionMap.set(key, stamped);
  return true;
}

// Returns all sources accumulated for the given session ids (e.g. the root + child
// sessions of one app). Each source is already stamped with its originating session.
export function getLoadedSourcesForSessionIds(sessionIds: Iterable<string>): LoadedPackageSource[] {
  const out: LoadedPackageSource[] = [];
  for (const id of sessionIds) {
    const sessionMap = sourcesBySessionId.get(id);
    if (sessionMap) out.push(...sessionMap.values());
  }
  return out;
}

export function forgetLoadedSourcesForSession(sessionId: string): void {
  sourcesBySessionId.delete(sessionId);
}

export function clearLoadedSourceRegistry(): void {
  sourcesBySessionId.clear();
}

// Subscribe to "a tracked source set changed" notifications. Returns a disposable that
// matches VS Code's Disposable shape so callers can push it onto subscription arrays.
export function onLoadedSourceChanged(listener: () => void): { dispose: () => void } {
  changeEmitter.on(CHANGE_EVENT, listener);
  return { dispose: (): void => { changeEmitter.off(CHANGE_EVENT, listener); } };
}

// Registers a global debug adapter tracker that records `loadedSource` events from every
// debug session. Call once during activation and dispose on deactivate.
export function registerLoadedSourceTracker(): vscode.Disposable {
  return vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker {
      return {
        onDidSendMessage(message: unknown): void {
          if (applyLoadedSourceEvent(sourcesBySessionId, session, message)) {
            changeEmitter.emit(CHANGE_EVENT);
          }
        },
        onWillStopSession(): void {
          forgetLoadedSourcesForSession(session.id);
        },
        onExit(): void {
          forgetLoadedSourcesForSession(session.id);
        },
      };
    },
  });
}
