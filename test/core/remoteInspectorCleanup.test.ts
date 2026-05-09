import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockBreakpoint {
  enabled: boolean;
  location: {
    uri: { fsPath: string };
    range: { start: { line: number; character: number } };
  };
}

interface MockDebugSession {
  customRequest: ReturnType<typeof vi.fn>;
}

type ProgressTask = () => Promise<void>;

const { vscodeMockState, cfClientMockState, MockSourceBreakpoint } = vi.hoisted(() => {
  class HoistedSourceBreakpoint {
    enabled: boolean;
    location: MockBreakpoint['location'];

    constructor(fsPath: string, enabled = true) {
      this.enabled = enabled;
      this.location = {
        uri: { fsPath },
        range: { start: { line: 0, character: 0 } },
      };
    }
  }

  return {
    vscodeMockState: {
      settings: new Map<string, unknown>(),
      breakpoints: [] as unknown[],
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

function createSession(customRequest?: ReturnType<typeof vi.fn>): MockDebugSession {
  return {
    customRequest: customRequest ?? vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vscodeMockState.settings.clear();
  vscodeMockState.breakpoints = [];
  vscodeMockState.showInformationMessage.mockReset();
  vscodeMockState.showWarningMessage.mockReset();
  vscodeMockState.withProgress.mockImplementation((_options: unknown, task: ProgressTask) => task());
  vscodeMockState.update.mockResolvedValue(undefined);
  vscodeMockState.openTextDocument.mockResolvedValue({ uri: { fsPath: '/workspace/srv/sample.js' } });
  vscodeMockState.showTextDocument.mockResolvedValue({ selection: undefined, revealRange: vi.fn() });
  cfClientMockState.cfRestartApp.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('remoteInspectorCleanup notifications', () => {
  it('shows the remote inspector reminder when the setting is enabled', async () => {
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-09T10:00:00.000Z'));

    await notifyRemoteInspectorStillOpen('debounced-app');
    await notifyRemoteInspectorStillOpen('debounced-app');
    vi.setSystemTime(new Date('2026-05-09T10:01:01.000Z'));
    await notifyRemoteInspectorStillOpen('debounced-app');

    expect(vscodeMockState.showInformationMessage).toHaveBeenCalledTimes(2);
  });

  it('restarts the app when the reminder action is selected', async () => {
    vscodeMockState.showInformationMessage.mockResolvedValue('Restart App');

    await notifyRemoteInspectorStillOpen('restartable-app');

    expect(cfClientMockState.cfRestartApp).toHaveBeenCalledWith('restartable-app');
    expect(vscodeMockState.withProgress).toHaveBeenCalledOnce();
  });

  it('writes the user-scope opt-out when the user disables future reminders', async () => {
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
