import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockUri {
  raw: string;
  strict: boolean;
}

interface InspectorServer {
  server: Server;
  port: number;
}

interface MockSpawnChild extends EventEmitter {
  unref: ReturnType<typeof vi.fn>;
}

type SpawnOutcome = 'spawn' | 'error';

interface SpawnCall {
  command: string;
  args: string[];
  options: unknown;
}

const { childProcessMockState, vscodeMockState } = vi.hoisted(() => ({
  childProcessMockState: {
    calls: [] as SpawnCall[],
    children: [] as MockSpawnChild[],
    outcomes: [] as SpawnOutcome[],
    spawn: vi.fn<(command: string, args?: readonly string[], options?: unknown) => MockSpawnChild>(),
  },
  vscodeMockState: {
    openExternal: vi.fn(),
    parse: vi.fn((raw: string, strict: boolean): MockUri => ({ raw, strict })),
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: childProcessMockState.spawn,
}));

vi.mock('vscode', () => ({
  env: {
    openExternal: vscodeMockState.openExternal,
  },
  Uri: {
    parse: vscodeMockState.parse,
  },
  window: {
    createOutputChannel: () => ({
      appendLine: vscodeMockState.appendLine,
      show: vscodeMockState.show,
      dispose: vscodeMockState.dispose,
    }),
  },
}));

import {
  buildChromeDevToolsUrl,
  extractInspectorTargetId,
  getChromeLaunchCommands,
  launchChromeDevToolsUrl,
  openChromeDevTools,
  resolveChromeDevToolsUrl,
} from '../../src/core/chromeDevTools';

const servers: Server[] = [];

async function createInspectorServer(responses: Record<string, { body: string; statusCode?: number }>): Promise<InspectorServer> {
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    const response = responses[path] ?? { body: 'not found', statusCode: 404 };
    res.statusCode = response.statusCode ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(response.body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Inspector test server did not expose a TCP port.');
  }
  servers.push(server);
  return { server, port: address.port };
}

function configureSpawnMock(): void {
  childProcessMockState.spawn.mockImplementation((command, args = [], options) => {
    const child = new EventEmitter() as MockSpawnChild;
    child.unref = vi.fn();
    childProcessMockState.calls.push({ command, args: [...args], options });
    childProcessMockState.children.push(child);

    const outcome = childProcessMockState.outcomes.shift() ?? 'spawn';
    queueMicrotask(() => {
      if (outcome === 'error') {
        child.emit('error', new Error(`Failed to spawn ${command}`));
        return;
      }
      child.emit('spawn');
    });

    return child;
  });
}

function setSpawnOutcomes(...outcomes: SpawnOutcome[]): void {
  childProcessMockState.outcomes.splice(0, childProcessMockState.outcomes.length, ...outcomes);
}

afterEach(async () => {
  childProcessMockState.calls.length = 0;
  childProcessMockState.children.length = 0;
  childProcessMockState.outcomes.length = 0;
  childProcessMockState.spawn.mockReset();
  vscodeMockState.openExternal.mockReset();
  vscodeMockState.parse.mockClear();
  vscodeMockState.appendLine.mockClear();
  vscodeMockState.show.mockClear();
  vscodeMockState.dispose.mockClear();

  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  })));
});

