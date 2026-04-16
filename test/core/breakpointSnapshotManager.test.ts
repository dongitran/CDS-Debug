import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockDebugSession {
  id: string;
  name: string;
  type?: string;
  parentSession?: MockDebugSession;
  customRequest: (command: string, args: unknown) => Promise<unknown>;
}

interface MockTrackerFactory {
  createDebugAdapterTracker(session: MockDebugSession): { onDidSendMessage(msg: unknown): void } | undefined;
}

const { vscodeMockState } = vi.hoisted(() => ({
  vscodeMockState: {
    factory: undefined as MockTrackerFactory | undefined,
    sessions: [] as MockDebugSession[],
    pauseOnBreakpoint: false,
    breakpointSnapshotMaxEntries: 120,
  },
}));

const { debugPrefsMockState } = vi.hoisted(() => ({
  debugPrefsMockState: {
    value: {
      openBrowserOnAttach: false,
      enableBranchPrep: false,
      enableBreakpointSnapshotHandling: true,
    },
  },
}));

vi.mock('vscode', () => ({
  debug: {
    get sessions() {
      return vscodeMockState.sessions;
    },
    registerDebugAdapterTrackerFactory: (_type: string, factory: MockTrackerFactory) => {
      vscodeMockState.factory = factory;
      return {
        dispose: () => {
          vscodeMockState.factory = undefined;
        },
      };
    },
  },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, defaultValue?: unknown) => {
        if (key === 'pauseOnBreakpoint') {
          return vscodeMockState.pauseOnBreakpoint;
        }
        if (key === 'breakpointSnapshotMaxEntries') {
          return vscodeMockState.breakpointSnapshotMaxEntries;
        }
        return defaultValue;
      },
    }),
  },
}));

vi.mock('../../src/storage/cacheStore', () => ({
  getDebugPreferences: () => debugPrefsMockState.value,
}));

import {
  breakpointSnapshotEvents,
  clearBreakpointSnapshots,
  disposeBreakpointSnapshotManager,
  getBreakpointSnapshots,
  initializeBreakpointSnapshotManager,
} from '../../src/core/breakpointSnapshotManager';

function createMockSession(
  options?: {
    id?: string;
    name?: string;
    stackPath?: string;
    parentSession?: MockDebugSession;
  },
): { session: MockDebugSession; customRequestCalls: string[] } {
  const customRequestCalls: string[] = [];
  const id = options?.id ?? 'session-1';
  const name = options?.name ?? 'Debug: catalog-service';
  const stackPath = options?.stackPath ?? '/workspace/srv/catalog-service.js';
  const customRequest = (command: string, args: unknown): Promise<unknown> => {
    void args;
    customRequestCalls.push(command);
    if (command === 'threads') {
      return Promise.resolve({ threads: [{ id: 1 }] });
    }
    if (command === 'stackTrace') {
      return Promise.resolve({
        stackFrames: [
          {
            id: 11,
            name: 'beforeCreate',
            line: 42,
            column: 9,
            source: { path: stackPath },
          },
        ],
      });
    }
    if (command === 'scopes') {
      return Promise.resolve({
        scopes: [
          {
            name: 'Local',
            expensive: false,
            variablesReference: 101,
          },
        ],
      });
    }
    if (command === 'variables') {
      return Promise.resolve({
        variables: [
          { name: 'token', value: 'raw-secret-token', type: 'string', variablesReference: 0 },
          { name: 'req.id', value: 'abc-123', type: 'string', variablesReference: 0 },
        ],
      });
    }
    if (command === 'continue') {
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`Unexpected request: ${command}`));
  };

  const session: MockDebugSession = {
    id,
    name,
    customRequest,
  };
  if (options?.parentSession) {
    session.parentSession = options.parentSession;
  }

  return {
    session,
    customRequestCalls,
  };
}

function createMockSessionWithFailingStackTrace(): { session: MockDebugSession; customRequestCalls: string[] } {
  const customRequestCalls: string[] = [];
  const customRequest = (command: string, args: unknown): Promise<unknown> => {
    void args;
    customRequestCalls.push(command);
    if (command === 'stackTrace') {
      return Promise.reject(new Error('DAP stack trace failed'));
    }
    if (command === 'continue') {
      return Promise.resolve({});
    }
    return Promise.reject(new Error(`Unexpected request: ${command}`));
  };
  return {
    session: { id: 'session-fail', name: 'Debug: catalog-service', customRequest },
    customRequestCalls,
  };
}

