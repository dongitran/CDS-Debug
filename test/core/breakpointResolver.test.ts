import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockTrackerFactory {
  createDebugAdapterTracker(session: unknown): { onDidSendMessage(msg: unknown): void } | undefined;
}

interface MockBreakpoint {
  enabled: boolean;
  location: {
    uri: { fsPath: string };
    range: { start: { line: number; character: number } };
  };
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

const { vscodeMockState, MockSourceBreakpoint } = vi.hoisted(() => {
  class HoistedSourceBreakpoint {
    enabled: boolean;
    location: MockBreakpoint['location'];
    condition?: string;
    hitCondition?: string;
    logMessage?: string;
    constructor(breakpoint: MockBreakpoint) {
      this.enabled = breakpoint.enabled;
      this.location = breakpoint.location;
      if (breakpoint.condition !== undefined) this.condition = breakpoint.condition;
      if (breakpoint.hitCondition !== undefined) this.hitCondition = breakpoint.hitCondition;
      if (breakpoint.logMessage !== undefined) this.logMessage = breakpoint.logMessage;
    }
  }
  return {
    vscodeMockState: {
      factory: undefined as MockTrackerFactory | undefined,
      breakpoints: [] as unknown[],
    },
    MockSourceBreakpoint: HoistedSourceBreakpoint,
  };
});

vi.mock('vscode', () => ({
  debug: {
    get breakpoints() {
      return vscodeMockState.breakpoints;
    },
    registerDebugAdapterTrackerFactory: (_type: string, factory: MockTrackerFactory) => {
      vscodeMockState.factory = factory;
      return {
        dispose: () => { vscodeMockState.factory = undefined; },
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
  SourceBreakpoint: MockSourceBreakpoint,
}));

import {
  disposeBreakpointResolver,
  initializeBreakpointResolver,
} from '../../src/core/breakpointResolver';

interface MockSession {
  id: string;
  name: string;
  parentSession?: MockSession;
  customRequest: ReturnType<typeof vi.fn>;
}

function createSession(name: string, id = 'session-1'): MockSession {
  return {
    id,
    name,
    customRequest: vi.fn().mockResolvedValue(undefined),
  };
}

function loadedSourceEvent(path: string, reason: 'new' | 'changed' | 'removed' = 'new'): unknown {
  return { type: 'event', event: 'loadedSource', body: { reason, source: { path } } };
}

beforeEach(() => {
  vscodeMockState.factory = undefined;
  vscodeMockState.breakpoints = [];
  initializeBreakpointResolver();
});

afterEach(() => {
  disposeBreakpointResolver();
  vi.useRealTimers();
});

describe('initializeBreakpointResolver', () => {
  it('registers a debug adapter tracker factory exactly once', () => {
    initializeBreakpointResolver();
    initializeBreakpointResolver();
    expect(vscodeMockState.factory).toBeDefined();
  });

  it('returns no tracker for non-CDS Debug sessions', () => {
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(createSession('Manual: my-config'));
    expect(tracker).toBeUndefined();
  });

  it('returns a tracker for CDS Debug sessions', () => {
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(createSession('Debug: catalog-service'));
    expect(tracker).toBeDefined();
  });

  it('returns a tracker for child sessions whose ancestor is a CDS Debug session', () => {
    const parent = createSession('Debug: catalog-service', 'parent');
    const child: MockSession = { ...createSession('worker-1', 'child'), parentSession: parent };
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(child);
    expect(tracker).toBeDefined();
  });
});

describe('loadedSource handling', () => {
  it('re-sends setBreakpoints for matching enabled breakpoints after the debounce', async () => {
    vi.useFakeTimers();
    vscodeMockState.breakpoints = [
      new MockSourceBreakpoint({
        enabled: true,
        location: {
          uri: { fsPath: '/workspace/srv/catalog-service.js' },
          range: { start: { line: 9, character: 4 } },
        },
        condition: 'foo === 1',
      }),
    ];
    const session = createSession('Debug: catalog-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);
    tracker?.onDidSendMessage(loadedSourceEvent('/workspace/srv/catalog-service.js'));

    await vi.advanceTimersByTimeAsync(150);

    expect(session.customRequest).toHaveBeenCalledOnce();
    expect(session.customRequest).toHaveBeenCalledWith('setBreakpoints', {
      source: { path: '/workspace/srv/catalog-service.js' },
      breakpoints: [{ line: 10, column: 5, condition: 'foo === 1' }],
      sourceModified: false,
    });
  });

  it('coalesces multiple loadedSource events for the same session inside the debounce window', async () => {
    vi.useFakeTimers();
    vscodeMockState.breakpoints = [
      new MockSourceBreakpoint({
        enabled: true,
        location: { uri: { fsPath: '/a.js' }, range: { start: { line: 0, character: 0 } } },
      }),
      new MockSourceBreakpoint({
        enabled: true,
        location: { uri: { fsPath: '/b.js' }, range: { start: { line: 1, character: 0 } } },
      }),
    ];
    const session = createSession('Debug: catalog-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);
    tracker?.onDidSendMessage(loadedSourceEvent('/a.js'));
    tracker?.onDidSendMessage(loadedSourceEvent('/b.js'));

    await vi.advanceTimersByTimeAsync(150);

    expect(session.customRequest).toHaveBeenCalledTimes(2);
  });

  it('skips events whose reason is not "new"', () => {
    vi.useFakeTimers();
    const session = createSession('Debug: catalog-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);
    tracker?.onDidSendMessage(loadedSourceEvent('/a.js', 'changed'));
    tracker?.onDidSendMessage({ type: 'event', event: 'output', body: {} });

    vi.advanceTimersByTime(200);

    expect(session.customRequest).not.toHaveBeenCalled();
  });

  it('does not call setBreakpoints when no breakpoint matches the loaded source', async () => {
    vi.useFakeTimers();
    vscodeMockState.breakpoints = [
      new MockSourceBreakpoint({
        enabled: true,
        location: { uri: { fsPath: '/other.js' }, range: { start: { line: 0, character: 0 } } },
      }),
    ];
    const session = createSession('Debug: catalog-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);
    tracker?.onDidSendMessage(loadedSourceEvent('/a.js'));

    await vi.advanceTimersByTimeAsync(150);

    expect(session.customRequest).not.toHaveBeenCalled();
  });

  it('ignores disabled breakpoints', async () => {
    vi.useFakeTimers();
    vscodeMockState.breakpoints = [
      new MockSourceBreakpoint({
        enabled: false,
        location: { uri: { fsPath: '/a.js' }, range: { start: { line: 5, character: 0 } } },
      }),
    ];
    const session = createSession('Debug: catalog-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);
    tracker?.onDidSendMessage(loadedSourceEvent('/a.js'));

    await vi.advanceTimersByTimeAsync(150);

    expect(session.customRequest).not.toHaveBeenCalled();
  });
});

describe('Windows path comparison', () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    originalPlatform = process.platform;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('matches breakpoint URIs and DAP source paths case-insensitively on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.useFakeTimers();
    vscodeMockState.breakpoints = [
      new MockSourceBreakpoint({
        enabled: true,
        location: {
          uri: { fsPath: 'C:\\workspace\\srv\\catalog-service.js' },
          range: { start: { line: 9, character: 0 } },
        },
      }),
    ];
    const session = createSession('Debug: catalog-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);
    tracker?.onDidSendMessage(loadedSourceEvent('c:\\workspace\\srv\\catalog-service.js'));

    await vi.advanceTimersByTimeAsync(150);

    expect(session.customRequest).toHaveBeenCalledOnce();
  });

  it('keeps the strict comparison on case-sensitive platforms (linux/darwin)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.useFakeTimers();
    vscodeMockState.breakpoints = [
      new MockSourceBreakpoint({
        enabled: true,
        location: {
          uri: { fsPath: '/Users/Dev/Workspace/srv/catalog-service.js' },
          range: { start: { line: 0, character: 0 } },
        },
      }),
    ];
    const session = createSession('Debug: catalog-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);
    // Different casing — should NOT match on a case-sensitive platform.
    tracker?.onDidSendMessage(loadedSourceEvent('/users/dev/workspace/srv/catalog-service.js'));

    await vi.advanceTimersByTimeAsync(150);

    expect(session.customRequest).not.toHaveBeenCalled();
  });
});
