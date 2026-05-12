import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_PROBE_INTERVAL_MS = 500;
const PROBE_REQUEST_TIMEOUT_MS = 2_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

// Probes the Node inspector HTTP endpoint through the local end of the SSH tunnel.
// A plain TCP "is port listening" probe was insufficient because `cf ssh -L` binds the
// local port the moment the SSH session is up — even when the remote inspector on 9229
// has not yet finished initializing. Hitting `/json/version` exercises the forwarded
// channel end-to-end, so success means the remote inspector is reachable and ready.
export async function waitInspectorReady(
  port: number,
  timeoutMs: number,
  intervalMs: number = DEFAULT_PROBE_INTERVAL_MS,
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (!shouldContinue()) return false;

    const isReady = await probeInspectorOnce(port);
    if (isReady) return true;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;

    await delay(Math.min(intervalMs, remainingMs));
  }
}

function probeInspectorOnce(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/json/version',
        method: 'GET',
        timeout: PROBE_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish(false);
          return;
        }
        let received = 0;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          received += Buffer.byteLength(chunk);
          if (received > MAX_RESPONSE_BYTES) {
            res.destroy();
            finish(false);
            return;
          }
          body += chunk;
        });
        res.on('end', () => { finish(looksLikeInspectorMetadata(body)); });
        res.on('error', () => { finish(false); });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.on('error', () => { finish(false); });
    req.end();
  });
}

function looksLikeInspectorMetadata(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return false;
    // Node inspector `/json/version` returns an object including at least "Browser"
    // (e.g. "node.js/v20.11.0") and "webSocketDebuggerUrl". We accept either field as
    // proof the response came from the inspector and not from some other HTTP server.
    return 'Browser' in parsed || 'webSocketDebuggerUrl' in parsed;
  } catch {
    return false;
  }
}
