import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockUri {
  scheme: string;
  path: string;
  fsPath: string;
  query: string;
  toString(): string;
}

interface MockRange {
  start: {
    line: number;
    character: number;
  };
}

interface MockBreakpointEvent {
  added: unknown[];
  removed: unknown[];
  changed: unknown[];
}

interface MockSession {
  id: string;
  name: string;
  type: string;
  customRequest: ReturnType<typeof vi.fn>;
}

interface MockLoadedSource {
  path: string;
  sourceReference?: number;
}

interface MockBreakpointOptions {
  enabled?: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

interface MockOpenedPackageSourceRecord {
  appName: string;
  uri: MockUri;
  source?: {
    name?: string;
    path?: string;
    sourceReference?: number;
  };
  sessionId?: string;
  sessionName?: string;
}

const SOURCE_PATH = '/workspace/node_modules/sample-client/src/client.ts';

const {
  MockSourceBreakpoint,
  vscodeMockState,
  debugSessionRegistryMockState,
  packageSourceBrowserMockState,
} = vi.hoisted(() => {
  class HoistedUri {
    constructor(
      private readonly raw: string,
      public readonly scheme: string,
      public readonly path: string,
      public readonly fsPath: string,
      public readonly query = '',
    ) {}

    toString(): string {
      return this.raw;
    }
  }

  class HoistedLocation {
    constructor(
      public readonly uri: MockUri,
      public readonly range: MockRange,
    ) {}
  }

  class HoistedSourceBreakpoint {
    constructor(
      public readonly location: HoistedLocation,
      public readonly enabled = true,
      public readonly condition?: string,
      public readonly hitCondition?: string,
      public readonly logMessage?: string,
    ) {}
  }

  return {
    MockSourceBreakpoint: HoistedSourceBreakpoint,
    vscodeMockState: {
      Uri: HoistedUri,
      Location: HoistedLocation,
      breakpointListener: undefined as undefined | ((event: MockBreakpointEvent) => void),
      breakpoints: [] as unknown[],
      addBreakpoints: vi.fn(),
      removeBreakpoints: vi.fn(),
      asDebugSourceUri: vi.fn(),
      showTextDocument: vi.fn(),
    },
    debugSessionRegistryMockState: {
      sessionsByApp: new Map<string, MockSession[]>(),
    },
    packageSourceBrowserMockState: {
      records: new Map<string, MockOpenedPackageSourceRecord>(),
    },
  };
});

vi.mock('../../src/core/debugSessionRegistry', () => ({
  getDebugSessionsForApp: (appName: string): MockSession[] =>
    debugSessionRegistryMockState.sessionsByApp.get(appName) ?? [],
}));

vi.mock('../../src/core/packageSourceBrowser', () => ({
  findOpenedPackageSourceByUri: (uri: MockUri): MockOpenedPackageSourceRecord | undefined => {
    const exact = packageSourceBrowserMockState.records.get(uri.toString());
    if (exact !== undefined) return exact;
    for (const record of packageSourceBrowserMockState.records.values()) {
      if (record.uri.path === uri.path) return record;
    }
    return undefined;
  },
  trackOpenedPackageUri: vi.fn(),
}));

vi.mock('vscode', () => ({
  SourceBreakpoint: MockSourceBreakpoint,
  Uri: {
    parse: (value: string): MockUri => {
      const parsed = new URL(value);
      return new vscodeMockState.Uri(
        value,
        parsed.protocol.slice(0, -1),
        decodeURIComponent(parsed.pathname),
        decodeURIComponent(parsed.pathname),
        parsed.search.slice(1),
      );
    },
  },
  Location: vscodeMockState.Location,
  debug: {
    get breakpoints(): unknown[] {
      return vscodeMockState.breakpoints;
    },
    onDidChangeBreakpoints: (listener: (event: MockBreakpointEvent) => void) => {
      vscodeMockState.breakpointListener = listener;
      return { dispose: vi.fn() };
    },
    addBreakpoints: vscodeMockState.addBreakpoints,
    removeBreakpoints: vscodeMockState.removeBreakpoints,
    asDebugSourceUri: vscodeMockState.asDebugSourceUri,
  },
  window: {
    showTextDocument: vscodeMockState.showTextDocument,
    createOutputChannel: () => ({
      appendLine: () => undefined,
      append: () => undefined,
      clear: () => undefined,
      dispose: () => undefined,
      show: () => undefined,
    }),
  },
}));

import {
  disposePackageBreakpointMirror,
  initializePackageBreakpointMirror,
} from '../../src/core/packageBreakpointMirror';

function createUri(scheme: 'debug' | 'file', path: string, query = ''): MockUri {
  const raw = scheme === 'debug'
    ? `debug:${path}${query ? `?${query}` : ''}`
    : `file://${path}`;
  return new vscodeMockState.Uri(raw, scheme, path, path, query);
}

function createBreakpoint(
  uri: MockUri,
  line = 4,
  character = 2,
  options: MockBreakpointOptions = {},
): InstanceType<typeof MockSourceBreakpoint> {
  return new MockSourceBreakpoint(
    new vscodeMockState.Location(uri, { start: { line, character } }),
    options.enabled ?? true,
    options.condition,
    options.hitCondition,
    options.logMessage,
  );
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      if (resolvePromise === undefined) {
        throw new Error('Deferred promise resolver was not initialized.');
      }
      resolvePromise(value);
    },
  };
}

