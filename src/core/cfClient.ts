import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CfApp, CfRegion } from '../types/index';
import { CF_DEFAULT_SPACE, CF_REGION_ENDPOINTS } from '../types/index';

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

async function runCf(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync('cf', args, {
      env: { ...process.env, ...env },
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException & { stderr?: string };
    throw new CfCliError(
      error.message,
      error.stderr?.trim() ?? '',
    );
  }
}

export async function cfLogin(region: CfRegion, email: string, password: string): Promise<void> {
  const apiEndpoint = CF_REGION_ENDPOINTS[region];
  await runCf(['login', '-a', apiEndpoint, '--skip-ssl-validation'], {
    CF_USERNAME: email,
    CF_PASSWORD: password,
  });
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

export async function cfOrgs(): Promise<string[]> {
  const stdout = await runCf(['orgs']);
  return parseOrgs(stdout);
}

export async function cfTarget(org: string, space = CF_DEFAULT_SPACE): Promise<void> {
  await runCf(['target', '-o', org, '-s', space]);
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
      return [{ name, state: state === 'started' ? 'started' : 'stopped' } satisfies CfApp];
    });
}

export async function cfApps(): Promise<CfApp[]> {
  const stdout = await runCf(['apps']);
  return parseApps(stdout);
}

export async function cfTargetAndApps(org: string): Promise<CfApp[]> {
  await cfTarget(org);
  return cfApps();
}