function getTrackerFor(
  session: MockDebugSession,
): { onDidSendMessage(msg: unknown): void } | undefined {
  registerSessionTree(session);
  const factory = vscodeMockState.factory;
  if (!factory) throw new Error('Factory not initialized.');
  return factory.createDebugAdapterTracker(session);
}

function registerSessionTree(session: MockDebugSession): void {
  const add = (s: MockDebugSession | undefined): void => {
    if (!s) return;
    if (!vscodeMockState.sessions.some((existing) => existing.id === s.id)) {
      vscodeMockState.sessions.push(s);
    }
    add(s.parentSession);
  };
  add(session);
}

function emitStoppedEvent(session: MockDebugSession, reason = 'breakpoint'): void {
  const tracker = getTrackerFor(session);
  if (!tracker) return;
  tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { reason, threadId: 1 } });
}

function emitStoppedEventWithBody(session: MockDebugSession, body: Record<string, unknown>): void {
  const tracker = getTrackerFor(session);
  if (!tracker) return;
  tracker.onDidSendMessage({ type: 'event', event: 'stopped', body });
}

async function waitForSnapshots(expectedLength: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getBreakpointSnapshots().length === expectedLength) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expectedLength.toString()} snapshot(s).`);
}

beforeEach(() => {
  vscodeMockState.pauseOnBreakpoint = false;
  vscodeMockState.breakpointSnapshotMaxEntries = 120;
  vscodeMockState.sessions = [];
  debugPrefsMockState.value = {
    openBrowserOnAttach: false,
    enableBranchPrep: false,
    enableBreakpointSnapshotHandling: true,
  };
  initializeBreakpointSnapshotManager();
});

afterEach(() => {
  disposeBreakpointSnapshotManager();
  clearBreakpointSnapshots();
  breakpointSnapshotEvents.removeAllListeners();
});

describe('breakpointSnapshotManager', () => {
  it('captures breakpoint context, redacts sensitive values, and auto-continues by default', async () => {
    const { session, customRequestCalls } = createMockSession();
    emitStoppedEvent(session);
    await waitForSnapshots(1);

    const snapshots = getBreakpointSnapshots();
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0];
    if (!snapshot) {
      throw new Error('Expected one snapshot.');
    }
    expect(snapshot.appName).toBe('catalog-service');
    expect(snapshot.autoResumed).toBe(true);
    expect(snapshot.location?.sourcePath).toBe('/workspace/srv/catalog-service.js');
    expect(snapshot.location?.line).toBe(42);
    expect(snapshot.scopes).toHaveLength(1);
    expect(snapshot.scopes[0]?.variables[0]?.name).toBe('token');
    expect(snapshot.scopes[0]?.variables[0]?.value).toBe('[REDACTED]');
    expect(customRequestCalls).toContain('continue');
  });

  it('excludes Global scope, skips expensive scopes, and prioritizes Local/Arguments', async () => {
    const customRequestCalls: string[] = [];
    const capturedVariableReferences: number[] = [];
    const session: MockDebugSession = {
      id: 'session-global',
      name: 'Debug: catalog-service',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        customRequestCalls.push(command);
        if (command === 'threads') return Promise.resolve({ threads: [{ id: 1 }] });
        if (command === 'stackTrace') {
          return Promise.resolve({
            stackFrames: [
              {
                id: 11,
                name: 'beforeCreate',
                line: 42,
                column: 9,
                source: { path: '/workspace/srv/catalog-service.js' },
              },
            ],
          });
        }
        if (command === 'scopes') {
          return Promise.resolve({
            scopes: [
              { name: 'Global', expensive: false, variablesReference: 999 },
              { name: 'Module', expensive: true, variablesReference: 998 },
              { name: 'Closure', expensive: false, variablesReference: 103 },
              { name: 'Arguments', expensive: false, variablesReference: 102 },
              { name: 'Local', expensive: false, variablesReference: 101 },
            ],
          });
        }
        if (command === 'variables') {
          const variablesArg = typeof args === 'object' && args !== null
            ? (args as { variablesReference?: unknown })
            : {};
          const variablesReference = typeof variablesArg.variablesReference === 'number'
            ? variablesArg.variablesReference
            : -1;
          capturedVariableReferences.push(variablesReference);
          if (variablesReference === 101 || variablesReference === 102) {
            return Promise.resolve({
              variables: [
                { name: 'req.id', value: 'abc-123', type: 'string', variablesReference: 0 },
              ],
            });
          }
          return Promise.resolve({ variables: [] });
        }
        if (command === 'continue') return Promise.resolve({});
        return Promise.reject(new Error(`Unexpected request: ${command}`));
      },
    };

    emitStoppedEvent(session);
    await waitForSnapshots(1);

    const snapshot = getBreakpointSnapshots()[0];
    if (!snapshot) throw new Error('Expected one snapshot.');
    expect(snapshot.scopes.map((scope) => scope.name)).toEqual(['Local', 'Arguments']);
    expect(capturedVariableReferences).toEqual(expect.arrayContaining([101, 102]));
    expect(capturedVariableReferences).not.toContain(998);
    expect(capturedVariableReferences).not.toContain(999);
    expect(capturedVariableReferences).not.toContain(103);
    expect(customRequestCalls).toContain('continue');
  });

  it('still captures a scope when adapter marks all scopes as expensive', async () => {
    const capturedVariableReferences: number[] = [];
    const session: MockDebugSession = {
      id: 'session-expensive',
      name: 'Debug: catalog-service',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        if (command === 'threads') return Promise.resolve({ threads: [{ id: 1 }] });
        if (command === 'stackTrace') {
          return Promise.resolve({
            stackFrames: [
              {
                id: 11,
                name: 'beforeCreate',
                line: 42,
                column: 9,
                source: { path: '/workspace/srv/catalog-service.js' },
              },
            ],
          });
        }
        if (command === 'scopes') {
          return Promise.resolve({
            scopes: [
              { name: 'Arguments', expensive: true, variablesReference: 102 },
              { name: 'Local', expensive: true, variablesReference: 101 },
            ],
          });
        }
        if (command === 'variables') {
          const variablesArg = typeof args === 'object' && args !== null
            ? (args as { variablesReference?: unknown })
            : {};
          const variablesReference = typeof variablesArg.variablesReference === 'number'
            ? variablesArg.variablesReference
            : -1;
          capturedVariableReferences.push(variablesReference);
          return Promise.resolve({
            variables: [
              { name: 'req.id', value: 'abc-123', type: 'string', variablesReference: 0 },
            ],
          });
        }
        if (command === 'continue') return Promise.resolve({});
        return Promise.reject(new Error(`Unexpected request: ${command}`));
      },
    };

    emitStoppedEvent(session);
    await waitForSnapshots(1);

    const snapshot = getBreakpointSnapshots()[0];
    if (!snapshot) throw new Error('Expected one snapshot.');
    expect(snapshot.scopes.map((scope) => scope.name)).toEqual(['Local', 'Arguments']);
    expect(capturedVariableReferences).toEqual(expect.arrayContaining([101, 102]));
  });

  it('does not auto-continue when pauseOnBreakpoint is enabled', async () => {
    vscodeMockState.pauseOnBreakpoint = true;
    const { session, customRequestCalls } = createMockSession();

    emitStoppedEvent(session);
    await waitForSnapshots(1);

    const snapshots = getBreakpointSnapshots();
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0];
    if (!snapshot) {
      throw new Error('Expected one snapshot.');
    }
    expect(snapshot.autoResumed).toBe(false);
    expect(customRequestCalls).not.toContain('continue');
  });

  it('ignores non-breakpoint stopped events', async () => {
    const { session, customRequestCalls } = createMockSession();
    emitStoppedEvent(session, 'step');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getBreakpointSnapshots()).toHaveLength(0);
    expect(customRequestCalls).toHaveLength(0);
  });

  it('does not handle breakpoints when snapshot handling is disabled in debug preferences', async () => {
    debugPrefsMockState.value = {
      openBrowserOnAttach: false,
      enableBranchPrep: false,
      enableBreakpointSnapshotHandling: false,
    };
    const { session, customRequestCalls } = createMockSession();
    emitStoppedEvent(session);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(getBreakpointSnapshots()).toHaveLength(0);
    expect(customRequestCalls).toHaveLength(0);
  });

  it('ignores stopped events from sessions that do not map to a CDS session', async () => {
    const mockCustomRequest = vi.fn().mockResolvedValue({});
    const nonCdsSession: MockDebugSession = {
      id: 'session-other',
      name: 'Attach to React App',
      customRequest: mockCustomRequest,
    };

    const tracker = getTrackerFor(nonCdsSession);
    if (tracker) {
      tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getBreakpointSnapshots()).toHaveLength(0);
    expect(mockCustomRequest).not.toHaveBeenCalled();
  });

  it('creates an error snapshot and still auto-continues when threadId is absent', async () => {
    const { session, customRequestCalls } = createMockSession();
    emitStoppedEventWithBody(session, { reason: 'breakpoint' });
    await waitForSnapshots(1);

    const snapshot = getBreakpointSnapshots()[0];
    if (!snapshot) throw new Error('Expected one snapshot.');
    expect(snapshot.captureError).toBe('No threadId found in breakpoint event.');
    expect(snapshot.autoResumed).toBe(true);
    expect(customRequestCalls).toContain('threads');
    expect(customRequestCalls).toContain('continue');
    expect(customRequestCalls).not.toContain('stackTrace');
    expect(customRequestCalls).not.toContain('scopes');
    expect(customRequestCalls).not.toContain('variables');
  });

  it('creates an error snapshot and still auto-continues when stack trace capture fails', async () => {
    const { session, customRequestCalls } = createMockSessionWithFailingStackTrace();
    emitStoppedEvent(session);
    await waitForSnapshots(1);

    const snapshot = getBreakpointSnapshots()[0];
    if (!snapshot) throw new Error('Expected one snapshot.');
    expect(snapshot.captureError).toBe('DAP stack trace failed');
    expect(snapshot.autoResumed).toBe(true);
    expect(customRequestCalls).toContain('stackTrace');
    expect(customRequestCalls).toContain('continue');
    expect(customRequestCalls).not.toContain('scopes');
    expect(customRequestCalls).not.toContain('variables');
  });

  it('limits child expansion requests to avoid fan-out latency spikes', async () => {
    const childReferencesRequested: number[] = [];
    const session: MockDebugSession = {
      id: 'session-child-limit',
      name: 'Debug: catalog-service',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        if (command === 'threads') return Promise.resolve({ threads: [{ id: 1 }] });
        if (command === 'stackTrace') {
          return Promise.resolve({
            stackFrames: [
              {
                id: 11,
                name: 'beforeCreate',
                line: 42,
                column: 9,
                source: { path: '/workspace/srv/catalog-service.js' },
              },
            ],
          });
        }
        if (command === 'scopes') {
          return Promise.resolve({
            scopes: [
              { name: 'Local', expensive: false, variablesReference: 101 },
            ],
          });
        }
        if (command === 'variables') {
          const variablesArg = typeof args === 'object' && args !== null
            ? (args as { variablesReference?: unknown })
            : {};
          const variablesReference = typeof variablesArg.variablesReference === 'number'
            ? variablesArg.variablesReference
            : -1;
          if (variablesReference === 101) {
            return Promise.resolve({
              variables: [
                { name: 'obj1', value: '{...}', type: 'object', variablesReference: 201 },
                { name: 'obj2', value: '{...}', type: 'object', variablesReference: 202 },
                { name: 'obj3', value: '{...}', type: 'object', variablesReference: 203 },
                { name: 'obj4', value: '{...}', type: 'object', variablesReference: 204 },
                { name: 'obj5', value: '{...}', type: 'object', variablesReference: 205 },
              ],
            });
          }
          childReferencesRequested.push(variablesReference);
          return Promise.resolve({
            variables: [{ name: 'id', value: '1', type: 'number', variablesReference: 0 }],
          });
        }
        if (command === 'continue') return Promise.resolve({});
        return Promise.reject(new Error(`Unexpected request: ${command}`));
      },
    };

    emitStoppedEvent(session);
    await waitForSnapshots(1);

    const snapshot = getBreakpointSnapshots()[0];
    if (!snapshot) throw new Error('Expected one snapshot.');
    expect(childReferencesRequested).toEqual([201, 202, 203, 204]);
    const localVariables = snapshot.scopes[0]?.variables ?? [];
    expect(localVariables[0]?.children?.length).toBe(1);
    expect(localVariables[1]?.children?.length).toBe(1);
    expect(localVariables[2]?.children?.length).toBe(1);
    expect(localVariables[3]?.children?.length).toBe(1);
    expect(localVariables[4]?.children).toBeUndefined();
  });

  it('times out slow child expansion and still resumes with top-level variables', async () => {
    const customRequestCalls: string[] = [];
    const session: MockDebugSession = {
      id: 'session-child-timeout',
      name: 'Debug: catalog-service',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        customRequestCalls.push(command);
        if (command === 'threads') return Promise.resolve({ threads: [{ id: 1 }] });
        if (command === 'stackTrace') {
          return Promise.resolve({
            stackFrames: [
              {
                id: 11,
                name: 'beforeCreate',
                line: 42,
                column: 9,
                source: { path: '/workspace/srv/catalog-service.js' },
              },
            ],
          });
        }
        if (command === 'scopes') {
          return Promise.resolve({
            scopes: [
              { name: 'Local', expensive: false, variablesReference: 101 },
            ],
          });
        }
        if (command === 'variables') {
          const variablesArg = typeof args === 'object' && args !== null
            ? (args as { variablesReference?: unknown })
            : {};
          const variablesReference = typeof variablesArg.variablesReference === 'number'
            ? variablesArg.variablesReference
            : -1;
          if (variablesReference === 101) {
            return Promise.resolve({
              variables: [
                { name: 'req', value: '{...}', type: 'object', variablesReference: 201 },
                { name: 'req.id', value: 'abc-123', type: 'string', variablesReference: 0 },
              ],
            });
          }
          if (variablesReference === 201) {
            return new Promise(() => undefined);
          }
          return Promise.resolve({ variables: [] });
        }
        if (command === 'continue') return Promise.resolve({});
        return Promise.reject(new Error(`Unexpected request: ${command}`));
      },
    };

    emitStoppedEvent(session);
    await waitForSnapshots(1);

    const snapshot = getBreakpointSnapshots()[0];
    if (!snapshot) throw new Error('Expected one snapshot.');
    expect(snapshot.autoResumed).toBe(true);
    const reqVariable = snapshot.scopes[0]?.variables[0];
    expect(reqVariable?.name).toBe('req');
    expect(reqVariable?.children).toBeUndefined();
    expect(customRequestCalls).toContain('continue');
  });

  it('caps the snapshot store at the configured max entries', async () => {
    vscodeMockState.breakpointSnapshotMaxEntries = 25;
    const { session } = createMockSession();

    for (let i = 0; i < 30; i++) {
      emitStoppedEvent(session);
    }

    // Wait until store reaches the cap
    await waitForSnapshots(25);

    // Allow any remaining queue tasks to drain
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(getBreakpointSnapshots()).toHaveLength(25);
  });

  it('registers only one event listener when initialized multiple times', async () => {
    // beforeEach already called initializeBreakpointSnapshotManager once
    initializeBreakpointSnapshotManager();
    initializeBreakpointSnapshotManager();

    const { session } = createMockSession();
    emitStoppedEvent(session);
    await waitForSnapshots(1);

    // A duplicate tracker registration would have produced 2 or 3 snapshots from a single event
    expect(getBreakpointSnapshots()).toHaveLength(1);
  });

  it('emits snapshotAdded event with the captured snapshot', async () => {
    const emittedIds: string[] = [];
    breakpointSnapshotEvents.on('snapshotAdded', (s: { id: string }) => {
      emittedIds.push(s.id);
    });

    const { session } = createMockSession();
    emitStoppedEvent(session);
    await waitForSnapshots(1);

    const snapshots = getBreakpointSnapshots();
    expect(emittedIds).toHaveLength(1);
    expect(emittedIds[0]).toBe(snapshots[0]?.id);
  });

  it('falls back to ancestor CDS session for continue when child-session continue fails', async () => {
    const parentCalls: string[] = [];
    const parentSession: MockDebugSession = {
      id: 'session-parent',
      name: 'Debug: catalog-service',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        void args;
        parentCalls.push(command);
        if (command === 'continue') return Promise.resolve({});
        if (command === 'threads') return Promise.resolve({ threads: [{ id: 1 }] });
        return Promise.reject(new Error(`Unexpected parent request: ${command}`));
      },
    };

    const { session: childSession, customRequestCalls: childCalls } = createMockSession({
      id: 'session-child',
      name: 'Node.js Worker',
      parentSession,
    });
    childSession.customRequest = (command: string, args: unknown): Promise<unknown> => {
      void args;
      childCalls.push(command);
      if (command === 'stackTrace') {
        return Promise.resolve({
          stackFrames: [
            {
              id: 11,
              name: 'beforeCreate',
              line: 42,
              column: 9,
              source: { path: '/workspace/srv/catalog-service.js' },
            },
          ],
        });
      }
      if (command === 'scopes') {
        return Promise.resolve({
          scopes: [
            {
              name: 'Local',
              expensive: false,
              variablesReference: 101,
            },
          ],
        });
      }
      if (command === 'variables') {
        return Promise.resolve({
          variables: [
            { name: 'req.id', value: 'abc-123', type: 'string', variablesReference: 0 },
          ],
        });
      }
      if (command === 'continue') {
        return Promise.reject(new Error('continue not supported in child session'));
      }
      if (command === 'threads') {
        return Promise.resolve({ threads: [{ id: 1 }] });
      }
      return Promise.reject(new Error(`Unexpected child request: ${command}`));
    };

    emitStoppedEvent(childSession);
    await waitForSnapshots(1);

    const snapshot = getBreakpointSnapshots()[0];
    if (!snapshot) throw new Error('Expected one snapshot.');
    expect(snapshot.appName).toBe('catalog-service');
    expect(snapshot.autoResumed).toBe(true);
    expect(childCalls).toContain('continue');
    expect(parentCalls).toContain('continue');
  });
});
