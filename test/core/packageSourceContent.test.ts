import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugSession } from 'vscode';

interface MockDebugSession {
  customRequest: ReturnType<typeof vi.fn>;
}

const { vscodeMockState } = vi.hoisted(() => ({
  vscodeMockState: {
    workspaceFolders: [] as { uri: { fsPath: string } }[],
  },
}));

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders(): { uri: { fsPath: string } }[] {
      return vscodeMockState.workspaceFolders;
    },
  },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      append: () => undefined,
      clear: () => undefined,
      dispose: () => undefined,
      show: () => undefined,
    }),
  },
}));

import { materializePackageSourceContent } from '../../src/core/packageSourceContent';

function asDebugSession(session: MockDebugSession): DebugSession {
  return session as unknown as DebugSession;
}

beforeEach(() => {
  vscodeMockState.workspaceFolders = [];
});

describe('packageSourceContent', () => {
  it('does not request content for sources without a positive source reference', async () => {
    const session: MockDebugSession = {
      customRequest: vi.fn(),
    };

    await expect(materializePackageSourceContent(
      asDebugSession(session),
      { path: '/workspace/node_modules/sample-client/src/client.ts' },
      [],
    )).resolves.toBeNull();
    await expect(materializePackageSourceContent(
      asDebugSession(session),
      {
        path: '/workspace/node_modules/sample-client/src/client.ts',
        sourceReference: 0,
      },
      [],
    )).resolves.toBeNull();

    expect(session.customRequest).not.toHaveBeenCalled();
  });

  it('materializes decoded file URI package content inside a workspace folder', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-source-content-'));
    const targetPath = join(rootDir, 'node_modules', 'sample-client', 'src', 'client.ts');
    const sourceContent = 'export const sampleClient = true;\n';
    const session: MockDebugSession = {
      customRequest: vi.fn((): Promise<unknown> => Promise.resolve({ content: sourceContent })),
    };
    vscodeMockState.workspaceFolders = [{ uri: { fsPath: rootDir } }];

    try {
      const materialized = await materializePackageSourceContent(
        asDebugSession(session),
        {
          name: 'client.ts',
          path: `file://${encodeURIComponent(targetPath)}`,
          sourceReference: 17,
        },
        [],
      );

      expect(materialized).toBe(targetPath);
      await expect(readFile(targetPath, 'utf8')).resolves.toBe(sourceContent);
      expect(session.customRequest).toHaveBeenCalledWith('source', {
        source: {
          name: 'client.ts',
          path: `file://${encodeURIComponent(targetPath)}`,
          sourceReference: 17,
        },
        sourceReference: 17,
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('skips unsafe materialization targets before requesting debugger content', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-source-unsafe-'));
    const unsafePath = join(rootDir, 'src', 'client.ts');
    const session: MockDebugSession = {
      customRequest: vi.fn((): Promise<unknown> => Promise.resolve({ content: 'ignored' })),
    };
    vscodeMockState.workspaceFolders = [{ uri: { fsPath: rootDir } }];

    try {
      const materialized = await materializePackageSourceContent(
        asDebugSession(session),
        {
          path: unsafePath,
          sourceReference: 18,
        },
        [],
      );

      expect(materialized).toBeNull();
      expect(session.customRequest).not.toHaveBeenCalled();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('allows package ancestor materialization when localRoot is inside that package root', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-source-ancestor-'));
    const packageRoot = join(rootDir, 'sample-repo');
    const localRoot = join(packageRoot, 'services', 'sample-service');
    const targetPath = join(packageRoot, 'node_modules', 'sample-client', 'src', 'client.ts');
    const sourceContent = 'export const ancestorMaterialized = true;\n';
    const session: MockDebugSession = {
      customRequest: vi.fn((): Promise<unknown> => Promise.resolve({ content: sourceContent })),
    };

    try {
      await mkdir(localRoot, { recursive: true });

      const materialized = await materializePackageSourceContent(
        asDebugSession(session),
        {
          path: targetPath,
          sourceReference: 19,
        },
        [],
        { localRoot },
      );

      expect(materialized).toBe(targetPath);
      await expect(readFile(targetPath, 'utf8')).resolves.toBe(sourceContent);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('returns null when the debugger cannot provide source content', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-source-failure-'));
    const targetPath = join(rootDir, 'node_modules', 'sample-client', 'src', 'client.ts');
    const session: MockDebugSession = {
      customRequest: vi.fn((): Promise<unknown> => Promise.reject(new Error('source unavailable'))),
    };
    vscodeMockState.workspaceFolders = [{ uri: { fsPath: rootDir } }];

    try {
      const materialized = await materializePackageSourceContent(
        asDebugSession(session),
        {
          path: targetPath,
          sourceReference: 20,
        },
        [],
      );

      expect(materialized).toBeNull();
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
