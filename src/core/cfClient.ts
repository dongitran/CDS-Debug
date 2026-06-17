import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CfApp, CfAppState } from '../types/index';
import { CF_DEFAULT_SPACE } from '../types/index';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024;
// Hard cap on any CF CLI invocation. Without a timeout, a hung auth-server token
// refresh or slow CF API response keeps execFileAsync pending forever — the caller
// never gets an error, so the extension appears frozen (e.g. "Preparing…" stuck).
// 30 s is generous for quick, operational commands (logout, ssh-enabled, scale,
// app routes); cfRestartApp uses its own 120 s limit.
const CF_CLI_TIMEOUT_MS = 30_000;
// Longer cap for the topology/data-loading commands (orgs, spaces, target, apps).
// On the first selection of a fresh org/space — and on high-latency CF regions or
// a slow network — `cf apps` (and the `cf target` that precedes it) can legitimately
// take minutes before the CF API answers. The previous 30 s cap killed the process
// with SIGTERM mid-fetch, surfacing as "CF CLI command failed." and an app list that
// loaded briefly then vanished. 10 minutes covers the verified worst case while still
// guaranteeing the caller eventually gets an error instead of hanging forever.
const CF_LOAD_TIMEOUT_MS = 600_000;
const REMOTE_PACKAGE_JSON_FIND_COMMAND = [
  'find / -maxdepth 7',
  "\\( -path '*/node_modules' -o -path /proc -o -path /sys -o -path /dev \\) -prune -o",
  '-type f',
  '-name package.json',
  '-print 2>/dev/null',
].join(' ');

export class CfCliError extends Error {
  public readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'CfCliError';
    this.stderr = stderr;
  }
}

export function isCfAuthError(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const stderr = err instanceof CfCliError ? err.stderr.toLowerCase() : '';
  const combined = `${message} ${stderr}`;
  return (
    combined.includes('authentication failed') ||
    combined.includes('credentials were rejected') ||
    combined.includes('invalid email or password') ||
    combined.includes('invalid credentials') ||
    combined.includes('password has expired') ||
    combined.includes('account is locked') ||
    combined.includes('invalid_grant') ||
    combined.includes('unauthorized') ||
    combined.includes('not authorized')
  );
}

// cfHome: when provided, sets CF_HOME so this invocation uses an isolated config
// directory instead of the default ~/.cf — used by the background cache sync to
// avoid clobbering the user's interactive CF session.
async function runCf(args: string[], cfHome?: string, timeoutMs: number = CF_CLI_TIMEOUT_MS): Promise<string> {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (cfHome) env.CF_HOME = cfHome;
    const { stdout } = await execFileAsync('cf', args, { env, maxBuffer: MAX_BUFFER, timeout: timeoutMs });
    return stdout;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { stderr?: string };
    throw new CfCliError(
      buildCfCliErrorMessage(error),
      error.stderr?.trim() ?? '',
    );
  }
}

function buildCfCliErrorMessage(error: NodeJS.ErrnoException & { stderr?: string }): string {
  const rawMessage = error.message.trim() || 'CF CLI command failed.';
  const stderr = error.stderr?.trim() ?? '';
  if (!rawMessage.startsWith('Command failed: cf ')) return rawMessage;
  return stderr || 'CF CLI command failed.';
}

const CF_AUTH_RETRIES = 3;

interface InstanceCounts {
  runningInstances: number;
  totalInstances: number;
  instanceProcessCount?: number;
}

