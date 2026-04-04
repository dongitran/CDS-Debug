import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Dirent, Stats } from 'node:fs';

vi.mock('node:fs/promises');

import { findGroupFolders, findRepoFolder } from '../../src/core/folderScanner';
import * as fs from 'node:fs/promises';

function makeDirent(name: string, isDir: boolean): Dirent {
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
  } as Dirent;
}

function makeStats(): Stats {
  return {} as Stats;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('findGroupFolders', () => {
  it('returns sorted directory names, excluding files', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      makeDirent('client-b', true),
      makeDirent('client-a', true),
      makeDirent('README.md', false),
    ] as Dirent[]);

    const result = await findGroupFolders('/root');
    expect(result).toEqual(['client-a', 'client-b']);
  });

  it('returns empty array when no directories exist', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      makeDirent('README.md', false),
    ] as Dirent[]);

    const result = await findGroupFolders('/root');
    expect(result).toEqual([]);
  });

  it('returns all directories when no files present', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      makeDirent('group-a', true),
      makeDirent('group-b', true),
    ] as Dirent[]);

    const result = await findGroupFolders('/root');
    expect(result).toEqual(['group-a', 'group-b']);
  });
});

describe('findRepoFolder', () => {
  it('returns full path when folder with package.json found', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('prefix_srv_config_main', true)] as Dirent[])
      .mockResolvedValue([] as Dirent[]);

    vi.mocked(fs.stat).mockResolvedValue(makeStats());

    const result = await findRepoFolder('/group', 'prefix_srv_config_main');
    expect(result).toBe('/group/prefix_srv_config_main');
  });

  it('returns null when folder exists but has no package.json', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('prefix_srv_config_main', true)] as Dirent[])
      .mockResolvedValue([] as Dirent[]);

    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

    const result = await findRepoFolder('/group', 'prefix_srv_config_main');
    expect(result).toBeNull();
  });

  it('searches recursively into subdirectories', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('core', true)] as Dirent[])
      .mockResolvedValueOnce([makeDirent('config', true)] as Dirent[])
      .mockResolvedValueOnce([makeDirent('prefix_srv_config_main', true)] as Dirent[])
      .mockResolvedValue([] as Dirent[]);

    vi.mocked(fs.stat).mockResolvedValue(makeStats());

    const result = await findRepoFolder('/group', 'prefix_srv_config_main');
    expect(result).toBe('/group/core/config/prefix_srv_config_main');
  });

  it('returns null when folder not found anywhere', async () => {
    vi.mocked(fs.readdir).mockResolvedValue([makeDirent('other_folder', true)] as Dirent[]);
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

    const result = await findRepoFolder('/group', 'prefix_srv_nonexistent');
    expect(result).toBeNull();
  });
});
