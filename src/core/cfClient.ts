import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CfApp, CfAppState } from '../types/index';
import { CF_DEFAULT_SPACE } from '../types/index';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024;

export class CfCliError extends Error {
  public readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'CfCliError';
    this.stderr = stderr;
  }
}

// cfHome: when provided, sets CF_HOME so this invocation uses an isolated config
// directory instead of the default ~/.cf — used by the background cache sync to
// avoid clobbering the user's interactive CF session.
async function runCf(args: string[], cfHome?: string): Promise<string> {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (cfHome) env.CF_HOME = cfHome;
    const { stdout } = await execFileAsync('cf', args, { env, maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { stderr?: string };
    throw new CfCliError(
      error.message,
      error.stderr?.trim() ?? '',
    );
  }
}

const CF_AUTH_RETRIES = 3;

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
  const stdout = await runCf(['orgs'], cfHome);
  return parseOrgs(stdout);
}

export async function cfLogout(cfHome?: string): Promise<void> {
  await runCf(['logout'], cfHome);
}

export async function cfTarget(org: string, space = CF_DEFAULT_SPACE, cfHome?: string): Promise<void> {
  await runCf(['target', '-o', org, '-s', space], cfHome);
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

      let parsedState: CfAppState = 'stopped';
      if (state === 'started') {
        const instancesPart = parts[2]?.trim();
        let runningCount = 0;
        if (instancesPart) {
          const regex = /(?:^|\b)(\d+)\/\d+/g;
          let match: RegExpExecArray | null;
          while ((match = regex.exec(instancesPart)) !== null) {
            runningCount += parseInt(match[1] ?? '0', 10);
          }
        }
        parsedState = runningCount > 0 ? 'started' : 'empty';
      }

      return [{ name, state: parsedState, urls } satisfies CfApp];
    });
}

export async function cfApps(cfHome?: string): Promise<CfApp[]> {
  const stdout = await runCf(['apps'], cfHome);
  return parseApps(stdout);
}

export async function cfTargetAndApps(org: string, cfHome?: string): Promise<CfApp[]> {
  await cfTarget(org, undefined, cfHome);
  return cfApps(cfHome);
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
