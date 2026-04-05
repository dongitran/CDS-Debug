import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logInfo, logWarn } from './logger';

const execFileAsync = promisify(execFile);

// Cache the result so subsequent calls are instant.
let _cachedShellEnv: NodeJS.ProcessEnv | null = null;

/**
 * Spawns the user's login shell and reads its full environment.
 *
 * WHY THIS IS NEEDED:
 * When VS Code is opened from the macOS Dock or Spotlight (not from a
 * terminal), the Extension Host process is spawned by launchd and inherits
 * only the system-level environment — shell init files (.zprofile, .zshrc,
 * .bash_profile) are NEVER sourced. So process.env will be missing any
 * variables the user exported in those files.
 *
 * VS Code's integrated terminal works fine because it explicitly spawns
 * `$SHELL -l` which sources init files. We replicate that here for the
 * Extension Host itself.
 *
 * TWO KEY FLAGS:
 *   -l  login shell  → sources ~/.zprofile, ~/.bash_profile
 *   -i  interactive  → sources ~/.zshrc, ~/.bashrc
 * Most users put env vars in ~/.zshrc, so BOTH flags are required.
 *
 * env option intentionally omitted so the child inherits the parent's
 * environment (which includes HOME, USER, SHELL set by launchd). Without
 * HOME the shell cannot locate dotfiles at all.
 *
 * Windows is excluded: env vars set via System Properties are inherited by
 * all GUI processes including VS Code, so this fallback is unnecessary.
 */
async function readLoginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return {};
  if (_cachedShellEnv !== null) return _cachedShellEnv;

  const shell = process.env.SHELL ?? '/bin/zsh';

  // fish uses different flags; all other POSIX shells accept -l -i -c.
  const isFish = shell.endsWith('fish');
  const args = isFish ? ['-l', '-c', 'env'] : ['-l', '-i', '-c', 'env'];

  logInfo(`[ShellEnv] Spawning login shell to read env: ${shell} ${args.slice(0, -1).join(' ')} env`);

  try {
    // Do NOT pass a custom env — inherit the parent env so the child shell
    // has HOME/USER/SHELL and can locate ~/.zshrc, ~/.zprofile, etc.
    const { stdout } = await execFileAsync(shell, args, { timeout: 10_000 });

    const parsed: NodeJS.ProcessEnv = {};
    for (const line of stdout.split('\n')) {
      // Split on first '=' only so values containing '=' are preserved.
      const idx = line.indexOf('=');
      if (idx > 0) {
        parsed[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    _cachedShellEnv = parsed;
    logInfo(`[ShellEnv] Login-shell env loaded (${Object.keys(parsed).length.toString()} vars).`);
    return parsed;
  } catch (err: unknown) {
    logWarn(`[ShellEnv] Could not read login-shell env: ${err instanceof Error ? err.message : String(err)}`);
    _cachedShellEnv = {};
    return {};
  }
}

/**
 * Returns SAP credentials with a two-step fallback:
 *   1. process.env — works when VS Code is launched from a terminal.
 *   2. Login-shell env — covers launching VS Code from the macOS Dock or
 *      Spotlight where the Extension Host has no shell dotfiles.
 */
export async function getCredentials(): Promise<{ email: string; password: string }> {
  const e1 = process.env.SAP_EMAIL;
  const p1 = process.env.SAP_PASSWORD;
  if (e1 && p1) {
    logInfo('[ShellEnv] Credentials resolved from process.env.');
    return { email: e1, password: p1 };
  }

  const shellEnv = await readLoginShellEnv();
  const e2 = shellEnv.SAP_EMAIL;
  const p2 = shellEnv.SAP_PASSWORD;
  if (e2 && p2) {
    logInfo('[ShellEnv] Credentials resolved via login-shell env.');
    return { email: e2, password: p2 };
  }

  return { email: '', password: '' };
}

/** Clears the login-shell env cache (e.g. after the user updates dotfiles). */
export function clearShellEnvCache(): void {
  _cachedShellEnv = null;
}
