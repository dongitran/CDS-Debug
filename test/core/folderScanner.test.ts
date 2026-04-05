import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Stats } from 'node:fs';

vi.mock('node:fs/promises');

import { findRepoFolder } from '../../src/core/folderScanner';
import * as fs from 'node:fs/promises';

type ReaddirResult = Awaited<ReturnType<typeof fs.readdir>>;

function makeDirent(name: string, isDir: boolean): ReaddirResult[number] {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: '/root',
    parentPath: '/root',
  } as unknown as ReaddirResult[number];
}

function makeStats(): Stats {
  return {} as Stats;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('findRepoFolder', () => {
  it('returns full path when folder with package.json found', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('myapp_svc_one', true)] as ReaddirResult)
      .mockResolvedValue([] as ReaddirResult);

    vi.mocked(fs.stat).mockResolvedValue(makeStats());

    const result = await findRepoFolder('/group', 'myapp_svc_one');
    expect(result).toBe('/group/myapp_svc_one');
  });

  it('returns null when folder exists but has no package.json', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('myapp_svc_one', true)] as ReaddirResult)
      .mockResolvedValue([] as ReaddirResult);

    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

    const result = await findRepoFolder('/group', 'myapp_svc_one');
    expect(result).toBeNull();
  });

  it('searches recursively into subdirectories', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('sub-a', true)] as ReaddirResult)
      .mockResolvedValueOnce([makeDirent('sub-b', true)] as ReaddirResult)
      .mockResolvedValueOnce([makeDirent('myapp_svc_one', true)] as ReaddirResult)
      .mockResolvedValue([] as ReaddirResult);

    vi.mocked(fs.stat).mockResolvedValue(makeStats());

    const result = await findRepoFolder('/group', 'myapp_svc_one');
    expect(result).toBe('/group/sub-a/sub-b/myapp_svc_one');
  });

  it('returns null when folder not found anywhere', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([makeDirent('other_folder', true)] as ReaddirResult);
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

    const result = await findRepoFolder('/group', 'myapp_svc_unknown');
    expect(result).toBeNull();
  });
});
