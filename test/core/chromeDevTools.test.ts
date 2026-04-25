import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface MockUri {
  raw: string;
  strict: boolean;
}

interface InspectorServer {
  server: Server;
  port: number;
}

const { vscodeMockState } = vi.hoisted(() => ({
  vscodeMockState: {
    openExternal: vi.fn(),
    parse: vi.fn((raw: string, strict: boolean): MockUri => ({ raw, strict })),
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  },
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

afterEach(async () => {
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

  it('returns null when inspector metadata is unavailable or invalid', async () => {
    const { port } = await createInspectorServer({
      '/json/list': { body: '{not json' },
      '/json': { body: 'not found', statusCode: 404 },
    });

    await expect(resolveChromeDevToolsUrl(port)).resolves.toBeNull();
  });

  it('opens the resolved Chrome DevTools URL through VS Code', async () => {
    const { port } = await createInspectorServer({
      '/json/list': { body: JSON.stringify([{ id: 'target-to-open' }]) },
    });

    await expect(openChromeDevTools(port, 'demo-app')).resolves.toBe(true);

    const expectedUrl = `devtools://devtools/bundled/inspector.html?ws=localhost:${port.toString()}/target-to-open`;
    expect(vscodeMockState.parse).toHaveBeenCalledWith(expectedUrl, true);
    expect(vscodeMockState.openExternal).toHaveBeenCalledWith({ raw: expectedUrl, strict: true });
  });

  it('does not open Chrome DevTools when no inspector target is found', async () => {
    const { port } = await createInspectorServer({
      '/json/list': { body: '[]' },
      '/json': { body: '[]' },
    });

    await expect(openChromeDevTools(port, 'demo-app')).resolves.toBe(false);

    expect(vscodeMockState.parse).not.toHaveBeenCalled();
    expect(vscodeMockState.openExternal).not.toHaveBeenCalled();
  });
});
