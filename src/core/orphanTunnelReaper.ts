// cspell:ignore pgrep taskkill powershell CimInstance CommandLine ProcessId CreationDate lstart
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { logInfo, logWarn } from './logger';

export interface ActiveTunnelEntry {
  appName: string;
  pid: number;
  port: number;
  startedAt: number;
  ownerPid: number;
}

export interface ReapOrphanCfSshTunnelsOptions {
  globalStoragePath?: string;
  graceMs?: number;
  killGraceMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
}

export interface ReapOrphanCfSshTunnelsResult {
  killed: number[];
  skipped: number[];
}

interface ReapCandidate {
  pid: number;
  startedAt: number;
}

interface RegistryReadResult {
  safe: boolean;
  entries: ActiveTunnelEntry[];
}

const REGISTRY_FILE_NAME = 'active-tunnels.json';
const UNIX_TUNNEL_PATTERN = 'cf ssh .* -L [0-9]+:localhost:9229';
const WINDOWS_TUNNEL_PATTERN = /\bcf(?:\.exe)?\s+ssh\b.*\s-L\s+\d+:localhost:9229\b/i;
const DEFAULT_GRACE_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

let tunnelRegistryStoragePath: string | undefined;

export function initializeTunnelRegistry(globalStoragePath: string): void {
  tunnelRegistryStoragePath = globalStoragePath;
}

export async function registerActiveTunnel(entry: ActiveTunnelEntry): Promise<void> {
  const storagePath = tunnelRegistryStoragePath;
  if (storagePath === undefined) return;

  const registry = await readRegistry(storagePath);
  if (!registry.safe) return;

  const next = registry.entries.filter((item) => item.appName !== entry.appName && item.pid !== entry.pid);
  next.push({ ...entry });
  await writeRegistry(storagePath, next);
}

export async function unregisterActiveTunnel(appNameOrPid: string | number): Promise<void> {
  const storagePath = tunnelRegistryStoragePath;
  if (storagePath === undefined) return;

  const registry = await readRegistry(storagePath);
  if (!registry.safe) return;

  const next = registry.entries.filter((item) => (
    typeof appNameOrPid === 'string' ? item.appName !== appNameOrPid : item.pid !== appNameOrPid
  ));
  await writeRegistry(storagePath, next);
}

export async function reapOrphanCfSshTunnels(
  options: ReapOrphanCfSshTunnelsOptions = {},
): Promise<ReapOrphanCfSshTunnelsResult> {
  const storagePath = options.globalStoragePath ?? tunnelRegistryStoragePath;
  const registry = storagePath === undefined ? { safe: true, entries: [] } : await readRegistry(storagePath);
  if (!registry.safe) return { killed: [], skipped: [] };

  const platform = options.platform ?? process.platform;
  const candidates = platform === 'win32'
    ? await listWindowsCandidates()
    : await listUnixCandidates();

  return reapCandidates(candidates, registry.entries, {
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
    killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    now: options.now ?? Date.now,
    platform,
  });
}

async function reapCandidates(
  candidates: ReapCandidate[],
  registryEntries: ActiveTunnelEntry[],
  options: Required<Pick<ReapOrphanCfSshTunnelsOptions, 'graceMs' | 'killGraceMs' | 'now' | 'platform'>>,
): Promise<ReapOrphanCfSshTunnelsResult> {
  const killed: number[] = [];
  const skipped: number[] = [];
  const registryByPid = new Map(registryEntries.map((entry) => [entry.pid, entry]));

  for (const candidate of candidates) {
    if (options.now() - candidate.startedAt < options.graceMs) {
      skipped.push(candidate.pid);
      continue;
    }
    if (isOwnedByLiveProcess(registryByPid.get(candidate.pid))) {
      skipped.push(candidate.pid);
      continue;
    }
    await killCandidate(candidate.pid, options);
    killed.push(candidate.pid);
    await unregisterActiveTunnel(candidate.pid);
  }

  logInfo(`[TunnelReaper] killed ${killed.length.toString()} orphan tunnel(s), skipped ${skipped.length.toString()}.`);
  return { killed, skipped };
}

function isOwnedByLiveProcess(entry: ActiveTunnelEntry | undefined): boolean {
  if (entry === undefined) return false;
  return isProcessAlive(entry.ownerPid);
}

async function listUnixCandidates(): Promise<ReapCandidate[]> {
  let stdout: string;
  try {
    stdout = (await execFileText('pgrep', ['-f', UNIX_TUNNEL_PATTERN])).stdout;
  } catch {
    return [];
  }

  const candidates: ReapCandidate[] = [];
  for (const pid of parsePidLines(stdout)) {
    const startedAt = await readUnixProcessStart(pid);
    if (startedAt !== null) candidates.push({ pid, startedAt });
  }
  return candidates;
}

