import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockUri {
  scheme: string;
  path: string;
  fsPath: string;
  query: string;
  toString(): string;
}

interface MockTab {
  input: { uri: MockUri };
  group: { viewColumn: number };
}

interface MockSession {
  id: string;
  name: string;
}

interface MockDebugAdapterTracker {
  onDidSendMessage?(message: unknown): void;
  onWillStopSession?(): void;
}

interface MockDebugAdapterTrackerFactory {
  createDebugAdapterTracker(session: MockSession): MockDebugAdapterTracker | undefined;
}

interface MockRange {
  start: {
    line: number;
    character: number;
  };
}

const {
  MockUriClass,
  MockLocation,
  MockSourceBreakpoint,
  vscodeMockState,
  packageSourceBrowserMockState,
  debugSessionRegistryMockState,
  processManagerMockState,
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
    MockUriClass: HoistedUri,
    MockLocation: HoistedLocation,
    MockSourceBreakpoint: HoistedSourceBreakpoint,
    vscodeMockState: {
      openedTabListener: undefined as undefined | ((event: { opened: MockTab[] }) => void),
      trackerFactory: undefined as undefined | MockDebugAdapterTrackerFactory,
      tabGroupsAll: [] as { tabs: MockTab[] }[],
      closeTab: vi.fn(),
      showTextDocument: vi.fn(),
      breakpoints: [] as unknown[],
      addBreakpoints: vi.fn(),
      removeBreakpoints: vi.fn(),
    },
    packageSourceBrowserMockState: {
      appByPath: new Map<string, string>(),
      openedByApp: new Map<string, MockUri[]>(),
      trackOpenedPackageUri: vi.fn(),
      unregisterOpenedPackageUri: vi.fn(),
    },
    debugSessionRegistryMockState: {
      sessionsByApp: new Map<string, MockSession[]>(),
    },
    processManagerMockState: {
      appendLine: vi.fn(),
    },
  };
});

vi.mock('vscode', () => ({
  SourceBreakpoint: MockSourceBreakpoint,
  Uri: MockUriClass,
  Location: MockLocation,
  window: {
    tabGroups: {
      get all(): { tabs: MockTab[] }[] {
        return vscodeMockState.tabGroupsAll;
      },
      onDidChangeTabs: (listener: (event: { opened: MockTab[] }) => void) => {
        vscodeMockState.openedTabListener = listener;
        return { dispose: vi.fn() };
      },
      close: vscodeMockState.closeTab,
    },
    showTextDocument: vscodeMockState.showTextDocument,
    createOutputChannel: () => ({
      appendLine: () => undefined,
      append: () => undefined,
      clear: () => undefined,
      dispose: () => undefined,
      show: () => undefined,
    }),
  },
  debug: {
    get breakpoints(): unknown[] {
      return vscodeMockState.breakpoints;
    },
    addBreakpoints: vscodeMockState.addBreakpoints,
    removeBreakpoints: vscodeMockState.removeBreakpoints,
    registerDebugAdapterTrackerFactory: (_pattern: string, factory: MockDebugAdapterTrackerFactory) => {
      vscodeMockState.trackerFactory = factory;
      return { dispose: vi.fn() };
    },
  },
}));

vi.mock('../../src/core/debugSessionRegistry', () => ({
  getDebugSessionsForApp: (appName: string): MockSession[] =>
    debugSessionRegistryMockState.sessionsByApp.get(appName) ?? [],
}));

vi.mock('../../src/core/packageSourceBrowser', () => ({
  extractSessionIdFromDebugUri: (uri: MockUri): string | null => {
    const params = new URLSearchParams(uri.query);
    return params.get('session');
  },
  findAppForOpenedPath: (path: string): string | undefined =>
    packageSourceBrowserMockState.appByPath.get(path),
  getOpenedPackageUris: (appName: string): MockUri[] =>
    packageSourceBrowserMockState.openedByApp.get(appName)?.slice() ?? [],
  trackOpenedPackageUri: (appName: string, uri: MockUri): void => {
    packageSourceBrowserMockState.trackOpenedPackageUri(appName, uri);
    const existing = packageSourceBrowserMockState.openedByApp.get(appName) ?? [];
    packageSourceBrowserMockState.openedByApp.set(appName, [...existing, uri]);
  },
  unregisterOpenedPackageUri: (appName: string, uri: MockUri): void => {
    packageSourceBrowserMockState.unregisterOpenedPackageUri(appName, uri);
    const existing = packageSourceBrowserMockState.openedByApp.get(appName) ?? [];
    packageSourceBrowserMockState.openedByApp.set(
      appName,
      existing.filter((candidate) => candidate.toString() !== uri.toString()),
    );
  },
}));

vi.mock('../../src/core/processManager', () => ({
  getProcessOutputChannel: () => ({
    appendLine: processManagerMockState.appendLine,
  }),
}));

vi.mock('../../src/core/logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import {
  disposePackageTabDeduplicator,
  initializePackageTabDeduplicator,
} from '../../src/core/packageTabDeduplicator';

function createUri(scheme: 'debug' | 'file', path: string, query = ''): MockUri {
  const raw = scheme === 'debug'
    ? `debug:${path}${query ? `?${query}` : ''}`
    : `file://${path}`;
  return new MockUriClass(raw, scheme, path, path, query);
}

