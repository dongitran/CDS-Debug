import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockBreakpoint {
  enabled: boolean;
  location: {
    uri: { scheme: string; path: string; fsPath: string; query?: string };
    range: { start: { line: number; character: number } };
  };
}

interface MockDebugSession {
  customRequest: ReturnType<typeof vi.fn>;
}

type ProgressTask = () => Promise<void>;

interface BreakpointUriInit {
  scheme?: string;
  path?: string;
  fsPath?: string;
  query?: string;
}

const { vscodeMockState, cfClientMockState, MockSourceBreakpoint } = vi.hoisted(() => {
  class HoistedSourceBreakpoint {
    enabled: boolean;
    location: MockBreakpoint['location'];

    constructor(uriOrFsPath: string | BreakpointUriInit, enabled = true) {
      this.enabled = enabled;
      const uri = typeof uriOrFsPath === 'string'
        ? { scheme: 'file', path: uriOrFsPath, fsPath: uriOrFsPath }
        : {
          scheme: uriOrFsPath.scheme ?? 'file',
          path: uriOrFsPath.path ?? uriOrFsPath.fsPath ?? '',
          fsPath: uriOrFsPath.fsPath ?? uriOrFsPath.path ?? '',
          ...(uriOrFsPath.query !== undefined ? { query: uriOrFsPath.query } : {}),
        };
      this.location = {
        uri,
        range: { start: { line: 0, character: 0 } },
      };
    }
  }

  return {
    vscodeMockState: {
      settings: new Map<string, unknown>(),
      breakpoints: [] as unknown[],
      removeBreakpoints: vi.fn(),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      withProgress: vi.fn(),
      update: vi.fn(),
      openTextDocument: vi.fn(),
      showTextDocument: vi.fn(),
    },
    cfClientMockState: {
      cfRestartApp: vi.fn(),
    },
    MockSourceBreakpoint: HoistedSourceBreakpoint,
  };
});

vi.mock('../../src/core/cfClient', () => ({
  cfRestartApp: cfClientMockState.cfRestartApp,
}));

const debugSessionRegistryMockState = vi.hoisted(() => ({
  sessionsByApp: new Map<string, unknown[]>(),
}));

vi.mock('../../src/core/debugSessionRegistry', () => ({
  getDebugSessionsForApp: (appName: string): unknown[] => debugSessionRegistryMockState.sessionsByApp.get(appName) ?? [],
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: {
    Global: 1,
  },
  ProgressLocation: {
    Notification: 15,
  },
  Range: class MockRange {
    constructor(
      public readonly startLine: number,
      public readonly startCharacter: number,
      public readonly endLine: number,
      public readonly endCharacter: number,
    ) {}
  },
  Selection: class MockSelection {
    constructor(
      public readonly startLine: number,
      public readonly startCharacter: number,
      public readonly endLine: number,
      public readonly endCharacter: number,
    ) {}
  },
  SourceBreakpoint: MockSourceBreakpoint,
  debug: {
    get breakpoints() {
      return vscodeMockState.breakpoints;
    },
    removeBreakpoints: vscodeMockState.removeBreakpoints,
  },
  window: {
    showInformationMessage: vscodeMockState.showInformationMessage,
    showWarningMessage: vscodeMockState.showWarningMessage,
    withProgress: vscodeMockState.withProgress,
    showTextDocument: vscodeMockState.showTextDocument,
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => vscodeMockState.settings.get(key) ?? fallback,
      update: vscodeMockState.update,
    }),
    openTextDocument: vscodeMockState.openTextDocument,
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
}));

import {
  clearBreakpointsBeforeStop,
  handleRemoteInspectorAfterStop,
  notifyRemoteInspectorStillOpen,
  scanAndWarnForDebuggerLiterals,
} from '../../src/core/remoteInspectorCleanup';
// Real module (not mocked here) — drives the opened-package-URI registry that
// clearBreakpointsBeforeStop reads to recognize Package-browser file: URIs.
import {
  clearOpenedPackageUris,
  trackOpenedPackageUri,
} from '../../src/core/packageSourceBrowser';

interface TrackedFileUri {
  scheme: string;
  path: string;
  fsPath: string;
  toString(): string;
}