function createVerifyingSession(id: string, source: MockLoadedSource = { path: SOURCE_PATH, sourceReference: 41 }): MockSession {
  return {
    id,
    name: `Remote Process ${id}`,
    type: 'pwa-node',
    customRequest: vi.fn((command: string): Promise<unknown> => {
      if (command === 'loadedSources') {
        return Promise.resolve({ sources: [source] });
      }
      if (command === 'setBreakpoints') {
        return Promise.resolve({ breakpoints: [{ verified: true }] });
      }
      return Promise.resolve(undefined);
    }),
  };
}

function registerOpenedPackageSource(
  appName: string,
  uri: MockUri,
  session: Pick<MockSession, 'id' | 'name'>,
  source: { name?: string; path?: string; sourceReference?: number } = {
    name: 'client.ts',
    path: SOURCE_PATH,
    sourceReference: 41,
  },
): void {
  packageSourceBrowserMockState.records.set(uri.toString(), {
    appName,
    uri,
    source,
    sessionId: session.id,
    sessionName: session.name,
  });
}

function createFailingSetSession(): MockSession {
  return {
    id: 'session-failing-set',
    name: 'Remote Process failing set',
    type: 'pwa-node',
    customRequest: vi.fn((command: string): Promise<unknown> => {
      if (command === 'setBreakpoints') return Promise.reject(new Error('adapter refused breakpoints'));
      return Promise.resolve(undefined);
    }),
  };
}

function createUnverifiedSession(): MockSession {
  return {
    id: 'session-unverified',
    name: 'Remote Process unverified',
    type: 'pwa-node',
    customRequest: vi.fn((command: string): Promise<unknown> => {
      if (command === 'loadedSources') {
        return Promise.resolve({ sources: [{ path: SOURCE_PATH, sourceReference: 52 }] });
      }
      if (command === 'setBreakpoints') {
        return Promise.resolve({ breakpoints: [{ verified: false }, {}] });
      }
      return Promise.resolve(undefined);
    }),
  };
}

function createPathOnlyLookupSession(): MockSession {
  return {
    id: 'session-path-only',
    name: 'Remote Process path only',
    type: 'pwa-node',
    customRequest: vi.fn((command: string): Promise<unknown> => {
      if (command === 'loadedSources') {
        return Promise.resolve({
          sources: [
            { path: 42, sourceReference: 90 },
            { path: '/workspace/node_modules/sample-client/src/other.ts', sourceReference: 91 },
            { path: SOURCE_PATH, sourceReference: 'not-a-number' },
          ],
        });
      }
      if (command === 'setBreakpoints') return Promise.resolve({ breakpoints: [{ verified: true }] });
      return Promise.resolve(undefined);
    }),
  };
}

function createInvalidSourceListSession(): MockSession {
  return {
    id: 'session-invalid-list',
    name: 'Remote Process invalid list',
    type: 'pwa-node',
    customRequest: vi.fn((command: string): Promise<unknown> => {
      if (command === 'loadedSources') return Promise.resolve({ bad: true });
      if (command === 'setBreakpoints') return Promise.resolve({ breakpoints: [{ verified: true }] });
      return Promise.resolve(undefined);
    }),
  };
}

function createFailingLookupSession(): MockSession {
  return {
    id: 'session-failing-lookup',
    name: 'Remote Process failing lookup',
    type: 'pwa-node',
    customRequest: vi.fn((command: string): Promise<unknown> => {
      if (command === 'loadedSources') return Promise.reject(new Error('adapter closed'));
      if (command === 'setBreakpoints') return Promise.resolve({ breakpoints: [{ verified: true }] });
      return Promise.resolve(undefined);
    }),
  };
}

