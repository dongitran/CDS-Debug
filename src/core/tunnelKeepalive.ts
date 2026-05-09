import type * as vscode from 'vscode';
import { logInfo, logWarn } from './logger';

const FAILURE_LIMIT = 3;

export type TunnelKeepaliveDispose = () => void;

export function startTunnelKeepalive(
  session: vscode.DebugSession,
  appName: string,
  intervalSeconds: number,
  onFailure: () => void,
): TunnelKeepaliveDispose {
  if (intervalSeconds <= 0) return () => undefined;

  const intervalMs = Math.max(5, Math.min(60, intervalSeconds)) * 1000;
  let disposed = false;
  let inFlight = false;
  let consecutiveFailures = 0;

  const timer = setInterval(() => {
    if (disposed || inFlight) return;
    inFlight = true;
    const startedAt = Date.now();
    void Promise.resolve(session.customRequest('threads', {}))
      .then(() => {
        const latencyMs = Date.now() - startedAt;
        consecutiveFailures = 0;
        logInfo(`[${appName}] Inspector keepalive succeeded in ${latencyMs.toString()}ms.`);
      })
      .catch((err: unknown) => {
        consecutiveFailures += 1;
        const message = err instanceof Error ? err.message : String(err);
        logWarn(`[${appName}] Inspector keepalive failed (${consecutiveFailures.toString()}/${FAILURE_LIMIT.toString()}): ${message}`);
        if (consecutiveFailures >= FAILURE_LIMIT && !disposed) {
          disposed = true;
          clearInterval(timer);
          onFailure();
        }
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);

  return () => {
    disposed = true;
    clearInterval(timer);
  };
}
