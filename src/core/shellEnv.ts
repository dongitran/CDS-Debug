import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logInfo, logWarn } from './logger';

const execFileAsync = promisify(execFile);

/**
 * Minimal interface for VS Code's SecretStorage so this module does not
 * need to import 'vscode' directly (which would break unit tests that run
 * outside the VS Code Extension Host environment).
 *
 * Uses PromiseLike<T> (standard TypeScript) instead of Promise<T> because
 * VS Code's SecretStorage methods return Thenable<T>, which satisfies
 * PromiseLike<T> but not the full Promise<T> shape.
 */
export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

const SECRET_KEY_EMAIL = 'cds-debug.credentials.email';
const SECRET_KEY_PASSWORD = 'cds-debug.credentials.password';

// Cache the result so subsequent calls are instant.
let _cachedShellEnv: NodeJS.ProcessEnv | null = null;

// Injected by extension.ts once context is available.
let _secretStorage: SecretStorageLike | undefined;

/**
 * Registers the VS Code SecretStorage instance used as a third-priority
 * credential source (after process.env and login-shell env).
 * Called once from extension.ts activate().
 */
export function setSecretStorage(storage: SecretStorageLike | undefined): void {
  _secretStorage = storage;
}

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
 * Returns SAP credentials with a three-step priority:
 *   1. process.env — works when VS Code is launched from a terminal.
 *   2. Login-shell env — covers launching VS Code from the macOS Dock or
 *      Spotlight where the Extension Host has no shell dotfiles.
 *   3. VS Code SecretStorage — covers users who have not set env vars but
 *      have stored credentials via the extension's Setup Credentials UI.
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

  if (_secretStorage) {
    const e3 = await _secretStorage.get(SECRET_KEY_EMAIL);
    const p3 = await _secretStorage.get(SECRET_KEY_PASSWORD);
    if (e3 && p3) {
      logInfo('[ShellEnv] Credentials resolved from SecretStorage (system keychain).');
      return { email: e3, password: p3 };
    }
  }

  return { email: '', password: '' };
}

/**
 * Returns the source of the currently active credentials.
 * 'env'     = process.env or login-shell dotfiles
 * 'keychain' = VS Code SecretStorage (system keychain)
 * 'none'    = no credentials found
 */
export async function getCredentialSource(): Promise<'env' | 'keychain' | 'none'> {
  const e1 = process.env.SAP_EMAIL;
  const p1 = process.env.SAP_PASSWORD;
  if (e1 && p1) return 'env';

  const shellEnv = await readLoginShellEnv();
  if (shellEnv.SAP_EMAIL && shellEnv.SAP_PASSWORD) return 'env';

  if (_secretStorage) {
    const e3 = await _secretStorage.get(SECRET_KEY_EMAIL);
    const p3 = await _secretStorage.get(SECRET_KEY_PASSWORD);
    if (e3 && p3) return 'keychain';
  }

  return 'none';
}

/**
 * Persists email and password in the VS Code SecretStorage (system keychain).
 * Clears the login-shell env cache so the next getCredentials() call will
 * re-evaluate priority order and pick up the newly saved values.
 */
export async function saveCredentialsToSecretStorage(email: string, password: string): Promise<void> {
  if (!_secretStorage) {
    throw new Error('SecretStorage is not available — extension context not yet initialized.');
  }
  await _secretStorage.store(SECRET_KEY_EMAIL, email);
  await _secretStorage.store(SECRET_KEY_PASSWORD, password);
  _cachedShellEnv = null; // Invalidate cache so priority re-evaluation is fresh.
  logInfo('[ShellEnv] Credentials saved to SecretStorage.');
}

/**
 * Removes the saved credentials from VS Code SecretStorage (system keychain).
 * Does nothing if no credentials are stored or SecretStorage is unavailable.
 */
export async function clearCredentialsFromSecretStorage(): Promise<void> {
  if (!_secretStorage) return;
  await _secretStorage.delete(SECRET_KEY_EMAIL);
  await _secretStorage.delete(SECRET_KEY_PASSWORD);
  logInfo('[ShellEnv] Credentials cleared from SecretStorage.');
}

/**
 * Returns a display-safe masked version of an email address.
 * Example: "dongtran@sap.com" → "d***n@sap.com"
 */
export function maskEmail(email: string): string {
  if (!email) return '';
  const atIdx = email.indexOf('@');
  if (atIdx <= 0) return '***';
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx);
  if (local.length <= 2) {
    return `${local.charAt(0)}***${domain}`;
  }
  return `${local.charAt(0)}***${local.charAt(local.length - 1)}${domain}`;
}

/** Clears the login-shell env cache (e.g. after the user updates dotfiles). */
export function clearShellEnvCache(): void {
  _cachedShellEnv = null;
}