function makePackageFileUri(fsPath: string): TrackedFileUri {
  const raw = `file://${fsPath}`;
  return { scheme: 'file', path: fsPath, fsPath, toString: () => raw };
}

function loadedSourcesFor(path: string, ref: number): ReturnType<typeof vi.fn> {
  return vi.fn((command: string): Promise<unknown> => {
    if (command === 'loadedSources') {
      return Promise.resolve({ sources: [{ path, sourceReference: ref }] });
    }
    return Promise.resolve(undefined);
  });
}

function createSession(customRequest?: ReturnType<typeof vi.fn>): MockDebugSession {
  return {
    customRequest: customRequest ?? vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vscodeMockState.settings.clear();
  vscodeMockState.breakpoints = [];
  vscodeMockState.removeBreakpoints.mockReset();
  vscodeMockState.showInformationMessage.mockReset();
  vscodeMockState.showWarningMessage.mockReset();
  vscodeMockState.withProgress.mockImplementation((_options: unknown, task: ProgressTask) => task());
  vscodeMockState.update.mockResolvedValue(undefined);
  vscodeMockState.openTextDocument.mockResolvedValue({ uri: { fsPath: '/workspace/srv/sample.js' } });
  vscodeMockState.showTextDocument.mockResolvedValue({ selection: undefined, revealRange: vi.fn() });
  cfClientMockState.cfRestartApp.mockResolvedValue(undefined);
  debugSessionRegistryMockState.sessionsByApp.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('remoteInspectorCleanup notifications', () => {
  it('does not show the remote inspector reminder by default', async () => {
    await notifyRemoteInspectorStillOpen('default-quiet-app');

    expect(vscodeMockState.showInformationMessage).not.toHaveBeenCalled();
  });

  it('shows the remote inspector reminder when the setting is enabled', async () => {
    vscodeMockState.settings.set('warnRemoteInspectorAfterStop', true);
    vscodeMockState.showInformationMessage.mockResolvedValue(undefined);

    await notifyRemoteInspectorStillOpen('demo-app');

    expect(vscodeMockState.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('demo-app'),
      'Restart App',
      "Don't show again",
    );
  });

  it('does not show the remote inspector reminder when the setting is disabled', async () => {
    vscodeMockState.settings.set('warnRemoteInspectorAfterStop', false);

    await notifyRemoteInspectorStillOpen('quiet-app');

    expect(vscodeMockState.showInformationMessage).not.toHaveBeenCalled();
  });

  it('debounces the reminder per app for one minute', async () => {
    vscodeMockState.settings.set('warnRemoteInspectorAfterStop', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T10:00:00.000Z'));

    await notifyRemoteInspectorStillOpen('debounced-app');
    await notifyRemoteInspectorStillOpen('debounced-app');
    vi.setSystemTime(new Date('2026-05-09T10:01:01.000Z'));
    await notifyRemoteInspectorStillOpen('debounced-app');

    expect(vscodeMockState.showInformationMessage).toHaveBeenCalledTimes(2);
  });

  it('restarts the app when the reminder action is selected', async () => {
    vscodeMockState.settings.set('warnRemoteInspectorAfterStop', true);
    vscodeMockState.showInformationMessage.mockResolvedValue('Restart App');

    await notifyRemoteInspectorStillOpen('restartable-app');

    expect(cfClientMockState.cfRestartApp).toHaveBeenCalledWith('restartable-app');
    expect(vscodeMockState.withProgress).toHaveBeenCalledOnce();
  });

  it('writes the user-scope opt-out when the user disables future reminders', async () => {
    vscodeMockState.settings.set('warnRemoteInspectorAfterStop', true);
    vscodeMockState.showInformationMessage.mockResolvedValue("Don't show again");

    await notifyRemoteInspectorStillOpen('opt-out-app');

    expect(vscodeMockState.update).toHaveBeenCalledWith('warnRemoteInspectorAfterStop', false, 1);
  });

  it('auto-restarts after stop without showing the reminder when configured', async () => {
    vscodeMockState.settings.set('autoRestartAppAfterStop', true);

    await handleRemoteInspectorAfterStop('auto-restart-app');

    expect(cfClientMockState.cfRestartApp).toHaveBeenCalledWith('auto-restart-app');
    expect(vscodeMockState.showInformationMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('auto-restart-app'),
      'Restart App',
      "Don't show again",
    );
  });

  it('surfaces a warning when restart from the reminder fails', async () => {
    vscodeMockState.settings.set('warnRemoteInspectorAfterStop', true);
    vscodeMockState.showInformationMessage.mockResolvedValue('Restart App');
    cfClientMockState.cfRestartApp.mockRejectedValue(new Error('restart failed'));

    await notifyRemoteInspectorStillOpen('restart-fail-app');

    expect(vscodeMockState.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('failed to restart restart-fail-app'),
    );
  });
});

describe('clearBreakpointsBeforeStop', () => {
  it('sends empty setBreakpoints requests for each unique workspace source path', async () => {
    const session = createSession();
    vscodeMockState.breakpoints = [
      new MockSourceBreakpoint('/workspace/srv/sample.js'),
      new MockSourceBreakpoint('/workspace/srv/sample.js'),
      new MockSourceBreakpoint('/workspace/srv/other.ts'),
      new MockSourceBreakpoint('/outside/ignored.js'),
    ];

    await clearBreakpointsBeforeStop('demo-app', session as unknown as Parameters<typeof clearBreakpointsBeforeStop>[1]);

    expect(session.customRequest).toHaveBeenCalledTimes(2);
    expect(session.customRequest).toHaveBeenCalledWith('setBreakpoints', {
      source: { path: '/workspace/srv/sample.js' },
      breakpoints: [],
      sourceModified: false,
    });
    expect(session.customRequest).toHaveBeenCalledWith('setBreakpoints', {
      source: { path: '/workspace/srv/other.ts' },
      breakpoints: [],
      sourceModified: false,
    });
  });

  it('skips clearing when the setting is disabled', async () => {
    vscodeMockState.settings.set('clearRemoteBreakpointsBeforeStop', false);
    const session = createSession();
    vscodeMockState.breakpoints = [new MockSourceBreakpoint('/workspace/srv/sample.js')];

    await clearBreakpointsBeforeStop('disabled-app', session as unknown as Parameters<typeof clearBreakpointsBeforeStop>[1]);

    expect(session.customRequest).not.toHaveBeenCalled();
  });

  it('proceeds after the total timeout when the debug adapter hangs', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const customRequest = vi.fn().mockReturnValue(never);
    const session = createSession(customRequest);
    vscodeMockState.breakpoints = [new MockSourceBreakpoint('/workspace/srv/sample.js')];

    const clearing = clearBreakpointsBeforeStop('hanging-app', session as unknown as Parameters<typeof clearBreakpointsBeforeStop>[1]);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(clearing).resolves.toBeUndefined();
    expect(customRequest).toHaveBeenCalledOnce();
  });

  it('skips clearing when no debug session is available', async () => {
    vscodeMockState.breakpoints = [new MockSourceBreakpoint('/workspace/srv/sample.js')];

    await clearBreakpointsBeforeStop('missing-session-app', undefined);

    expect(vscodeMockState.showWarningMessage).not.toHaveBeenCalled();
  });

  it('clears via registry sessions when the root session reference is gone (external stop)', async () => {
    // Red-square stop: by the time the terminate event reaches the process manager the
    // root session is untracked, but child sessions linger briefly. The clear must use
    // them instead of bailing out on the undefined root reference.
    const childSession = createSession();
    debugSessionRegistryMockState.sessionsByApp.set('external-stop-app', [
      { id: 'child-id', customRequest: childSession.customRequest },
    ]);
    vscodeMockState.breakpoints = [new MockSourceBreakpoint('/workspace/srv/sample.js')];

    await clearBreakpointsBeforeStop('external-stop-app', undefined);

    expect(childSession.customRequest).toHaveBeenCalledWith('setBreakpoints', expect.objectContaining({
      source: { path: '/workspace/srv/sample.js' },
      breakpoints: [],
    }));
    debugSessionRegistryMockState.sessionsByApp.delete('external-stop-app');
  });

  it('removes dead Package-browser breakpoints from VS Code state when no session survives', async () => {
    clearOpenedPackageUris('dead-session-app');
    const deadUri = {
      scheme: 'debug',
      path: '/remote/node_modules/@sap/cds/lib/index.js',
      fsPath: '/remote/node_modules/@sap/cds/lib/index.js',
      query: 'session%3D9%26ref%3D7',
      toString: () => 'debug:/remote/node_modules/@sap/cds/lib/index.js?session%3D9%26ref%3D7',
    };
    trackOpenedPackageUri(
      'dead-session-app',
      deadUri as unknown as Parameters<typeof trackOpenedPackageUri>[1],
    );
    const orphan = new MockSourceBreakpoint({
      scheme: 'debug',
      path: '/remote/node_modules/@sap/cds/lib/index.js',
      fsPath: '/remote/node_modules/@sap/cds/lib/index.js',
      query: 'session%3D9%26ref%3D7',
    });
    (orphan.location.uri as { toString?: () => string }).toString = () => deadUri.toString();
    vscodeMockState.breakpoints = [orphan];

    await clearBreakpointsBeforeStop('dead-session-app', undefined);

    expect(vscodeMockState.removeBreakpoints).toHaveBeenCalledWith([orphan]);
  });

  it('clears debug-URI breakpoints across every tracked session of the app and removes them from VS Code state', async () => {
    // Reproduces the Package browser case: a `.ts` file opened from node_modules that the
    // local workspace does not have. `asDebugSourceUri` produced a `debug:` URI tagged with
    // the deepest session, but vscode-js-debug bound the breakpoint inside a child session
    // because CAP auto-attaches workers. Pre-fix, the URI fell outside the workspace so the
    // setBreakpoints clear was never sent, and the orphan breakpoint persisted after stop
    // (forcing a `cf restart`). The fix broadcasts the clear to every app session and drops
    // the orphan from VS Code state.
    const rootSession = createSession();
    const childSession = createSession();
    debugSessionRegistryMockState.sessionsByApp.set('multi-session-app', [
      { id: 'root-id', customRequest: rootSession.customRequest },
      { id: 'child-id', customRequest: childSession.customRequest },
    ]);

    const debugBreakpoint = new MockSourceBreakpoint({
      scheme: 'debug',
      path: '/home/vcap/app/node_modules/@sap/cds/lib/server.ts',
      fsPath: '/home/vcap/app/node_modules/@sap/cds/lib/server.ts',
      query: 'session=child-id&ref=17',
    });
    vscodeMockState.breakpoints = [
      new MockSourceBreakpoint('/workspace/srv/sample.js'),
      debugBreakpoint,
    ];

    await clearBreakpointsBeforeStop('multi-session-app', rootSession as unknown as Parameters<typeof clearBreakpointsBeforeStop>[1]);

    // Workspace path goes to the root session once.
    expect(rootSession.customRequest).toHaveBeenCalledWith('setBreakpoints', {
      source: { path: '/workspace/srv/sample.js' },
      breakpoints: [],
      sourceModified: false,
    });
    // Path-only clear is broadcast to every tracked session — including the child where
    // the breakpoint was actually bound by vscode-js-debug.
    const pathOnlyMatcher = ['setBreakpoints', {
      source: { path: '/home/vcap/app/node_modules/@sap/cds/lib/server.ts' },
      breakpoints: [],
      sourceModified: false,
    }] as const;
    expect(rootSession.customRequest).toHaveBeenCalledWith(...pathOnlyMatcher);
    expect(childSession.customRequest).toHaveBeenCalledWith(...pathOnlyMatcher);

    // Critical: the original setBreakpoints from VS Code carried sourceReference, so
    // vscode-js-debug bound the breakpoint by ref. The path-only clear above would NOT
    // match in that case — we must mirror the original descriptor to the tagged session
    // (child-id), and only there because sourceReference is session-scoped.
    expect(childSession.customRequest).toHaveBeenCalledWith('setBreakpoints', {
      source: {
        path: '/home/vcap/app/node_modules/@sap/cds/lib/server.ts',
        sourceReference: 17,
      },
      breakpoints: [],
      sourceModified: false,
    });
    expect(rootSession.customRequest).not.toHaveBeenCalledWith('setBreakpoints', {
      source: expect.objectContaining({ sourceReference: 17 }) as unknown,
      breakpoints: [],
      sourceModified: false,
    });

    // Orphan debug-URI breakpoint dropped from VS Code state so it cannot leak into the
    // next session.
    expect(vscodeMockState.removeBreakpoints).toHaveBeenCalledWith([debugBreakpoint]);
  });

  it("uses each session's own sourceReference for the same logical source", async () => {
    // vscode-js-debug assigns a session-scoped sourceReference to each loaded source.
    // The same `.ts` loaded in parent + child sessions has DIFFERENT sourceReferences.
    // The clear request to each session must use that session's own reference; sending
    // the URI's reference (which only matches the tagged session) to a sibling would
    // silently miss and leave the breakpoint registered in the Node inspector — exactly
    // the bug the user reported when CAP spawns multiple `Remote Process [N]` workers.
    const remotePath = '/Users/dongtran/Documents/brain/node_modules/.pnpm/x/server.ts';

    function customRequestForSession(ref: number): (command: string) => Promise<unknown> {
      return (command: string): Promise<unknown> => {
        if (command === 'loadedSources') {
          return Promise.resolve({ sources: [{ path: remotePath, sourceReference: ref }] });
        }
        return Promise.resolve(undefined);
      };
    }

    const rootSession = createSession(vi.fn(customRequestForSession(11)));
    const childSession = createSession(vi.fn(customRequestForSession(22)));

    debugSessionRegistryMockState.sessionsByApp.set('worker-spawning-app', [
      { id: 'root-id', name: 'root', customRequest: rootSession.customRequest },
      { id: 'child-id', name: 'child', customRequest: childSession.customRequest },
    ]);

    vscodeMockState.breakpoints = [
      new MockSourceBreakpoint({
        scheme: 'debug',
        path: remotePath,
        // URI was minted by child session; ref 22 only valid there.
        query: 'session=child-id&ref=22',
      }),
    ];

    await clearBreakpointsBeforeStop(
      'worker-spawning-app',
      rootSession as unknown as Parameters<typeof clearBreakpointsBeforeStop>[1],
    );

    // Root session must receive a clear keyed by ITS OWN ref (11), even though the URI
    // carries the child's ref (22). The reverse-lookup via loadedSources is what makes
    // this work.
    expect(rootSession.customRequest).toHaveBeenCalledWith('setBreakpoints', {
      source: { path: remotePath, sourceReference: 11 },
      breakpoints: [],
      sourceModified: false,
    });
    // Child session uses its own ref 22 too (matches URI's tagged ref in this case).
    expect(childSession.customRequest).toHaveBeenCalledWith('setBreakpoints', {
      source: { path: remotePath, sourceReference: 22 },
      breakpoints: [],
      sourceModified: false,
    });
    // The clear keyed by the URI's ref must NOT be sent to root (the wrong descriptor
    // would silently match the wrong source — or no source at all).
    expect(rootSession.customRequest).not.toHaveBeenCalledWith('setBreakpoints', {
      source: { path: remotePath, sourceReference: 22 },
      breakpoints: [],
      sourceModified: false,
    });
  });

  it('leaves debug-URI breakpoints tagged with a foreign session alone', async () => {
    const session = createSession();
    debugSessionRegistryMockState.sessionsByApp.set('owned-app', [
      { id: 'owned-id', customRequest: session.customRequest },
    ]);

    const foreignBreakpoint = new MockSourceBreakpoint({
      scheme: 'debug',
      path: '/home/vcap/app/foreign.ts',
      query: 'session=someone-else&ref=99',
    });
    vscodeMockState.breakpoints = [foreignBreakpoint];

    await clearBreakpointsBeforeStop('owned-app', session as unknown as Parameters<typeof clearBreakpointsBeforeStop>[1]);

    // Neither cleared nor removed — would surprise users who set the breakpoint via a
    // different extension/session.
    expect(session.customRequest).not.toHaveBeenCalled();
    expect(vscodeMockState.removeBreakpoints).not.toHaveBeenCalled();
  });

  it("clears a tracked package file: URI by each session's own sourceReference and keeps it in VS Code state", async () => {
    // The Package browser materialized a `.ts` under node_modules and opened it as a `file:`
    // URI. VS Code binds it by the LOCAL fsPath, but the breakpoint mirror also bound the
    // Node inspector by the ORIGINAL remote source path + each session's own sourceReference.
    // A path-only fsPath clear (the legacy behavior) misses those ref-bound copies, leaving
    // the inspector paused until `cf restart`. The fix must broadcast a ref-keyed clear for
    // the remote path to every session, and must NOT drop the breakpoint from VS Code state
    // because the local file still exists and stays valid for the next session.
    const fsPath = '/home/me/code/node_modules/.pnpm/sample-kit@1/node_modules/sample-kit/dist/client.ts';
    const remotePath = '/home/vcap/app/node_modules/.pnpm/sample-kit@1/node_modules/sample-kit/dist/client.ts';
    const uri = makePackageFileUri(fsPath);

    clearOpenedPackageUris('pkg-file-app');
    trackOpenedPackageUri(
      'pkg-file-app',
      uri as unknown as Parameters<typeof trackOpenedPackageUri>[1],
      { path: remotePath, sourceReference: 7 },
    );

    const breakpoint = new MockSourceBreakpoint(fsPath);
    (breakpoint as unknown as { location: { uri: TrackedFileUri } }).location.uri = uri;
    vscodeMockState.breakpoints = [breakpoint];

    const rootRequest = loadedSourcesFor(remotePath, 7);
    const childRequest = loadedSourcesFor(remotePath, 13);
    debugSessionRegistryMockState.sessionsByApp.set('pkg-file-app', [
      { id: 'root-id', name: 'root', customRequest: rootRequest },
      { id: 'child-id', name: 'child', customRequest: childRequest },
    ]);

    try {
      await clearBreakpointsBeforeStop(
        'pkg-file-app',
        { customRequest: rootRequest } as unknown as Parameters<typeof clearBreakpointsBeforeStop>[1],
      );

      // Each session receives a clear keyed by ITS OWN reference for the remote source path.
      expect(rootRequest).toHaveBeenCalledWith('setBreakpoints', {
        source: { path: remotePath, sourceReference: 7 },
        breakpoints: [],
        sourceModified: false,
      });
      expect(childRequest).toHaveBeenCalledWith('setBreakpoints', {
        source: { path: remotePath, sourceReference: 13 },
        breakpoints: [],
        sourceModified: false,
      });
      // Path-only fallback for the remote path is broadcast to every session too.
      expect(rootRequest).toHaveBeenCalledWith('setBreakpoints', {
        source: { path: remotePath },
        breakpoints: [],
        sourceModified: false,
      });
      // The wrong-session reference must NOT be sent to root (would silently miss/mismatch).
      expect(rootRequest).not.toHaveBeenCalledWith('setBreakpoints', {
        source: { path: remotePath, sourceReference: 13 },
        breakpoints: [],
        sourceModified: false,
      });
      // file: package breakpoint is kept — the local file still exists.
      expect(vscodeMockState.removeBreakpoints).not.toHaveBeenCalled();
    } finally {
      clearOpenedPackageUris('pkg-file-app');
    }
  });
});

describe('scanAndWarnForDebuggerLiterals', () => {
  it('opens the first debugger literal match from the warning action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cds-debug-literal-warning-'));
    await writeFile(join(root, 'sample.js'), 'debugger;\n', 'utf8');
    vscodeMockState.showWarningMessage.mockResolvedValue('Open First Match');

    try {
      await scanAndWarnForDebuggerLiterals('literal-app', root, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(vscodeMockState.openTextDocument).toHaveBeenCalledWith(join(root, 'sample.js'));
    expect(vscodeMockState.showTextDocument).toHaveBeenCalledOnce();
  });

  it('logs all debugger literal matches when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cds-debug-literal-warning-'));
    const channel = { appendLine: vi.fn() };
    await writeFile(join(root, 'sample.js'), 'debugger;\n', 'utf8');
    vscodeMockState.showWarningMessage.mockResolvedValue('Show All');

    try {
      await scanAndWarnForDebuggerLiterals('show-all-app', root, 1, channel as unknown as Parameters<typeof scanAndWarnForDebuggerLiterals>[3]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('show-all-app debugger; literal matches'));
    expect(channel.appendLine).toHaveBeenCalledWith(expect.stringContaining('sample.js:1 debugger;'));
  });

  it('skips the literal scan when the setting is disabled', async () => {
    vscodeMockState.settings.set('warnDebuggerLiteralOnAttach', false);

    await scanAndWarnForDebuggerLiterals('disabled-scan-app', '/missing', 1);

    expect(vscodeMockState.showWarningMessage).not.toHaveBeenCalled();
  });
});