function createTab(uri: MockUri, viewColumn = 1): MockTab {
  return {
    input: { uri },
    group: { viewColumn },
  };
}

function createBreakpoint(uri: MockUri): InstanceType<typeof MockSourceBreakpoint> {
  return new MockSourceBreakpoint(
    new MockLocation(uri, { start: { line: 9, character: 2 } }),
  );
}

beforeEach(() => {
  vscodeMockState.openedTabListener = undefined;
  vscodeMockState.trackerFactory = undefined;
  vscodeMockState.tabGroupsAll = [];
  vscodeMockState.closeTab.mockReset().mockResolvedValue(true);
  vscodeMockState.showTextDocument.mockReset().mockResolvedValue(undefined);
  vscodeMockState.breakpoints = [];
  vscodeMockState.addBreakpoints.mockReset();
  vscodeMockState.removeBreakpoints.mockReset();
  packageSourceBrowserMockState.appByPath.clear();
  packageSourceBrowserMockState.openedByApp.clear();
  packageSourceBrowserMockState.trackOpenedPackageUri.mockReset();
  packageSourceBrowserMockState.unregisterOpenedPackageUri.mockReset();
  debugSessionRegistryMockState.sessionsByApp.clear();
  processManagerMockState.appendLine.mockReset();
});

afterEach(() => {
  disposePackageTabDeduplicator();
});

describe('packageTabDeduplicator', () => {
  it('focuses the canonical package tab and closes a non-paused duplicate', async () => {
    const appName = 'sample-service';
    const sourcePath = '/workspace/node_modules/sample-client/dist/client.js';
    const canonical = createUri('file', sourcePath);
    const duplicate = createUri('debug', sourcePath, 'session=session-a&ref=42');
    const duplicateTab = createTab(duplicate, 2);
    vscodeMockState.tabGroupsAll = [{ tabs: [createTab(canonical), duplicateTab] }];
    packageSourceBrowserMockState.appByPath.set(sourcePath, appName);
    packageSourceBrowserMockState.openedByApp.set(appName, [canonical]);
    debugSessionRegistryMockState.sessionsByApp.set(appName, [{ id: 'session-a', name: 'Debug: sample-service' }]);

    initializePackageTabDeduplicator();
    vscodeMockState.openedTabListener?.({ opened: [duplicateTab] });

    await vi.waitFor(() => {
      expect(vscodeMockState.showTextDocument).toHaveBeenCalledWith(canonical, {
        preview: false,
        viewColumn: 2,
        preserveFocus: false,
      });
    });
    expect(packageSourceBrowserMockState.trackOpenedPackageUri).toHaveBeenCalledWith(appName, duplicate);
    expect(vscodeMockState.closeTab).toHaveBeenCalledWith(duplicateTab, false);
    expect(vscodeMockState.addBreakpoints).not.toHaveBeenCalled();
  });

  it('promotes a live paused duplicate to canonical and migrates breakpoints', async () => {
    const appName = 'sample-service';
    const sourcePath = '/workspace/node_modules/sample-client/src/client.ts';
    const oldCanonical = createUri('debug', sourcePath, 'session=session-old&ref=7');
    const liveUri = createUri('debug', sourcePath, 'session=session-live&ref=11');
    const oldTab = createTab(oldCanonical);
    const liveTab = createTab(liveUri, 3);
    const breakpoint = createBreakpoint(oldCanonical);
    vscodeMockState.tabGroupsAll = [{ tabs: [oldTab, liveTab] }];
    vscodeMockState.breakpoints = [breakpoint];
    packageSourceBrowserMockState.appByPath.set(sourcePath, appName);
    packageSourceBrowserMockState.openedByApp.set(appName, [oldCanonical]);
    debugSessionRegistryMockState.sessionsByApp.set(appName, [
      { id: 'session-old', name: 'Remote Process [0]' },
      { id: 'session-live', name: 'Remote Process [1]' },
    ]);

    initializePackageTabDeduplicator();
    const tracker = vscodeMockState.trackerFactory?.createDebugAdapterTracker({
      id: 'session-live',
      name: 'Remote Process [0]',
    });
    tracker?.onDidSendMessage?.({ type: 'event', event: 'stopped' });
    vscodeMockState.openedTabListener?.({ opened: [liveTab] });

    await vi.waitFor(() => {
      expect(vscodeMockState.addBreakpoints).toHaveBeenCalledTimes(1);
    });
    const replacements = vscodeMockState.addBreakpoints.mock.calls[0]?.[0] as unknown[];
    const replacement = replacements[0] as InstanceType<typeof MockSourceBreakpoint> | undefined;
    expect(replacement?.location.uri.toString()).toBe(liveUri.toString());
    expect(replacement?.location.range).toEqual(breakpoint.location.range);
    expect(vscodeMockState.removeBreakpoints).toHaveBeenCalledWith([breakpoint]);
    expect(packageSourceBrowserMockState.unregisterOpenedPackageUri).toHaveBeenCalledWith(appName, oldCanonical);
    expect(packageSourceBrowserMockState.trackOpenedPackageUri).toHaveBeenCalledWith(appName, liveUri);
    expect(vscodeMockState.closeTab).toHaveBeenCalledWith(oldTab, false);
    expect(vscodeMockState.showTextDocument).toHaveBeenCalledWith(liveUri, {
      preview: false,
      viewColumn: 3,
      preserveFocus: false,
    });
  });
});
