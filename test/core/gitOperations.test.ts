import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process at module level
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));
vi.mock('node:util', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  promisify: vi.fn((fn: any) => fn as unknown),
}));

import { exec } from 'node:child_process';
import {
  isGitRepo,
  getGitRepoRoot,
  getCurrentBranch,
  hasUncommittedChanges,
  stashChanges,
  checkoutBranch,
  listBranches,
} from '../../src/core/gitOperations';

const mockExec = vi.mocked(exec) as ReturnType<typeof vi.fn>;

function resolveWith(stdout: string) {
  mockExec.mockResolvedValueOnce({ stdout, stderr: '' } as never);
}

function rejectWith(message: string) {
  mockExec.mockRejectedValueOnce(new Error(message));
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('isGitRepo', () => {
  it('returns true when git rev-parse succeeds', async () => {
    resolveWith('.git');
    expect(await isGitRepo('/some/path')).toBe(true);
  });

  it('returns false when git rev-parse fails', async () => {
    rejectWith('not a git repository');
    expect(await isGitRepo('/some/path')).toBe(false);
  });
});

describe('getGitRepoRoot', () => {
  it('returns the repo root path', async () => {
    resolveWith('/home/user/project\n');
    expect(await getGitRepoRoot('/home/user/project/src')).toBe('/home/user/project');
  });

  it('returns null on error', async () => {
    rejectWith('not a git repository');
    expect(await getGitRepoRoot('/not/a/repo')).toBeNull();
  });
});

describe('getCurrentBranch', () => {
  it('returns the current branch name', async () => {
    resolveWith('develop\n');
    expect(await getCurrentBranch('/repo')).toBe('develop');
  });

  it('returns null for detached HEAD', async () => {
    resolveWith('HEAD\n');
    expect(await getCurrentBranch('/repo')).toBeNull();
  });

  it('returns null on error', async () => {
    rejectWith('not a git repo');
    expect(await getCurrentBranch('/repo')).toBeNull();
  });
});

describe('hasUncommittedChanges', () => {
  it('returns true when porcelain output is non-empty', async () => {
    resolveWith('M src/file.ts\n');
    expect(await hasUncommittedChanges('/repo')).toBe(true);
  });

  it('returns false when working tree is clean', async () => {
    resolveWith('');
    expect(await hasUncommittedChanges('/repo')).toBe(false);
  });

  it('returns false on git error', async () => {
    rejectWith('not a git repo');
    expect(await hasUncommittedChanges('/repo')).toBe(false);
  });
});

describe('stashChanges', () => {
  it('returns true when stash is created', async () => {
    resolveWith('Saved working directory and index state WIP on main: abc1234 message');
    expect(await stashChanges('/repo')).toBe(true);
  });

  it('returns false when nothing to stash', async () => {
    resolveWith('No local changes to save');
    expect(await stashChanges('/repo')).toBe(false);
  });
});

describe('checkoutBranch', () => {
  it('resolves on successful checkout', async () => {
    resolveWith("Switched to branch 'develop'");
    await expect(checkoutBranch('/repo', 'develop')).resolves.toBeUndefined();
  });

  it('throws on checkout failure', async () => {
    rejectWith("error: pathspec 'nonexistent' did not match any file(s) known to git");
    await expect(checkoutBranch('/repo', 'nonexistent')).rejects.toThrow();
  });
});

describe('listBranches', () => {
  it('returns deduplicated sorted branch list', async () => {
    resolveWith(
      '* main\n  develop\n  remotes/origin/main\n  remotes/origin/develop\n  remotes/origin/feature/test',
    );
    const branches = await listBranches('/repo');
    expect(branches).toEqual(['develop', 'feature/test', 'main']);
  });

  it('filters out HEAD pointers', async () => {
    resolveWith(
      '* main\n  remotes/origin/HEAD -> origin/main\n  remotes/origin/main',
    );
    const branches = await listBranches('/repo');
    expect(branches).toEqual(['main']);
  });

  it('returns empty array on error', async () => {
    rejectWith('not a git repo');
    expect(await listBranches('/repo')).toEqual([]);
  });
});