function createVerifiedSiblingSession(): MockSession {
  return {
    id: 'session-verified',
    name: 'Remote Process verified',
    type: 'pwa-node',
    customRequest: vi.fn((command: string): Promise<unknown> => {
      if (command === 'loadedSources') {
        return Promise.resolve({ sources: [{ path: SOURCE_PATH, sourceReference: 55 }] });
      }
      if (command === 'setBreakpoints') return Promise.resolve({ breakpoints: [{ verified: true }] });
      return Promise.resolve(undefined);
    }),
  };
}

beforeEach(() => {
  vscodeMockState.breakpointListener = undefined;
  vscodeMockState.breakpoints = [];
  vscodeMockState.addBreakpoints.mockReset();
  vscodeMockState.removeBreakpoints.mockReset();
  vscodeMockState.asDebugSourceUri.mockReset();
  vscodeMockState.showTextDocument.mockReset();
  debugSessionRegistryMockState.sessionsByApp.clear();
  packageSourceBrowserMockState.records.clear();
  vscodeMockState.asDebugSourceUri.mockImplementation((source: { path?: string; sourceReference?: number }, session: MockSession) => {
    const sourcePath = source.path ?? 'unknown';
    if ((source.sourceReference ?? 0) <= 0 && sourcePath.startsWith('/')) {
      return createUri('file', sourcePath);
    }
    return createUri('debug', sourcePath, `session=${session.id}&ref=${String(source.sourceReference ?? 0)}`);
  });
});

afterEach(() => {
  disposePackageBreakpointMirror();
});