export async function cfLogin(
  apiEndpoint: string,
  email: string,
  password: string,
  cfHome?: string,
): Promise<void> {
  await runCf(['api', apiEndpoint], cfHome);
  let lastError: unknown;
  for (let attempt = 0; attempt <= CF_AUTH_RETRIES; attempt++) {
    try {
      await runCf(['auth', email, password], cfHome);
      return;
    } catch (err: unknown) {
      lastError = err;
      if (isCfAuthError(err)) throw err;
      if (attempt < CF_AUTH_RETRIES) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

export function parseOrgs(stdout: string): string[] {
  const lines = stdout.split('\n');
  const headerIdx = lines.findIndex((line) => line.trim() === 'name');
  if (headerIdx === -1) return [];
  return lines
    .slice(headerIdx + 1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function cfOrgs(cfHome?: string): Promise<string[]> {
  const stdout = await runCf(['orgs'], cfHome, CF_LOAD_TIMEOUT_MS);
  return parseOrgs(stdout);
}

export async function cfLogout(cfHome?: string): Promise<void> {
  await runCf(['logout'], cfHome);
}

export async function cfTargetOrg(org: string, cfHome?: string): Promise<void> {
  await runCf(['target', '-o', org], cfHome, CF_LOAD_TIMEOUT_MS);
}

export async function cfTarget(org: string, space = CF_DEFAULT_SPACE, cfHome?: string): Promise<void> {
  await runCf(['target', '-o', org, '-s', space], cfHome, CF_LOAD_TIMEOUT_MS);
}

export function parseSpaces(stdout: string): string[] {
  return parseOrgs(stdout);
}

export async function cfSpaces(cfHome?: string): Promise<string[]> {
  const stdout = await runCf(['spaces'], cfHome, CF_LOAD_TIMEOUT_MS);
  return parseSpaces(stdout);
}

export async function cfTargetOrgAndSpaces(org: string, cfHome?: string): Promise<string[]> {
  await cfTargetOrg(org, cfHome);
  return cfSpaces(cfHome);
}

export function parseApps(stdout: string): CfApp[] {
  const lines = stdout.split('\n');
  const headerIdx = lines.findIndex((line) => line.includes('requested state'));
  if (headerIdx === -1) return [];
  return lines
    .slice(headerIdx + 1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const parts = line.split(/\s{2,}/);
      const name = parts[0]?.trim();
      const state = parts[1]?.trim();
      if (!name || !state) return [];

      let urls: string[] = [];
      const maybeUrls = parts[parts.length - 1];
      if (maybeUrls?.includes('.')) {
        urls = maybeUrls.split(',').map((u) => u.trim());
      }

      const instanceCounts = parseInstanceCounts(parts[2]?.trim());
      let parsedState: CfAppState = 'stopped';
      if (state === 'started') {
        const runningCount = instanceCounts?.runningInstances ?? 0;
        parsedState = runningCount > 0 ? 'started' : 'empty';
      }

      return [{ name, state: parsedState, ...(instanceCounts ?? {}), urls } satisfies CfApp];
    });
}

function parseInstanceCounts(value: string | undefined): InstanceCounts | undefined {
  if (!value) return undefined;

  const namedProcessRegex = /(?:^|[,\s])([A-Za-z0-9_.-]+):(\d+)\/(\d+)/g;
  let runningInstances = 0;
  let totalInstances = 0;
  let instanceProcessCount = 0;
  let match: RegExpExecArray | null;

  while ((match = namedProcessRegex.exec(value)) !== null) {
    const runningRaw = match[2];
    const totalRaw = match[3];
    if (runningRaw === undefined || totalRaw === undefined) continue;
    instanceProcessCount += 1;
    runningInstances += Number.parseInt(runningRaw, 10);
    totalInstances += Number.parseInt(totalRaw, 10);
  }

  if (instanceProcessCount > 0) {
    return { runningInstances, totalInstances, instanceProcessCount };
  }

  const legacyRegex = /(?:^|\b)(\d+)\/(\d+)/g;
  let legacyMatched = false;
  while ((match = legacyRegex.exec(value)) !== null) {
    const runningRaw = match[1];
    const totalRaw = match[2];
    if (runningRaw === undefined || totalRaw === undefined) continue;
    legacyMatched = true;
    runningInstances += Number.parseInt(runningRaw, 10);
    totalInstances += Number.parseInt(totalRaw, 10);
  }

  return legacyMatched ? { runningInstances, totalInstances } : undefined;
}

export async function cfApps(cfHome?: string): Promise<CfApp[]> {
  const stdout = await runCf(['apps'], cfHome, CF_LOAD_TIMEOUT_MS);
  return parseApps(stdout);
}

export async function cfTargetAndApps(
  org: string,
  space = CF_DEFAULT_SPACE,
  cfHome?: string,
): Promise<CfApp[]> {
  await cfTarget(org, space, cfHome);
  return cfApps(cfHome);
}

/**
 * Extracts the mapped routes from `cf app <name>` output. Used as a fallback by
 * the App Watchdog when neither the synced topology nor the app cache carries a
 * route for the app being debugged.
 */
export function parseAppRoutes(stdout: string): string[] {
  for (const line of stdout.split('\n')) {
    const match = /^routes:\s*(.+)$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      return match[1]
        .split(',')
        .map((route) => route.trim())
        .filter((route) => route.length > 0);
    }
  }
  return [];
}

export async function cfAppRoutes(appName: string, cfHome?: string): Promise<string[]> {
  const stdout = await runCf(['app', appName], cfHome);
  return parseAppRoutes(stdout);
}

export async function cfScaleAppInstances(appName: string, instances: number, cfHome?: string): Promise<void> {
  if (!Number.isInteger(instances) || instances < 0) {
    throw new Error('Instance count must be a non-negative integer.');
  }
  await runCf(['scale', appName, '-i', instances.toString()], cfHome);
}

export async function cfFindRemotePackageJsonPaths(appName: string, cfHome?: string): Promise<string[]> {
  const stdout = await runCf(['ssh', appName, '-c', REMOTE_PACKAGE_JSON_FIND_COMMAND], cfHome);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function cfSshEnabled(appName: string, cfHome?: string): Promise<boolean> {
  try {
    const stdout = await runCf(['ssh-enabled', appName], cfHome);
    // Must check for the full phrase — 'disabled' contains 'enabled' as a substring
    return stdout.toLowerCase().includes('ssh support is enabled');
  } catch {
    // cf ssh-enabled exits non-zero when disabled
    return false;
  }
}

export async function cfEnableSsh(appName: string, cfHome?: string): Promise<void> {
  await runCf(['enable-ssh', appName], cfHome);
}

const RESTART_TIMEOUT_MS = 120_000;

export async function cfRestartApp(appName: string, cfHome?: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (cfHome) env.CF_HOME = cfHome;
  try {
    await execFileAsync('cf', ['restart', appName], {
      env,
      maxBuffer: MAX_BUFFER,
      timeout: RESTART_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { stderr?: string };
    throw new CfCliError(
      error.message,
      error.stderr?.trim() ?? '',
    );
  }
}
