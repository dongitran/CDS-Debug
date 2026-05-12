import { execFile } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_PORT_FREE_TIMEOUT_MS = 3_000;
const PORT_FREE_PROBE_INTERVAL_MS = 100;
const PORT_PROBE_SOCKET_TIMEOUT_MS = 200;

type PortProbeResult = 'open' | 'free' | 'unknown';

export async function killProcessOnPort(port: number): Promise<void> {
  const portStr = port.toString();
  if (process.platform === 'win32') {
    await killWindowsProcessOnPort(portStr);
    return;
  }

  await killUnixProcessOnPort(portStr);
}

export async function waitPortFree(port: number, timeoutMs = DEFAULT_PORT_FREE_TIMEOUT_MS): Promise<boolean> {
  return waitForPortState(
    port,
    timeoutMs,
    PORT_FREE_PROBE_INTERVAL_MS,
    (result) => result === 'free',
  );
}

export async function cleanupPort(port: number, timeoutMs = DEFAULT_PORT_FREE_TIMEOUT_MS): Promise<boolean> {
  await killProcessOnPort(port);
  return waitPortFree(port, timeoutMs);
}

async function killWindowsProcessOnPort(portStr: string): Promise<void> {
  try {
    const { stdout } = await execFileText('netstat', ['-ano']);
    const pidsToKill = parseWindowsListenerPids(stdout, portStr);
    for (const pid of pidsToKill) {
      await killWindowsPid(pid);
    }
  } catch {
    // netstat may be missing or the port may already be free.
  }
}

function parseWindowsListenerPids(stdout: string, portStr: string): number[] {
  const pidsToKill = new Set<number>();
  for (const line of stdout.split('\n')) {
    if (!line.includes(`:${portStr}`) || !line.includes('LISTENING')) continue;

    const parts = line.trim().split(/\s+/);
    const lastPart = parts[parts.length - 1];
    if (!lastPart) continue;

    const pid = Number.parseInt(lastPart, 10);
    if (!Number.isNaN(pid)) pidsToKill.add(pid);
  }
  return [...pidsToKill];
}

async function killWindowsPid(pid: number): Promise<void> {
  try {
    // cspell:ignore taskkill
    await execFileText('taskkill', ['/F', '/PID', pid.toString()]);
  } catch {
    // Process may have already exited.
  }
}

async function killUnixProcessOnPort(portStr: string): Promise<void> {
  try {
    const { stdout } = await execFileText('lsof', ['-t', '-i', `tcp:${portStr}`]);
    for (const pidStr of stdout.trim().split('\n').filter(Boolean)) {
      const pid = Number.parseInt(pidStr, 10);
      if (Number.isNaN(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process may have already exited.
      }
    }
  } catch {
    // lsof may be missing or the port may already be free.
  }
}

function execFileText(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(error instanceof Error ? error : new Error('execFile failed.'));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function waitForPortState(
  port: number,
  timeoutMs: number,
  intervalMs: number,
  isTargetState: (result: PortProbeResult) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const result = await probeLocalPort(port);
    if (isTargetState(result)) return true;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;

    await delay(Math.min(intervalMs, remainingMs));
  }
}

function probeLocalPort(port: number): Promise<PortProbeResult> {
  return new Promise<PortProbeResult>((resolve) => {
    let socket: Socket | undefined;
    let settled = false;

    const finish = (result: PortProbeResult): void => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(result);
    };

    try {
      socket = createConnection({ port, host: '127.0.0.1' });
    } catch {
      resolve('unknown');
      return;
    }

    socket.setTimeout(PORT_PROBE_SOCKET_TIMEOUT_MS);
    socket.once('connect', () => { finish('open'); });
    socket.once('timeout', () => { finish('unknown'); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'free' : 'unknown');
    });
  });
}