describe('packageBreakpointMirror', () => {
  it('refreshes path-only package file breakpoints after the mirror verifies them', async () => {
    const appName = 'sample-service';
    const fileUri = createUri('file', SOURCE_PATH);
    const breakpoint = createBreakpoint(fileUri);
    const session = createVerifyingSession('session-a', { path: SOURCE_PATH, sourceReference: 0 });
    vscodeMockState.breakpoints = [breakpoint];
    debugSessionRegistryMockState.sessionsByApp.set(appName, [session]);
    packageSourceBrowserMockState.records.set(fileUri.toString(), {
      appName,
      uri: fileUri,
      source: {
        name: 'client.ts',
        path: SOURCE_PATH,
        sourceReference: 0,
      },
      sessionId: session.id,
      sessionName: session.name,
    });

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [breakpoint], removed: [], changed: [] });

    await vi.waitFor(() => {
      expect(vscodeMockState.addBreakpoints).toHaveBeenCalledTimes(1);
    });
    expect(vscodeMockState.asDebugSourceUri).toHaveBeenCalledWith(
      expect.objectContaining({
        path: SOURCE_PATH,
      }),
      session,
    );
    expect(session.customRequest).not.toHaveBeenCalledWith('loadedSources', expect.any(Object));
    const replacements = vscodeMockState.addBreakpoints.mock.calls[0]?.[0] as unknown[];
    const replacement = replacements[0] as InstanceType<typeof MockSourceBreakpoint> | undefined;
    expect(replacement?.location.uri.toString()).toBe(fileUri.toString());
    expect(replacement?.location.range).toEqual(breakpoint.location.range);
    expect(vscodeMockState.removeBreakpoints).toHaveBeenCalledWith([breakpoint]);
  });

  it('keeps materialized file breakpoints on file URIs instead of migrating back to debug URIs', async () => {
    const appName = 'sample-service';
    const fileUri = createUri('file', SOURCE_PATH);
    const breakpoint = createBreakpoint(fileUri);
    const session = createVerifyingSession('session-a');
    vscodeMockState.breakpoints = [breakpoint];
    debugSessionRegistryMockState.sessionsByApp.set(appName, [session]);
    packageSourceBrowserMockState.records.set(fileUri.toString(), {
      appName,
      uri: fileUri,
      source: {
        name: 'client.ts',
        path: SOURCE_PATH,
        sourceReference: 41,
      },
      sessionId: session.id,
      sessionName: session.name,
    });

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [breakpoint], removed: [], changed: [] });

    await vi.waitFor(() => {
      expect(session.customRequest).toHaveBeenCalledWith('setBreakpoints', expect.any(Object));
    });
    expect(vscodeMockState.addBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.removeBreakpoints).not.toHaveBeenCalled();
  });

  it('ignores non-source and untracked breakpoint changes', async () => {
    const appName = 'sample-service';
    const session = createVerifyingSession('session-ignore');
    const untracked = createBreakpoint(createUri('debug', SOURCE_PATH, 'session=session-ignore&ref=41'));
    debugSessionRegistryMockState.sessionsByApp.set(appName, [session]);

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({
      added: [{ enabled: true }, untracked],
      removed: [],
      changed: [],
    });
    await Promise.resolve();

    expect(session.customRequest).not.toHaveBeenCalled();
    expect(vscodeMockState.addBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.removeBreakpoints).not.toHaveBeenCalled();
  });

  it('leaves tracked package breakpoints untouched when no app sessions are active', async () => {
    const appName = 'sample-service';
    const debugUri = createUri('debug', SOURCE_PATH, 'session=session-ended&ref=41');
    const breakpoint = createBreakpoint(debugUri);
    vscodeMockState.breakpoints = [breakpoint];
    registerOpenedPackageSource(appName, debugUri, {
      id: 'session-ended',
      name: 'Remote Process ended',
    });

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [breakpoint], removed: [], changed: [] });
    await Promise.resolve();

    expect(vscodeMockState.addBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.removeBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.showTextDocument).not.toHaveBeenCalled();
  });

  it('clears mirrored package breakpoints when the tracked breakpoint is removed', async () => {
    const appName = 'sample-service';
    const debugUri = createUri('debug', SOURCE_PATH, 'session=session-remove&ref=41');
    const removedBreakpoint = createBreakpoint(debugUri);
    const session = createVerifyingSession('session-remove');
    vscodeMockState.breakpoints = [];
    debugSessionRegistryMockState.sessionsByApp.set(appName, [session]);
    registerOpenedPackageSource(appName, debugUri, session);

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [], removed: [removedBreakpoint], changed: [] });

    await vi.waitFor(() => {
      expect(session.customRequest).toHaveBeenCalledWith(
        'setBreakpoints',
        expect.objectContaining({
          breakpoints: [],
          source: {
            path: SOURCE_PATH,
            sourceReference: 41,
          },
        }),
      );
    });
    expect(vscodeMockState.addBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.removeBreakpoints).not.toHaveBeenCalled();
  });

  it('keeps breakpoint state unchanged when sessions fail or do not verify mirrored breakpoints', async () => {
    const appName = 'sample-service';
    const debugUri = createUri('debug', SOURCE_PATH, 'session=session-failing-set&ref=41');
    const breakpoint = createBreakpoint(debugUri);
    const failingSetSession = createFailingSetSession();
    const unverifiedSession = createUnverifiedSession();
    vscodeMockState.breakpoints = [breakpoint];
    debugSessionRegistryMockState.sessionsByApp.set(appName, [failingSetSession, unverifiedSession]);
    registerOpenedPackageSource(appName, debugUri, failingSetSession);

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [breakpoint], removed: [], changed: [] });

    await vi.waitFor(() => {
      expect(unverifiedSession.customRequest).toHaveBeenCalledWith('setBreakpoints', expect.any(Object));
    });
    expect(failingSetSession.customRequest).toHaveBeenCalledWith('setBreakpoints', expect.any(Object));
    expect(vscodeMockState.addBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.removeBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.showTextDocument).not.toHaveBeenCalled();
  });

  it('mirrors only enabled matching breakpoints with their DAP conditions', async () => {
    const appName = 'sample-service';
    const debugUri = createUri('debug', SOURCE_PATH, 'session=session-conditions&ref=41');
    const otherUri = createUri('debug', '/workspace/node_modules/sample-client/src/other.ts', 'session=session-conditions&ref=42');
    const active = createBreakpoint(debugUri, 6, 3, {
      condition: 'sampleFlag === true',
      hitCondition: '3',
      logMessage: 'sample hit',
    });
    const disabled = createBreakpoint(debugUri, 9, 1, { enabled: false });
    const otherSource = createBreakpoint(otherUri, 12, 1);
    const session = createVerifyingSession('session-conditions');
    vscodeMockState.breakpoints = [active, disabled, otherSource];
    debugSessionRegistryMockState.sessionsByApp.set(appName, [session]);
    registerOpenedPackageSource(appName, debugUri, session);
    registerOpenedPackageSource(
      appName,
      otherUri,
      session,
      {
        name: 'other.ts',
        path: otherUri.path,
        sourceReference: 42,
      },
    );

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [active], removed: [], changed: [] });

    await vi.waitFor(() => {
      expect(session.customRequest).toHaveBeenCalledWith(
        'setBreakpoints',
        expect.objectContaining({
          breakpoints: [
            {
              line: 7,
              column: 4,
              condition: 'sampleFlag === true',
              hitCondition: '3',
              logMessage: 'sample hit',
            },
          ],
        }),
      );
    });
  });

  it('refreshes file breakpoints in place for URI-like path-only debugger sources', async () => {
    const appName = 'sample-service';
    const fileUri = createUri('file', '/workspace/sample-service/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.ts');
    const sourcePath = 'vscode-remote://sample-host/home/sample/workspace/sample-service/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.ts';
    const breakpoint = createBreakpoint(fileUri);
    const session = createVerifyingSession('session-uri-path', { path: sourcePath, sourceReference: 0 });
    vscodeMockState.breakpoints = [breakpoint];
    debugSessionRegistryMockState.sessionsByApp.set(appName, [session]);
    packageSourceBrowserMockState.records.set(fileUri.toString(), {
      appName,
      uri: fileUri,
      source: {
        name: 'main.ts',
        path: sourcePath,
        sourceReference: 0,
      },
      sessionId: session.id,
      sessionName: session.name,
    });

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [breakpoint], removed: [], changed: [] });

    await vi.waitFor(() => {
      expect(session.customRequest).toHaveBeenCalledWith('setBreakpoints', expect.any(Object));
    });
    expect(session.customRequest).toHaveBeenCalledWith(
      'setBreakpoints',
      expect.objectContaining({
        source: { path: sourcePath },
      }),
    );
    expect(vscodeMockState.asDebugSourceUri).not.toHaveBeenCalled();
    expect(vscodeMockState.addBreakpoints).toHaveBeenCalledTimes(1);
    const replacements = vscodeMockState.addBreakpoints.mock.calls[0]?.[0] as unknown[];
    const replacement = replacements[0] as InstanceType<typeof MockSourceBreakpoint> | undefined;
    expect(replacement?.location.uri.toString()).toBe(fileUri.toString());
    expect(replacement?.location.uri.scheme).toBe('file');
    expect(replacement?.location.range).toEqual(breakpoint.location.range);
    expect(vscodeMockState.removeBreakpoints).toHaveBeenCalledWith([breakpoint]);
    expect(vscodeMockState.showTextDocument).not.toHaveBeenCalled();
  });

  it('refreshes only the added file breakpoint after verification', async () => {
    const appName = 'sample-service';
    const fileUri = createUri('file', SOURCE_PATH);
    const existingA = createBreakpoint(fileUri, 1);
    const existingB = createBreakpoint(fileUri, 3);
    const added = createBreakpoint(fileUri, 5);
    const session = createVerifyingSession('session-delta-refresh', { path: SOURCE_PATH, sourceReference: 0 });
    vscodeMockState.breakpoints = [existingA, existingB, added];
    debugSessionRegistryMockState.sessionsByApp.set(appName, [session]);
    packageSourceBrowserMockState.records.set(fileUri.toString(), {
      appName,
      uri: fileUri,
      source: {
        name: 'client.ts',
        path: SOURCE_PATH,
        sourceReference: 0,
      },
      sessionId: session.id,
      sessionName: session.name,
    });

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [added], removed: [], changed: [] });

    await vi.waitFor(() => {
      expect(vscodeMockState.addBreakpoints).toHaveBeenCalledTimes(1);
    });
    const replacements = vscodeMockState.addBreakpoints.mock.calls[0]?.[0] as unknown[];
    expect(replacements).toHaveLength(1);
    const replacement = replacements[0] as InstanceType<typeof MockSourceBreakpoint> | undefined;
    expect(replacement?.location.range).toEqual(added.location.range);
    expect(vscodeMockState.removeBreakpoints).toHaveBeenCalledWith([added]);
  });

  it('uses sibling loadedSources defensively when mirroring across sessions', async () => {
    const appName = 'sample-service';
    const debugUri = createUri('debug', SOURCE_PATH, 'session=session-owner&ref=41');
    const breakpoint = createBreakpoint(debugUri);
    const ownerSession = createVerifyingSession('session-owner');
    const pathOnlySession = createPathOnlyLookupSession();
    const invalidSourceListSession = createInvalidSourceListSession();
    const failingLookupSession = createFailingLookupSession();
    vscodeMockState.breakpoints = [breakpoint];
    debugSessionRegistryMockState.sessionsByApp.set(appName, [
      ownerSession,
      pathOnlySession,
      invalidSourceListSession,
      failingLookupSession,
    ]);
    registerOpenedPackageSource(appName, debugUri, ownerSession);

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [breakpoint], removed: [], changed: [] });

    await vi.waitFor(() => {
      expect(pathOnlySession.customRequest).toHaveBeenCalledWith(
        'setBreakpoints',
        expect.objectContaining({
          source: { path: SOURCE_PATH },
        }),
      );
    });
    expect(ownerSession.customRequest).toHaveBeenCalledWith(
      'setBreakpoints',
      expect.objectContaining({
        source: {
          path: SOURCE_PATH,
          sourceReference: 41,
        },
      }),
    );
    expect(invalidSourceListSession.customRequest).not.toHaveBeenCalledWith('setBreakpoints', expect.any(Object));
    expect(failingLookupSession.customRequest).not.toHaveBeenCalledWith('setBreakpoints', expect.any(Object));
  });

  it('migrates breakpoints to a verified sibling URI even when focusing the editor fails', async () => {
    const appName = 'sample-service';
    const staleUri = createUri('debug', SOURCE_PATH, 'session=session-stale&ref=9');
    const breakpoint = createBreakpoint(staleUri);
    const verifiedSession = createVerifiedSiblingSession();
    vscodeMockState.breakpoints = [breakpoint];
    vscodeMockState.showTextDocument.mockRejectedValue(new Error('editor unavailable'));
    debugSessionRegistryMockState.sessionsByApp.set(appName, [verifiedSession]);
    registerOpenedPackageSource(
      appName,
      staleUri,
      {
        id: 'session-stale',
        name: 'Remote Process stale',
      },
      {
        name: 'client.ts',
        path: SOURCE_PATH,
        sourceReference: 9,
      },
    );

    initializePackageBreakpointMirror();
    vscodeMockState.breakpointListener?.({ added: [breakpoint], removed: [], changed: [] });

    await vi.waitFor(() => {
      expect(vscodeMockState.addBreakpoints).toHaveBeenCalledTimes(1);
    });
    const replacements = vscodeMockState.addBreakpoints.mock.calls[0]?.[0] as unknown[];
    const replacement = replacements[0] as InstanceType<typeof MockSourceBreakpoint> | undefined;
    expect(replacement?.location.uri.toString()).toBe(`debug:${SOURCE_PATH}?session=session-verified&ref=55`);
    expect(vscodeMockState.removeBreakpoints).toHaveBeenCalledWith([breakpoint]);
    await vi.waitFor(() => {
      expect(vscodeMockState.showTextDocument).toHaveBeenCalledWith(
        replacement?.location.uri,
        { preview: false, preserveFocus: false },
      );
    });
  });

  it('refreshes after the first verified session without waiting for slow sibling lookup', async () => {
    const appName = 'sample-service';
    const fileUri = createUri('file', SOURCE_PATH);
    const breakpoint = createBreakpoint(fileUri);
    const fastSession = createVerifyingSession('session-fast', { path: SOURCE_PATH, sourceReference: 0 });
    const slowLookup = createDeferred<unknown>();
    const slowSession: MockSession = {
      id: 'session-slow',
      name: 'Remote Process slow',
      type: 'pwa-node',
      customRequest: vi.fn((command: string): Promise<unknown> => {
        if (command === 'loadedSources') return slowLookup.promise;
        if (command === 'setBreakpoints') return Promise.resolve({ breakpoints: [{ verified: true }] });
        return Promise.resolve(undefined);
      }),
    };
    vscodeMockState.breakpoints = [breakpoint];
    debugSessionRegistryMockState.sessionsByApp.set(appName, [fastSession, slowSession]);
    packageSourceBrowserMockState.records.set(fileUri.toString(), {
      appName,
      uri: fileUri,
      source: {
        name: 'client.ts',
        path: SOURCE_PATH,
        sourceReference: 0,
      },
      sessionId: fastSession.id,
      sessionName: fastSession.name,
    });

    try {
      initializePackageBreakpointMirror();
      vscodeMockState.breakpointListener?.({ added: [breakpoint], removed: [], changed: [] });

      await vi.waitFor(() => {
        expect(fastSession.customRequest).toHaveBeenCalledWith('setBreakpoints', expect.any(Object));
      });
      expect(vscodeMockState.addBreakpoints).toHaveBeenCalledTimes(1);
    } finally {
      slowLookup.resolve({ sources: [] });
    }
  });
});
