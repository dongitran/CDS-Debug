import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockDebugSession {
  id: string;
  name: string;
  customRequest: (command: string, args: unknown) => Promise<unknown>;
}

interface MockDebugEvent {
  event: string;
  session: MockDebugSession;
  body: unknown;
}

const { vscodeMockState } = vi.hoisted(() => ({
  vscodeMockState: {
    handler: undefined as ((event: MockDebugEvent) => void) | undefined,
    pauseOnBreakpoint: false,
    breakpointSnapshotMaxEntries: 120,
  },
}));

vi.mock('vscode', () => ({
  debug: {
    onDidReceiveDebugSessionCustomEvent: (handler: (event: MockDebugEvent) => void) => {
      vscodeMockState.handler = handler;
      return {
        dispose: () => {
          vscodeMockState.handler = undefined;
        },
      };
    },
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

import {
  breakpointSnapshotEvents,
  clearBreakpointSnapshots,
  disposeBreakpointSnapshotManager,
  getBreakpointSnapshots,
  initializeBreakpointSnapshotManager,
} from '../../src/core/breakpointSnapshotManager';

function createMockSession(
  options?: {
    stackPath?: string;
  },
): { session: MockDebugSession; customRequestCalls: string[] } {
  const customRequestCalls: string[] = [];
  const stackPath = options?.stackPath ?? '/workspace/srv/catalog-service.js';
  const customRequest = (command: string, args: unknown): Promise<unknown> => {
    void args;
    customRequestCalls.push(command);
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

  return {
    session: {
      id: 'session-1',
      name: 'Debug: catalog-service',
      customRequest,
    },
    customRequestCalls,
  };
}

function emitStoppedEvent(session: MockDebugSession, reason = 'breakpoint'): void {
  const handler = vscodeMockState.handler;
  if (!handler) {
    throw new Error('Debug event handler is not initialized.');
  }
  handler({
    event: 'stopped',
    session,
    body: {
      reason,
      threadId: 1,
    },
  });
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
});