describe('chromeDevTools', () => {
  beforeEach(() => {
    configureSpawnMock();
  });

  it('builds the Chrome DevTools inspector URL for a local debug port', () => {
    expect(buildChromeDevToolsUrl(9229, 'cb1e6a12-36e8-4dea-8768-1d050964db35')).toBe(
      'devtools://devtools/bundled/inspector.html?ws=localhost:9229/cb1e6a12-36e8-4dea-8768-1d050964db35',
    );
  });

  it('extracts the inspector target id from Node inspector metadata', () => {
    expect(extractInspectorTargetId([{ id: 'target-from-id' }])).toBe('target-from-id');
    expect(extractInspectorTargetId([
      { webSocketDebuggerUrl: 'ws://127.0.0.1:20000/target-from-websocket' },
    ])).toBe('target-from-websocket');
  });

  it('skips malformed inspector targets and uses compatible frontend URLs', () => {
    expect(extractInspectorTargetId(null)).toBeNull();
    expect(extractInspectorTargetId([
      null,
      { id: '' },
      { webSocketDebuggerUrl: 'not a url' },
      { devtoolsFrontendUrlCompat: 'devtools://devtools/bundled/inspector.html?ws=localhost:20000/target-from-compat' },
    ])).toBe('target-from-compat');
  });

  it('resolves the Chrome DevTools URL from /json/list metadata', async () => {
    const { port } = await createInspectorServer({
      '/json/list': { body: JSON.stringify([{ id: 'target-from-list' }]) },
    });

    await expect(resolveChromeDevToolsUrl(port)).resolves.toBe(
      `devtools://devtools/bundled/inspector.html?ws=localhost:${port.toString()}/target-from-list`,
    );
  });

  it('falls back to /json when /json/list does not return a target', async () => {
    const { port } = await createInspectorServer({
      '/json/list': { body: '[]' },
      '/json': { body: JSON.stringify([{ id: 'target-from-json' }]) },
    });

    await expect(resolveChromeDevToolsUrl(port)).resolves.toBe(
      `devtools://devtools/bundled/inspector.html?ws=localhost:${port.toString()}/target-from-json`,
    );
  });

  it('builds Windows Chrome commands that pass the DevTools URL directly to Chrome', () => {
    const url = buildChromeDevToolsUrl(9229, 'target-from-windows');

    expect(getChromeLaunchCommands(url, {
      env: {
        LOCALAPPDATA: 'C:\\Users\\eliot\\AppData\\Local',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      },
      platform: 'win32',
    })).toEqual([
      { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '""', 'chrome', `"${url}"`] },
      { command: 'chrome.exe', args: [url] },
      { command: 'C:\\Users\\eliot\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe', args: [url] },
      { command: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: [url] },
      { command: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', args: [url] },
    ]);
  });

  it('builds macOS Chrome commands equivalent to cds debug', () => {
    const url = buildChromeDevToolsUrl(9229, 'target-from-macos');

    expect(getChromeLaunchCommands(url, { env: {}, platform: 'darwin' })).toEqual([
      { command: 'open', args: ['-a', 'Google Chrome', url] },
    ]);
  });

  it('builds Linux Chrome and Chromium commands', () => {
    const url = buildChromeDevToolsUrl(9229, 'target-from-linux');

    expect(getChromeLaunchCommands(url, { env: {}, platform: 'linux' })).toEqual([
      { command: 'google-chrome', args: [url] },
      { command: 'google-chrome-stable', args: [url] },
      { command: 'chromium-browser', args: [url] },
      { command: 'chromium', args: [url] },
    ]);
  });

  it('adds a safe Windows Chrome fallback when running from WSL', () => {
    const url = buildChromeDevToolsUrl(9229, 'target-from-wsl');

    expect(getChromeLaunchCommands(url, {
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      platform: 'linux',
    }).slice(4)).toEqual([
      { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '""', 'chrome', `"${url}"`] },
      { command: '/mnt/c/Windows/System32/cmd.exe', args: ['/d', '/s', '/c', 'start', '""', 'chrome', `"${url}"`] },
      { command: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', args: [url] },
      { command: '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe', args: [url] },
    ]);
  });

  it('does not add command-shell fallbacks for unsafe DevTools URLs', () => {
    const url = 'devtools://devtools/bundled/inspector.html?ws=localhost:9229/target&bad';

    expect(getChromeLaunchCommands(url, { env: {}, platform: 'win32' })).toEqual([
      { command: 'chrome.exe', args: [url] },
    ]);
  });

  it('returns null when inspector metadata is unavailable or invalid', async () => {
    const { port } = await createInspectorServer({
      '/json/list': { body: '{not json' },
      '/json': { body: 'not found', statusCode: 404 },
    });

    await expect(resolveChromeDevToolsUrl(port)).resolves.toBeNull();
  });

  it('tries the next Chrome command when a candidate cannot be spawned', async () => {
    const url = buildChromeDevToolsUrl(9229, 'target-with-fallback');
    setSpawnOutcomes('error', 'spawn');

    await expect(launchChromeDevToolsUrl(url, [
      { command: 'missing-chrome', args: [url] },
      { command: 'chrome.exe', args: [url] },
    ])).resolves.toBe(true);

    expect(childProcessMockState.calls.map((call) => call.command)).toEqual(['missing-chrome', 'chrome.exe']);
    expect(childProcessMockState.calls[0]?.options).toMatchObject({
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    expect(childProcessMockState.children[1]?.unref).toHaveBeenCalledOnce();
  });

  it('returns false when every Chrome command fails', async () => {
    const url = buildChromeDevToolsUrl(9229, 'target-without-browser');
    setSpawnOutcomes('error', 'error');

    await expect(launchChromeDevToolsUrl(url, [
      { command: 'missing-chrome', args: [url] },
      { command: 'missing-chromium', args: [url] },
    ])).resolves.toBe(false);

    expect(childProcessMockState.calls.map((call) => call.command)).toEqual(['missing-chrome', 'missing-chromium']);
  });

  it('opens the resolved Chrome DevTools URL by launching Chrome directly', async () => {
    const { port } = await createInspectorServer({
      '/json/list': { body: JSON.stringify([{ id: 'target-to-open' }]) },
    });

    await expect(openChromeDevTools(port, 'demo-app')).resolves.toBe(true);

    const expectedUrl = `devtools://devtools/bundled/inspector.html?ws=localhost:${port.toString()}/target-to-open`;
    expect(childProcessMockState.calls[0]).toMatchObject({ args: expect.arrayContaining([expectedUrl]) });
    expect(vscodeMockState.parse).not.toHaveBeenCalled();
    expect(vscodeMockState.openExternal).not.toHaveBeenCalled();
  });

  it('does not open Chrome DevTools when no inspector target is found', async () => {
    const { port } = await createInspectorServer({
      '/json/list': { body: '[]' },
      '/json': { body: '[]' },
    });

    await expect(openChromeDevTools(port, 'demo-app')).resolves.toBe(false);

    expect(vscodeMockState.parse).not.toHaveBeenCalled();
    expect(vscodeMockState.openExternal).not.toHaveBeenCalled();
    expect(childProcessMockState.spawn).not.toHaveBeenCalled();
  });
});
