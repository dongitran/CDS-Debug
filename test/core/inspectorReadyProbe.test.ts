import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { waitInspectorReady } from '../../src/core/inspectorReadyProbe';

interface HandlerContext {
  request: IncomingMessage;
  response: ServerResponse;
  attempt: number;
}

type Handler = (ctx: HandlerContext) => void;

interface RunningServer {
  port: number;
  attempts(): number;
  close(): Promise<void>;
}

async function startServer(handler: Handler): Promise<RunningServer> {
  let attempts = 0;
  const server: Server = createServer((request, response) => {
    attempts += 1;
    handler({ request, response, attempt: attempts });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('Server did not bind a port.');
  return {
    port: address.port,
    attempts: () => attempts,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err); else resolve();
      });
    }),
  };
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    probe.close((err) => {
      if (err) reject(err); else resolve();
    });
  });
  return port;
}

const VALID_TARGET_LIST_JSON = JSON.stringify([
  {
    description: '',
    id: 'abc',
    title: 'node[1]',
    type: 'node',
    url: 'file:///home/vcap/app/index.js',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abc',
  },
]);

let running: RunningServer | undefined;

beforeEach(() => {
  running = undefined;
});

afterEach(async () => {
  if (running) {
    await running.close();
    running = undefined;
  }
});

describe('waitInspectorReady', () => {
  it('returns true when /json/list contains a target with a webSocketDebuggerUrl', async () => {
    running = await startServer(({ response }) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(VALID_TARGET_LIST_JSON);
    });

    await expect(waitInspectorReady(running.port, 2_000, 50)).resolves.toBe(true);
    expect(running.attempts()).toBe(1);
  });

  it('treats an empty /json/list (inspector up, no target yet) as not-ready and retries', async () => {
    running = await startServer(({ response, attempt }) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      // Inspector HTTP is up but no debuggable execution context exists yet, then one
      // appears on the third probe.
      response.end(attempt < 3 ? '[]' : VALID_TARGET_LIST_JSON);
    });

    await expect(waitInspectorReady(running.port, 2_000, 50)).resolves.toBe(true);
    expect(running.attempts()).toBeGreaterThanOrEqual(3);
  });

  it('retries while the local listener is missing and times out to false', async () => {
    const port = await findFreePort();
    const startedAt = Date.now();

    await expect(waitInspectorReady(port, 300, 50)).resolves.toBe(false);

    // Loose timing check: the timeout governs the total wait, not the per-probe failure.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
  });

  it('treats non-200 responses as not-ready and retries until timeout', async () => {
    running = await startServer(({ response }) => {
      response.writeHead(404);
      response.end();
    });

    await expect(waitInspectorReady(running.port, 250, 50)).resolves.toBe(false);
    expect(running.attempts()).toBeGreaterThan(1);
  });

  it('rejects 200 responses that do not parse as inspector metadata', async () => {
    running = await startServer(({ response }) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('hello');
    });

    await expect(waitInspectorReady(running.port, 250, 50)).resolves.toBe(false);
  });

  it('rejects 200 JSON that is not a target array (e.g. /json/version object)', async () => {
    running = await startServer(({ response }) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ Browser: 'node.js/v20.11.0', webSocketDebuggerUrl: 'ws://x' }));
    });

    await expect(waitInspectorReady(running.port, 250, 50)).resolves.toBe(false);
  });

  it('rejects a target array whose entries lack a webSocketDebuggerUrl', async () => {
    running = await startServer(({ response }) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify([{ id: 'x', type: 'node' }]));
    });

    await expect(waitInspectorReady(running.port, 250, 50)).resolves.toBe(false);
  });

  it('treats a connection reset (simulating SSH channel reject) as not-ready and retries until ready', async () => {
    // Match the SSH "channel reject" behavior where local TCP accept succeeds but
    // the SSH server immediately closes the forwarded channel because remote 9229
    // is not listening yet. The probe must keep retrying until the inspector responds.
    running = await startServer(({ request, response, attempt }) => {
      if (attempt < 3) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(VALID_TARGET_LIST_JSON);
    });

    await expect(waitInspectorReady(running.port, 2_000, 50)).resolves.toBe(true);
    expect(running.attempts()).toBeGreaterThanOrEqual(3);
  });

  it('bails out early when shouldContinue() returns false', async () => {
    const port = await findFreePort();
    let firstCheck = true;
    const result = await waitInspectorReady(port, 5_000, 50, () => {
      if (firstCheck) {
        firstCheck = false;
        return true;
      }
      return false;
    });

    expect(result).toBe(false);
  });
});
