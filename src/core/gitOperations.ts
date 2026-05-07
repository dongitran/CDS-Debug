import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const PNPM_INSTALL_TIMEOUT_MS = 120_000;
const PNPM_BUILD_TIMEOUT_MS = 300_000;
const GIT_BRANCH_PATTERN = /^[a-zA-Z0-9._/-]+$/;

async function runCommand(
  cwd: string,
  command: string,
  args: readonly string[],
  timeout: number,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, timeout });
  return stdout.trim();
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return runCommand(cwd, 'git', args, GIT_TIMEOUT_MS);
}

export function isValidGitBranchName(branch: string): boolean {
  if (branch.length === 0 || branch.length > 255) return false;
  if (branch.trim() !== branch) return false;
  if (!GIT_BRANCH_PATTERN.test(branch)) return false;
  if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('//')) return false;
  if (branch.startsWith('-')) return false;
  if (branch === '@') return false;
  if (branch.includes('..') || branch.includes('@{')) return false;
  if (branch.endsWith('.') || branch.endsWith('.lock')) return false;

  return branch.split('/').every((part) => (
    part.length > 0
    && !part.startsWith('.')
    && !part.endsWith('.lock')
  ));
}

export function validateGitBranchName(branch: string): void {
  if (isValidGitBranchName(branch)) return;

  throw new Error(
    'Invalid git branch name. Use only letters, numbers, ".", "_", "-", and "/" in git branch values. '
    + 'Check cap-debug-config.json or cdsDebug.sharedCapDebugConfig.',
  );
}

export function describeGitBranchForLog(branch: string): string {
  return isValidGitBranchName(branch) ? branch : '[invalid git branch name]';
}

/** Returns the root of the git repository containing folderPath, or null. */
export async function getGitRepoRoot(folderPath: string): Promise<string | null> {
  try {
    return await runGit(folderPath, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

/** Returns the current checked-out branch name, or null if detached HEAD or error. */
export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const branch = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

/** Returns true if the working tree has uncommitted changes or untracked files. */
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  try {
    const output = await runGit(repoPath, ['status', '--porcelain']);
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Stashes uncommitted changes with an auto-generated message.
 * Returns true if a stash entry was created, false if nothing to stash.
 */
export async function stashChanges(repoPath: string): Promise<boolean> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const message = `cds-debug-autostash-${timestamp}`;
  const output = await runGit(repoPath, ['stash', 'push', '-u', '-m', message]);
  return !output.includes('No local changes to save');
}

/** Checks out the given branch. Throws if branch not found or checkout fails. */
export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  validateGitBranchName(branch);
  await runGit(repoPath, ['checkout', branch]);
}

/**
 * Pulls latest changes from remote for the current branch.
 * Returns { success: true, changed: <boolean> } based on whether the working tree was updated.
 */
export async function pullLatest(repoPath: string): Promise<{ success: boolean; changed: boolean }> {
  try {
    await runGit(repoPath, ['fetch']);
  } catch {
    return { success: false, changed: false };
  }

  try {
    const output = await runGit(repoPath, ['pull', '--ff-only']);
    const changed = !output.includes('Already up to date.');
    return { success: true, changed };
  } catch {
    try {
      const output = await runGit(repoPath, ['pull', '--rebase']);
      const changed = !output.includes('is up to date') && !output.includes('Up to date');
      return { success: true, changed };
    } catch {
      return { success: false, changed: false };
    }
  }
}

/**
 * Returns deduplicated, sorted list of branch names (local + remote/origin).
 * Remote branches are returned without the `remotes/origin/` prefix.
 */
export async function listBranches(repoPath: string): Promise<string[]> {
  try {
    const output = await runGit(repoPath, ['branch', '-a']);
    const branches = output
      .split('\n')
      .map((b) => b.replace(/^\*?\s+/, '').replace(/^remotes\/origin\//, '').trim())
      .filter((b) => b && !b.startsWith('HEAD') && !b.includes('->'))
      .filter(isValidGitBranchName);
    return [...new Set(branches)].sort();
  } catch {
    return [];
  }
}

/** Runs `pnpm i --shamefully-hoist` in the given directory. */
export async function runPnpmInstall(folderPath: string): Promise<void> {
  await runCommand(folderPath, 'pnpm', ['i', '--shamefully-hoist'], PNPM_INSTALL_TIMEOUT_MS);
}

/** Runs `pnpm build` in the given directory. */
export async function runPnpmBuild(folderPath: string): Promise<void> {
  await runCommand(folderPath, 'pnpm', ['build'], PNPM_BUILD_TIMEOUT_MS);
}
