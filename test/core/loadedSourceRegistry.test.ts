import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const { trackerState } = vi.hoisted(() => ({
  trackerState: {
    factory: undefined as vscode.DebugAdapterTrackerFactory | undefined,
  },
}));

vi.mock('vscode', () => ({
  debug: {
    registerDebugAdapterTrackerFactory: (
      _selector: string,
      factory: vscode.DebugAdapterTrackerFactory,
    ) => {
      trackerState.factory = factory;
      return { dispose: () => { trackerState.factory = undefined; } };
    },
  },
}));

import {
  applyLoadedSourceEvent,
  clearLoadedSourceRegistry,
  getLoadedSourcesForSessionIds,
  onLoadedSourceChanged,
  registerLoadedSourceTracker,
} from '../../src/core/loadedSourceRegistry';
import type { LoadedPackageSource } from '../../src/types/index';

type Store = Map<string, Map<string, LoadedPackageSource>>;

function session(id: string, name = `session-${id}`): vscode.DebugSession {
  return { id, name } as vscode.DebugSession;
}

function loadedSourceEvent(reason: 'new' | 'changed' | 'removed', source: unknown): unknown {
  return { type: 'event', event: 'loadedSource', body: { reason, source } };
}

afterEach(() => {
  clearLoadedSourceRegistry();
  trackerState.factory = undefined;
});

describe('applyLoadedSourceEvent', () => {
  it('adds a new source and stamps it with the session id/name', () => {
    const store: Store = new Map();
    const changed = applyLoadedSourceEvent(
      store,
      session('child-1', 'Remote Process [0]'),
      loadedSourceEvent('new', { name: 'worker.js', path: '/app/node_modules/pkg/worker.js' }),
    );

    expect(changed).toBe(true);
    const stored = [...(store.get('child-1')?.values() ?? [])];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.path).toBe('/app/node_modules/pkg/worker.js');
    expect(stored[0]?.debugSessionId).toBe('child-1');
    expect(stored[0]?.debugSessionName).toBe('Remote Process [0]');
  });

  it('ignores non-loadedSource messages', () => {
    const store: Store = new Map();
    expect(applyLoadedSourceEvent(store, session('a'), { type: 'event', event: 'stopped' })).toBe(false);
    expect(applyLoadedSourceEvent(store, session('a'), { type: 'response' })).toBe(false);
    expect(applyLoadedSourceEvent(store, session('a'), 'not-an-object')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('ignores a loadedSource event whose source has neither path nor name', () => {
    const store: Store = new Map();
    expect(applyLoadedSourceEvent(store, session('a'), loadedSourceEvent('new', { sourceReference: 0 }))).toBe(false);
    expect(store.size).toBe(0);
  });

  it('deduplicates by path: a "changed" event overwrites rather than appends', () => {
    const store: Store = new Map();
    applyLoadedSourceEvent(store, session('a'), loadedSourceEvent('new', { path: '/app/node_modules/pkg/i.js' }));
    applyLoadedSourceEvent(
      store,
      session('a'),
      loadedSourceEvent('changed', { path: '/app/node_modules/pkg/i.js', name: 'index.js' }),
    );

    const stored = [...(store.get('a')?.values() ?? [])];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('index.js');
  });

  it('removes a source on a "removed" event and prunes the empty session bucket', () => {
    const store: Store = new Map();
    applyLoadedSourceEvent(store, session('a'), loadedSourceEvent('new', { path: '/app/node_modules/pkg/i.js' }));
    const removed = applyLoadedSourceEvent(
      store,
      session('a'),
      loadedSourceEvent('removed', { path: '/app/node_modules/pkg/i.js' }),
    );

    expect(removed).toBe(true);
    expect(store.has('a')).toBe(false);
  });

  it('keys distinct sourceReferences separately when there is no path', () => {
    const store: Store = new Map();
    applyLoadedSourceEvent(store, session('a'), loadedSourceEvent('new', { name: 'a.js', sourceReference: 11 }));
    applyLoadedSourceEvent(store, session('a'), loadedSourceEvent('new', { name: 'b.js', sourceReference: 12 }));

    expect([...(store.get('a')?.values() ?? [])]).toHaveLength(2);
  });
});

describe('registerLoadedSourceTracker', () => {
  it('records loadedSource events from a session and exposes them per session id', () => {
    const disposable = registerLoadedSourceTracker();
    const factory = trackerState.factory;
    expect(factory).toBeDefined();

    const child = session('child-9', 'Remote Process [0]');
    const tracker = factory?.createDebugAdapterTracker(child) as vscode.DebugAdapterTracker;
    tracker.onDidSendMessage?.(
      loadedSourceEvent('new', { path: '/app/node_modules/pkg/worker.js' }),
    );

    expect(getLoadedSourcesForSessionIds(['child-9'])).toHaveLength(1);
    expect(getLoadedSourcesForSessionIds(['other'])).toHaveLength(0);

    disposable.dispose();
  });

  it('fires onLoadedSourceChanged when a tracked source set changes', () => {
    const listener = vi.fn();
    const sub = onLoadedSourceChanged(listener);
    const disposable = registerLoadedSourceTracker();
    const tracker = trackerState.factory?.createDebugAdapterTracker(session('s')) as vscode.DebugAdapterTracker;

    tracker.onDidSendMessage?.(loadedSourceEvent('new', { path: '/app/node_modules/pkg/i.js' }));
    expect(listener).toHaveBeenCalledTimes(1);

    // A non-source message must not fire the change event.
    tracker.onDidSendMessage?.({ type: 'event', event: 'continued' });
    expect(listener).toHaveBeenCalledTimes(1);

    sub.dispose();
    disposable.dispose();
  });

  it('forgets a session’s sources when the session stops', () => {
    const disposable = registerLoadedSourceTracker();
    const tracker = trackerState.factory?.createDebugAdapterTracker(session('gone')) as vscode.DebugAdapterTracker;
    tracker.onDidSendMessage?.(loadedSourceEvent('new', { path: '/app/node_modules/pkg/i.js' }));
    expect(getLoadedSourcesForSessionIds(['gone'])).toHaveLength(1);

    tracker.onWillStopSession?.();
    expect(getLoadedSourcesForSessionIds(['gone'])).toHaveLength(0);

    disposable.dispose();
  });

  it('aggregates sources across several session ids', () => {
    const disposable = registerLoadedSourceTracker();
    const t1 = trackerState.factory?.createDebugAdapterTracker(session('root')) as vscode.DebugAdapterTracker;
    const t2 = trackerState.factory?.createDebugAdapterTracker(session('worker')) as vscode.DebugAdapterTracker;
    t1.onDidSendMessage?.(loadedSourceEvent('new', { path: '/app/node_modules/a/i.js' }));
    t2.onDidSendMessage?.(loadedSourceEvent('new', { path: '/app/node_modules/b/i.js' }));

    expect(getLoadedSourcesForSessionIds(['root', 'worker'])).toHaveLength(2);

    disposable.dispose();
  });
});
