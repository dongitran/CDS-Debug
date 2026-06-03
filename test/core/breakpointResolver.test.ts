import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockTrackerFactory {
  createDebugAdapterTracker(session: unknown): { onDidSendMessage(msg: unknown): void } | undefined;
}

interface MockBreakpoint {
  enabled: boolean;
  location: {
    uri: { fsPath: string; scheme?: string };
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
    constructor(
      arg: MockBreakpoint | MockBreakpoint['location'],
      enabled?: boolean,
      condition?: string,
      hitCondition?: string,
      logMessage?: string,
    ) {
      if ('location' in arg) {
        // Object form used by the existing tests.
        this.enabled = arg.enabled;
        this.location = arg.location;
        if (arg.condition !== undefined) this.condition = arg.condition;
        if (arg.hitCondition !== undefined) this.hitCondition = arg.hitCondition;
        if (arg.logMessage !== undefined) this.logMessage = arg.logMessage;
        return;
      }
      // Positional form matching the real vscode.SourceBreakpoint(location, enabled, ...).
      this.location = arg;
      this.enabled = enabled ?? true;
      if (condition !== undefined) this.condition = condition;
      if (hitCondition !== undefined) this.hitCondition = hitCondition;
      if (logMessage !== undefined) this.logMessage = logMessage;
    }
  }
  return {
    vscodeMockState: {
      factory: undefined as MockTrackerFactory | undefined,
      breakpoints: [] as unknown[],
      addBreakpoints: vi.fn(),
      removeBreakpoints: vi.fn(),
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
    addBreakpoints: vscodeMockState.addBreakpoints,
    removeBreakpoints: vscodeMockState.removeBreakpoints,
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
  vscodeMockState.addBreakpoints.mockReset();
  vscodeMockState.removeBreakpoints.mockReset();
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

describe('UI re-verification (gray dot → red)', () => {
  const PACKAGE_TS = '/workspace/node_modules/.pnpm/demo-kit@1.0.0/node_modules/demo-kit/src/handler.ts';

  function fileBreakpoint(fsPath: string, line: number): InstanceType<typeof MockSourceBreakpoint> {
    return new MockSourceBreakpoint({
      enabled: true,
      location: { uri: { fsPath, scheme: 'file' }, range: { start: { line, character: 0 } } },
    });
  }

  it('removes and re-adds a matching file breakpoint so VS Code re-verifies it', async () => {
    vi.useFakeTimers();
    const breakpoint = fileBreakpoint(PACKAGE_TS, 11);
    vscodeMockState.breakpoints = [breakpoint];
    const session = createSession('Debug: demo-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);
    tracker?.onDidSendMessage(loadedSourceEvent(PACKAGE_TS));

    await vi.advanceTimersByTimeAsync(150);

    // Functional re-resolve via customRequest still happens (so execution pauses).
    expect(session.customRequest).toHaveBeenCalledWith('setBreakpoints', expect.objectContaining({
      source: { path: PACKAGE_TS },
    }));
    // And the breakpoint is removed + re-added so VS Code re-sends its own setBreakpoints
    // and flips the gutter from gray to red.
    expect(vscodeMockState.removeBreakpoints).toHaveBeenCalledWith([breakpoint]);
    expect(vscodeMockState.addBreakpoints).toHaveBeenCalledTimes(1);
    const added = vscodeMockState.addBreakpoints.mock.calls[0]?.[0] as MockBreakpoint[];
    expect(added[0]?.location.uri.fsPath).toBe(PACKAGE_TS);
    expect(added[0]?.location.range.start.line).toBe(11);
  });

  it('re-verifies a given breakpoint at most once per session (no repeated flicker)', async () => {
    vi.useFakeTimers();
    vscodeMockState.breakpoints = [fileBreakpoint(PACKAGE_TS, 3)];
    const session = createSession('Debug: demo-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);

    tracker?.onDidSendMessage(loadedSourceEvent(PACKAGE_TS));
    await vi.advanceTimersByTimeAsync(150);
    tracker?.onDidSendMessage(loadedSourceEvent(PACKAGE_TS));
    await vi.advanceTimersByTimeAsync(150);

    expect(vscodeMockState.addBreakpoints).toHaveBeenCalledTimes(1);
  });

  it('does not re-add debug: URI breakpoints (owned by the package mirror)', async () => {
    vi.useFakeTimers();
    const breakpoint = new MockSourceBreakpoint({
      enabled: true,
      location: { uri: { fsPath: PACKAGE_TS, scheme: 'debug' }, range: { start: { line: 7, character: 0 } } },
    });
    vscodeMockState.breakpoints = [breakpoint];
    const session = createSession('Debug: demo-service');
    const tracker = vscodeMockState.factory?.createDebugAdapterTracker(session);
    tracker?.onDidSendMessage(loadedSourceEvent(PACKAGE_TS));

    await vi.advanceTimersByTimeAsync(150);

    // Functional re-resolve still runs for the path...
    expect(session.customRequest).toHaveBeenCalledWith('setBreakpoints', expect.objectContaining({
      source: { path: PACKAGE_TS },
    }));
    // ...but the gutter re-verify is skipped for non-file URIs.
    expect(vscodeMockState.addBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.removeBreakpoints).not.toHaveBeenCalled();
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
