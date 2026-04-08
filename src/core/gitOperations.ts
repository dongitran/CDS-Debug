import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

async function run(cwd: string, command: string): Promise<string> {
  const { stdout } = await execAsync(command, { cwd, timeout: 30_000 });
  return stdout.trim();
}

/** Returns the root of the git repository containing folderPath, or null. */
export async function getGitRepoRoot(folderPath: string): Promise<string | null> {
  try {
    return await run(folderPath, 'git rev-parse --show-toplevel');
  } catch {
    return null;
  }
}

/** Returns the current checked-out branch name, or null if detached HEAD or error. */
export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const branch = await run(repoPath, 'git rev-parse --abbrev-ref HEAD');
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

/** Returns true if the working tree has uncommitted changes or untracked files. */
export async function hasUncommittedChanges(repoPath: string): Promise<boolean> {
  try {
    const output = await run(repoPath, 'git status --porcelain');
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
  const output = await run(repoPath, `git stash push -u -m "${message}"`);
  return !output.includes('No local changes to save');
}

/** Checks out the given branch. Throws if branch not found or checkout fails. */
export async function checkoutBranch(repoPath: string, branch: string): Promise<void> {
  await run(repoPath, `git checkout ${branch}`);
}

/**
 * Pulls latest changes from remote for the current branch.
 * Returns { success: true, changed: <boolean> } based on whether the working tree was updated.
 */
export async function pullLatest(repoPath: string): Promise<{ success: boolean; changed: boolean }> {
  try {
    // First, fetch the latest references
    await run(repoPath, 'git fetch');
  } catch {
    // If offline or no remote, we consider it "successful but unchanged" 
    // because we at least tried and there's nothing to pull.
    return { success: false, changed: false };
  }

  try {
    // Attempt a fast-forward pull
    const output = await run(repoPath, 'git pull --ff-only');
    const changed = !output.includes('Already up to date.');
    return { success: true, changed };
  } catch {
    try {
      // If ff-only fails (divergent), try with rebase
      const output = await run(repoPath, 'git pull --rebase');
      const changed = !output.includes('is up to date') && !output.includes('Up to date');
      return { success: true, changed };
    } catch {
      // If rebase fails (e.g. merge conflicts), fail safely
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
    const output = await run(repoPath, 'git branch -a');
    const branches = output
      .split('\n')
      .map((b) => b.replace(/^\*?\s+/, '').replace(/^remotes\/origin\//, '').trim())
      .filter((b) => b && !b.startsWith('HEAD') && !b.includes('->'));
    return [...new Set(branches)].sort();
  } catch {
    return [];
  }
}

/** Runs `pnpm i --shamefully-hoist` in the given directory. */
export async function runPnpmInstall(folderPath: string): Promise<void> {
  await execAsync('pnpm i --shamefully-hoist', { cwd: folderPath, timeout: 120_000 });
}

/** Runs `pnpm build` in the given directory. */
export async function runPnpmBuild(folderPath: string): Promise<void> {
  await execAsync('pnpm build', { cwd: folderPath, timeout: 300_000 });
}