function parsePidLines(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function readUnixProcessStart(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileText('ps', ['-o', 'lstart=', '-p', pid.toString()]);
    const startedAt = Date.parse(stdout.trim());
    return Number.isNaN(startedAt) ? null : startedAt;
  } catch {
    return null;
  }
}

async function listWindowsCandidates(): Promise<ReapCandidate[]> {
  let stdout: string;
  try {
    stdout = (await execFileText('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process -Filter "Name = \'cf.exe\'" | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress',
    ])).stdout;
  } catch {
    return [];
  }

  return parseWindowsProcessJson(stdout)
    .filter((item) => WINDOWS_TUNNEL_PATTERN.test(item.commandLine))
    .flatMap((item) => {
      const startedAt = Date.parse(item.creationDate);
      return Number.isNaN(startedAt) ? [] : [{ pid: item.pid, startedAt }];
    });
}

interface WindowsProcessInfo {
  pid: number;
  commandLine: string;
  creationDate: string;
}

function parseWindowsProcessJson(stdout: string): WindowsProcessInfo[] {
  if (stdout.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.flatMap((item) => parseWindowsProcessInfo(item));
  } catch (err: unknown) {
    logWarn(`[TunnelReaper] Failed to parse Windows process list: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function parseWindowsProcessInfo(value: unknown): WindowsProcessInfo[] {
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const pid = readWindowsPid(record.ProcessId);
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (typeof record.CommandLine !== 'string' || typeof record.CreationDate !== 'string') return [];
  return [{ pid, commandLine: record.CommandLine, creationDate: normalizeWindowsDate(record.CreationDate) }];
}

function readWindowsPid(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseInt(value, 10);
  return Number.NaN;
}

function normalizeWindowsDate(value: string): string {
  const epochMatch = /^\/Date\((\d+)\)\/$/.exec(value);
  if (epochMatch?.[1] !== undefined) {
    return new Date(Number.parseInt(epochMatch[1], 10)).toISOString();
  }
  return value;
}

async function killCandidate(
  pid: number,
  options: Required<Pick<ReapOrphanCfSshTunnelsOptions, 'killGraceMs' | 'platform'>>,
): Promise<void> {
  if (options.platform === 'win32') {
    await execFileText('taskkill', ['/F', '/T', '/PID', pid.toString()]).catch(() => undefined);
    return;
  }
  killUnixProcessGroup(pid, 'SIGTERM');
  if (options.killGraceMs > 0) await delay(options.killGraceMs);
  if (isProcessAlive(pid)) killUnixProcessGroup(pid, 'SIGKILL');
}

function killUnixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process may have already exited.
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readRegistry(storagePath: string): Promise<RegistryReadResult> {
  try {
    const raw = await readFile(registryPath(storagePath), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return unsafeRegistry('registry root is not an array');
    return { safe: true, entries: parsed.flatMap((item) => parseRegistryEntry(item)) };
  } catch (err: unknown) {
    if (isFileMissingError(err)) return { safe: true, entries: [] };
    return unsafeRegistry(err instanceof Error ? err.message : String(err));
  }
}

function unsafeRegistry(reason: string): RegistryReadResult {
  logWarn(`[TunnelReaper] Active tunnel registry is unreadable; skipping orphan reap. ${reason}`);
  return { safe: false, entries: [] };
}

function parseRegistryEntry(value: unknown): ActiveTunnelEntry[] {
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  if (typeof record.appName !== 'string') return [];
  const pid = readPositiveInteger(record.pid);
  const port = readPositiveInteger(record.port);
  const startedAt = readPositiveInteger(record.startedAt);
  const ownerPid = readPositiveInteger(record.ownerPid);
  if (pid === null || port === null || startedAt === null || ownerPid === null) return [];
  return [{ appName: record.appName, pid, port, startedAt, ownerPid }];
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

async function writeRegistry(storagePath: string, entries: ActiveTunnelEntry[]): Promise<void> {
  await mkdir(storagePath, { recursive: true });
  const target = registryPath(storagePath);
  const tmp = `${target}.${process.pid.toString()}.${Date.now().toString()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  await rename(tmp, target).catch(async (err: unknown) => {
    await unlink(tmp).catch(() => undefined);
    throw err;
  });
}

function registryPath(storagePath: string): string {
  return join(storagePath, REGISTRY_FILE_NAME);
}

function isFileMissingError(err: unknown): boolean {
  return typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
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
