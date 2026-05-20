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

function createBreakpoint(uri: MockUri): InstanceType<typeof MockSourceBreakpoint> {
  return new MockSourceBreakpoint(
    new vscodeMockState.Location(uri, { start: { line: 4, character: 2 } }),
  );
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

  it('does not promote path-only package breakpoints when the debugger source path is already a URI', async () => {
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
    expect(vscodeMockState.asDebugSourceUri).not.toHaveBeenCalled();
    expect(vscodeMockState.addBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.removeBreakpoints).not.toHaveBeenCalled();
    expect(vscodeMockState.showTextDocument).not.toHaveBeenCalled();
  });
});
