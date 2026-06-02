import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugSession, Uri } from 'vscode';

interface MockDebugSession {
  id: string;
  name: string;
  type?: string;
  parentSession?: MockDebugSession;
  customRequest: (command: string, args: unknown) => Promise<unknown>;
}

interface MockUri {
  scheme: string;
  path: string;
  fsPath?: string;
  query?: string;
  toString(): string;
}

const { vscodeMockState } = vi.hoisted(() => ({
  vscodeMockState: {
    asDebugSourceUri: vi.fn(),
    openTextDocument: vi.fn(),
    showTextDocument: vi.fn(),
    Position: class {
      constructor(
        public readonly line: number,
        public readonly character: number,
      ) {}
    },
    Range: class {
      constructor(
        public readonly start: { line: number; character: number },
        public readonly end: { line: number; character: number },
      ) {}
    },
    TextEditorRevealType: {
      InCenterIfOutsideViewport: 1,
    },
    workspaceFolders: [] as { uri: { fsPath: string } }[],
  },
}));

function createMockUri(raw: string, scheme: string, path: string, fsPath?: string, query?: string): MockUri {
  const uri: MockUri = {
    scheme,
    path,
    toString: (): string => raw,
  };
  if (fsPath !== undefined) {
    uri.fsPath = fsPath;
  }
  if (query !== undefined) {
    uri.query = query;
  }
  return uri;
}

function asDebugSession(session: MockDebugSession): DebugSession {
  return session as unknown as DebugSession;
}

function asUri(uri: MockUri): Uri {
  return uri as unknown as Uri;
}

vi.mock('vscode', () => ({
  debug: {
    asDebugSourceUri: vscodeMockState.asDebugSourceUri,
  },
  workspace: {
    get workspaceFolders(): { uri: { fsPath: string } }[] {
      return vscodeMockState.workspaceFolders;
    },
    openTextDocument: vscodeMockState.openTextDocument,
  },
  window: {
    showTextDocument: vscodeMockState.showTextDocument,
    createOutputChannel: () => ({
      appendLine: () => undefined,
      append: () => undefined,
      clear: () => undefined,
      dispose: () => undefined,
      show: () => undefined,
    }),
  },
  Uri: {
    file: (path: string): MockUri => createMockUri(`file://${path}`, 'file', path, path),
    parse: (value: string): MockUri => {
      if (value.startsWith('file://')) {
        const path = decodeURIComponent(value.slice('file://'.length));
        return createMockUri(value, 'file', path, path);
      }
      const scheme = value.includes(':') ? value.slice(0, value.indexOf(':')) : 'file';
      return createMockUri(value, scheme, value.slice(scheme.length + 1));
    },
  },
  Position: vscodeMockState.Position,
  Range: vscodeMockState.Range,
  TextEditorRevealType: vscodeMockState.TextEditorRevealType,
}));

import {
  buildPackageEntries,
  buildPackageFileTree,
  clearOpenedPackageUris,
  createPackageSearchIndex,
  extractSessionIdFromDebugUri,
  findAppForOpenedPath,
  findOpenedPackageSourceByUri,
  getOpenedPackageUris,
  loadPackageEntries,
  loadPackageEntriesFromSessions,
  openPackageSource,
  searchPackageEntries,
  trackOpenedPackageUri,
  unregisterOpenedPackageUri,
} from '../../src/core/packageSourceBrowser';
import type { LoadedPackageTreeNode } from '../../src/types/index';

interface TempPackageFileSpec {
  relativePath: string;
  content: string;
}

interface TempPackageSpec {
  name: string;
  version?: string;
  files: TempPackageFileSpec[];
}

function simplifyTree(nodes: LoadedPackageTreeNode[]): unknown[] {
  return nodes.map((node) => {
    if (node.kind === 'folder') {
      return {
        kind: 'folder',
        name: node.name,
        path: node.path,
        children: simplifyTree(node.children),
      };
    }
    return {
      kind: 'file',
      name: node.name,
      path: node.path,
    };
  });
}

function createTempPackageFilePath(
  rootDir: string,
  packageName: string,
  relativePath: string,
  version = '1.0.0',
): string {
  if (packageName.startsWith('@')) {
    const encoded = packageName.replace('/', '+');
    return join(rootDir, 'node_modules', '.pnpm', `${encoded}@${version}`, 'node_modules', packageName, relativePath);
  }
  return join(rootDir, 'node_modules', packageName, relativePath);
}

async function createTempPackageEntries(
  specs: TempPackageSpec[],
): Promise<{ rootDir: string; entries: ReturnType<typeof buildPackageEntries>; filePaths: string[] }> {
  const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-package-source-'));
  const filePaths: string[] = [];
  const sources: { name: string; path: string }[] = [];

  for (const spec of specs) {
    for (const file of spec.files) {
      const filePath = createTempPackageFilePath(rootDir, spec.name, file.relativePath, spec.version);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, 'utf8');
      filePaths.push(filePath);
      sources.push({
        name: basename(filePath),
        path: filePath,
      });
    }
  }

  return {
    rootDir,
    entries: buildPackageEntries(sources),
    filePaths,
  };
}

function createMixedLoadedSourcesResponse(): { sources: unknown[] } {
  return {
    sources: [
      null,
      'not-a-source',
      { sourceReference: 3 },
      { name: 'name-only.js' },
      { name: 'handler.js', path: '/workspace/srv/handler.js' },
      { name: 'sample-shim', path: '/workspace/node_modules/.bin/sample-shim' },
      { name: 'scope-root.js', path: '/workspace/node_modules/@sample-org' },
      { name: 'scope-package-root.js', path: '/workspace/node_modules/@sample-org/demo-kit' },
      { name: 'package-root.js', path: '/workspace/node_modules/sample-client' },
      {
        name: 'main.js',
        path: '/workspace/node_modules/.pnpm/@sample-org+demo-kit/node_modules/@sample-org/demo-kit/dist/main.js',
        sourceReference: 11,
        origin: 'debug-adapter',
        presentationHint: 'normal',
      },
      {
        name: 'index.js',
        path: '/workspace/node_modules/.pnpm/sample-broken@/node_modules/sample-broken/index.js',
      },
    ],
  };
}

function createTrackedPackageUri(): MockUri {
  const query = createEncodedDebugQuery('session-track', '7');
  return createMockUri(
    `debug:/workspace/node_modules/sample-client/src/client.ts?${query}`,
    'debug',
    '/workspace/node_modules/sample-client/src/client.ts',
    undefined,
    query,
  );
}

function createEncodedDebugQuery(sessionId: string, ref?: string): string {
  const encodedEquals = '%3D';
  const encodedAmpersand = '%26';
  const sessionPart = `session${encodedEquals}${sessionId}`;
  return ref === undefined ? sessionPart : `${sessionPart}${encodedAmpersand}ref${encodedEquals}${ref}`;
}

function trackSamplePackageUri(uri: MockUri, session: MockDebugSession): void {
  trackOpenedPackageUri(
    'sample-service',
    asUri(uri),
    {
      name: 'client.ts',
      path: uri.path,
      sourceReference: 7,
      origin: 'debug-adapter',
      presentationHint: 'normal',
    },
    asDebugSession(session),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  clearOpenedPackageUris('sample-service');
  clearOpenedPackageUris('sample-worker');
  clearOpenedPackageUris('sample-api');
  vscodeMockState.asDebugSourceUri.mockReset();
  vscodeMockState.openTextDocument.mockReset();
  vscodeMockState.showTextDocument.mockReset();
  vscodeMockState.workspaceFolders = [];
  vscodeMockState.asDebugSourceUri.mockImplementation((source: { path?: string; name?: string }) =>
    createMockUri(
      `debug:${source.path ?? source.name ?? 'unknown'}`,
      'debug',
      source.path ?? source.name ?? 'unknown',
    ));
  vscodeMockState.openTextDocument.mockResolvedValue({ uri: createMockUri('debug:default', 'debug', 'default') });
  vscodeMockState.showTextDocument.mockResolvedValue({ revealRange: vi.fn() });
});

describe('packageSourceBrowser', () => {
  it('groups pnpm and scoped package sources into sorted package entries', () => {
    const entries = buildPackageEntries([
      {
        name: 'oauth2client.js',
        path: '/workspace/node_modules/.pnpm/google-auth-library@7.14.1/node_modules/google-auth-library/build/src/auth/oauth2client.js',
      },
      {
        name: 'index.js',
        path: '/workspace/node_modules/.pnpm/google-auth-library@7.14.1/node_modules/google-auth-library/build/src/index.js',
      },
      {
        name: 'main.js',
        path: '/workspace/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.js',
      },
      {
        name: 'ignored.js',
        path: '/workspace/srv/ignored.js',
      },
    ]);

    expect(entries.map((entry) => entry.name)).toEqual([
      '@sample-org/demo-kit',
      'google-auth-library',
    ]);
    expect(entries[0]?.files.map((file) => file.relativePath)).toEqual(['dist/main.js']);
    expect(entries[1]?.files.map((file) => file.relativePath)).toEqual([
      'build/src/auth/oauth2client.js',
      'build/src/index.js',
    ]);
  });

  it('supports direct node_modules paths and removes duplicate file entries', () => {
    const entries = buildPackageEntries([
      {
        name: 'index.js',
        path: '/workspace/node_modules/@sample-org/demo-core/lib/index.js',
      },
      {
        name: 'index.js',
        path: '/workspace/node_modules/@sample-org/demo-core/lib/index.js',
      },
      {
        name: 'index.d.ts',
        path: 'file:///workspace/node_modules/@sample-org/demo-core/lib/index.d.ts',
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('@sample-org/demo-core');
    expect(entries[0]?.files.map((file) => file.relativePath)).toEqual([
      'lib/index.d.ts',
      'lib/index.js',
    ]);
  });

  it('normalizes loadedSources records and ignores incomplete package paths', async () => {
    const session: MockDebugSession = {
      id: 'session-normalize-sources',
      name: 'Debug: sample-service',
      customRequest: (): Promise<unknown> => Promise.resolve(createMixedLoadedSourcesResponse()),
    };

    const entries = await loadPackageEntries(asDebugSession(session));

    expect(entries.map((entry) => entry.name)).toEqual([
      '@sample-org/demo-kit',
      'sample-broken',
    ]);
    expect(entries[0]?.version).toBeUndefined();
    expect(entries[0]?.files[0]?.source).toEqual(expect.objectContaining({
      name: 'main.js',
      sourceReference: 11,
      origin: 'debug-adapter',
      presentationHint: 'normal',
    }));
    expect(entries[1]?.version).toBeUndefined();
  });

  it('builds explorer-style folder trees from package file paths', () => {
    const tree = buildPackageFileTree([
      {
        id: 'sample-client:dist/client.js',
        label: 'dist/client.js',
        relativePath: 'dist/client.js',
        source: {
          name: 'client.js',
          path: '/workspace/node_modules/sample-client/dist/client.js',
        },
      },
      {
        id: 'sample-client:dist/utils/format.js',
        label: 'dist/utils/format.js',
        relativePath: 'dist/utils/format.js',
        source: {
          name: 'format.js',
          path: '/workspace/node_modules/sample-client/dist/utils/format.js',
        },
      },
      {
        id: 'sample-client:README.md',
        label: 'README.md',
        relativePath: 'README.md',
        source: {
          name: 'README.md',
          path: '/workspace/node_modules/sample-client/README.md',
        },
      },
    ]);

    expect(simplifyTree(tree)).toEqual([
      {
        kind: 'folder',
        name: 'dist',
        path: 'dist',
        children: [
          {
            kind: 'folder',
            name: 'utils',
            path: 'dist/utils',
            children: [
              {
                kind: 'file',
                name: 'format.js',
                path: 'dist/utils/format.js',
              },
            ],
          },
          {
            kind: 'file',
            name: 'client.js',
            path: 'dist/client.js',
          },
        ],
      },
      {
        kind: 'file',
        name: 'README.md',
        path: 'README.md',
      },
    ]);
  });

  it('attaches nested trees to package entries', () => {
    const entries = buildPackageEntries([
      {
        name: 'main.js',
        path: '/workspace/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.js',
      },
      {
        name: 'worker.js',
        path: '/workspace/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/tasks/worker.js',
      },
    ]);

    expect(simplifyTree(entries[0]?.tree ?? [])).toEqual([
      {
        kind: 'folder',
        name: 'dist',
        path: 'dist',
        children: [
          {
            kind: 'folder',
            name: 'tasks',
            path: 'dist/tasks',
            children: [
              {
                kind: 'file',
                name: 'worker.js',
                path: 'dist/tasks/worker.js',
              },
            ],
          },
          {
            kind: 'file',
            name: 'main.js',
            path: 'dist/main.js',
          },
        ],
      },
    ]);
  });

  it('loads entries from the debugger loadedSources request', async () => {
    const requestCalls: string[] = [];
    const session: MockDebugSession = {
      id: 'session-1',
      name: 'Debug: sample-service',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        void args;
        requestCalls.push(command);
        return Promise.resolve({
          sources: [
            {
              name: 'client.js',
              path: '/workspace/node_modules/sample-client/dist/client.js',
            },
          ],
        });
      },
    };

    const entries = await loadPackageEntries(asDebugSession(session));

    expect(requestCalls).toEqual(['loadedSources']);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('sample-client');
    expect(entries[0]?.files[0]?.relativePath).toBe('dist/client.js');
  });

  it('prefers child sessions when the parent CDS session has no loaded sources', async () => {
    const parentCalls: string[] = [];
    const childCalls: string[] = [];
    const parentSession: MockDebugSession = {
      id: 'session-parent',
      name: 'Debug: sample-service',
      type: 'pwa-node',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        void args;
        parentCalls.push(command);
        return Promise.resolve({ sources: [] });
      },
    };
    const childSession: MockDebugSession = {
      id: 'session-child',
      name: 'Remote Process [0]',
      type: 'pwa-node',
      parentSession,
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        void args;
        childCalls.push(command);
        return Promise.resolve({
          sources: [
            {
              name: 'worker.js',
              path: '/workspace/node_modules/sample-worker/dist/worker.js',
            },
          ],
        });
      },
    };

    const entries = await loadPackageEntriesFromSessions(
      'sample-service',
      [asDebugSession(parentSession), asDebugSession(childSession)],
    );

    expect(parentCalls).toEqual(['loadedSources']);
    expect(childCalls).toEqual(['loadedSources']);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('sample-worker');
    expect(entries[0]?.files[0]?.source.debugSessionId).toBe('session-child');
  });

  it('retries empty loadedSources responses before surfacing a failure', async () => {
    let childRequestCount = 0;
    const parentSession: MockDebugSession = {
      id: 'session-parent-retry',
      name: 'Debug: sample-service',
      type: 'pwa-node',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };
    const childSession: MockDebugSession = {
      id: 'session-child-retry',
      name: 'Remote Process [0]',
      type: 'pwa-node',
      parentSession,
      customRequest: (): Promise<unknown> => {
        childRequestCount += 1;
        if (childRequestCount === 1) {
          return Promise.resolve({ sources: [] });
        }
        return Promise.resolve({
          sources: [
            {
              name: 'worker.js',
              path: '/workspace/node_modules/sample-worker/dist/worker.js',
            },
          ],
        });
      },
    };

    const entries = await loadPackageEntriesFromSessions(
      'sample-service',
      [asDebugSession(parentSession), asDebugSession(childSession)],
      undefined,
      {
        maxAttempts: 2,
        emptyRetryDelayMs: 1,
        loadedSourcesRequestTimeoutMs: 25,
      },
    );

    expect(childRequestCount).toBe(2);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('sample-worker');
  });

  it('uses the default warm-up window when a child session appears after the old retry limit', async () => {
    const parentSession: MockDebugSession = {
      id: 'session-parent-delayed-child',
      name: 'Debug: sample-service',
      type: 'pwa-node',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };
    const childSession: MockDebugSession = {
      id: 'session-child-delayed-child',
      name: 'Remote Process [0]',
      type: 'pwa-node',
      parentSession,
      customRequest: (): Promise<unknown> => Promise.resolve({
        sources: [
          {
            name: 'worker.js',
            path: '/workspace/node_modules/sample-worker/dist/worker.js',
          },
        ],
      }),
    };

    let resolverCalls = 0;
    const resolveSessions = (): DebugSession[] => {
      resolverCalls += 1;
      if (resolverCalls < 7) {
        return [asDebugSession(parentSession)];
      }
      return [asDebugSession(parentSession), asDebugSession(childSession)];
    };

    const entries = await loadPackageEntriesFromSessions(
      'sample-service',
      resolveSessions,
      undefined,
      {
        emptyRetryDelayMs: 1,
        loadedSourcesRequestTimeoutMs: 25,
      },
    );

    expect(resolverCalls).toBeGreaterThanOrEqual(7);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('sample-worker');
    expect(entries[0]?.files[0]?.source.debugSessionId).toBe('session-child-delayed-child');
  });

  it('uses a 15-attempt one-second default package warm-up interval', async () => {
    const logs: string[] = [];
    const parentSession: MockDebugSession = {
      id: 'session-parent-default-retry',
      name: 'Debug: sample-service',
      type: 'pwa-node',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };
    const childSession: MockDebugSession = {
      id: 'session-child-default-retry',
      name: 'Remote Process [0]',
      type: 'pwa-node',
      parentSession,
      customRequest: (): Promise<unknown> => Promise.resolve({
        sources: [
          {
            name: 'worker.js',
            path: '/workspace/node_modules/sample-worker/dist/worker.js',
          },
        ],
      }),
    };

    let resolverCalls = 0;
    const resolveSessions = (): DebugSession[] => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        return [asDebugSession(parentSession)];
      }
      return [asDebugSession(parentSession), asDebugSession(childSession)];
    };

    const entries = await loadPackageEntriesFromSessions(
      'sample-service',
      resolveSessions,
      (message: string): void => { logs.push(message); },
      { loadedSourcesRequestTimeoutMs: 25 },
    );

    expect(entries).toHaveLength(1);
    expect(logs).toContain('[Packages] Attempt 1/15 for sample-service.');
    expect(logs.some((message) => message.includes('Retrying in 1000ms'))).toBe(true);
  });

  it('merges loaded sources from multiple descendant sessions and dedupes package files', async () => {
    const parentSession: MockDebugSession = {
      id: 'session-parent',
      name: 'Debug: sample-service',
      type: 'pwa-node',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };
    const childA: MockDebugSession = {
      id: 'session-child-a',
      name: 'Remote Process [0]',
      type: 'pwa-node',
      parentSession,
      customRequest: (): Promise<unknown> => Promise.resolve({
        sources: [
          {
            name: 'index.js',
            path: '/workspace/node_modules/sample-alpha/index.js',
          },
        ],
      }),
    };
    const childB: MockDebugSession = {
      id: 'session-child-b',
      name: 'Remote Process [1]',
      type: 'pwa-node',
      parentSession,
      customRequest: (): Promise<unknown> => Promise.resolve({
        sources: [
          {
            name: 'index.js',
            path: '/workspace/node_modules/sample-alpha/index.js',
          },
          {
            name: 'main.js',
            path: '/workspace/node_modules/.pnpm/sample-beta@1.0.0/node_modules/sample-beta/dist/main.js',
          },
        ],
      }),
    };

    const entries = await loadPackageEntriesFromSessions(
      'sample-service',
      [asDebugSession(parentSession), asDebugSession(childA), asDebugSession(childB)],
    );

    expect(entries.map((entry) => entry.name)).toEqual(['sample-alpha', 'sample-beta']);
    expect(entries[0]?.files).toHaveLength(1);
    expect(entries[1]?.files[0]?.source.debugSessionId).toBe('session-child-b');
  });

  it('continues across session errors and records diagnostics when another child session has sources', async () => {
    const logs: string[] = [];
    const parentSession: MockDebugSession = {
      id: 'session-parent',
      name: 'Debug: sample-service',
      type: 'pwa-node',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };
    const brokenChild: MockDebugSession = {
      id: 'session-child-broken',
      name: 'Remote Process [0]',
      type: 'pwa-node',
      parentSession,
      customRequest: (): Promise<unknown> => Promise.reject(new Error('adapter failed')),
    };
    const goodChild: MockDebugSession = {
      id: 'session-child-good',
      name: 'Remote Process [1]',
      type: 'pwa-node',
      parentSession,
      customRequest: (): Promise<unknown> => Promise.resolve({
        sources: [
          {
            name: 'index.js',
            path: '/workspace/node_modules/sample-client/index.js',
          },
        ],
      }),
    };

    const entries = await loadPackageEntriesFromSessions(
      'sample-service',
      [asDebugSession(parentSession), asDebugSession(brokenChild), asDebugSession(goodChild)],
      (message: string): void => { logs.push(message); },
    );

    expect(entries).toHaveLength(1);
    expect(logs.some((message) => message.includes('adapter failed'))).toBe(true);
    expect(logs.some((message) => message.includes('Candidate "Remote Process [0]"'))).toBe(true);
  });

  it('throws when no debug sessions are available for package browsing', async () => {
    await expect(loadPackageEntriesFromSessions('sample-service', [])).rejects.toThrow(/No active debug session/i);
  });

  it('throws when every candidate session returns zero loaded sources', async () => {
    const parentSession: MockDebugSession = {
      id: 'session-parent-empty',
      name: 'Debug: sample-service',
      type: 'pwa-node',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };
    const childSession: MockDebugSession = {
      id: 'session-child-empty',
      name: 'Remote Process [0]',
      type: 'pwa-node',
      parentSession,
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };

    await expect(loadPackageEntriesFromSessions(
      'sample-service',
      [asDebugSession(parentSession), asDebugSession(childSession)],
      undefined,
      {
        maxAttempts: 1,
        emptyRetryDelayMs: 1,
        loadedSourcesRequestTimeoutMs: 25,
      },
    )).rejects.toThrow(/No loaded sources/i);
  });

  it('times out hanging loadedSources requests instead of waiting forever', async () => {
    const parentSession: MockDebugSession = {
      id: 'session-parent-timeout',
      name: 'Debug: sample-service',
      type: 'pwa-node',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };
    const childSession: MockDebugSession = {
      id: 'session-child-timeout',
      name: 'Remote Process [0]',
      type: 'pwa-node',
      parentSession,
      customRequest: (): Promise<unknown> => new Promise<never>((resolve) => {
        void resolve;
        return undefined;
      }),
    };

    const outcome = await Promise.race([
      loadPackageEntriesFromSessions(
        'sample-service',
        [asDebugSession(parentSession), asDebugSession(childSession)],
        undefined,
        {
          maxAttempts: 1,
          emptyRetryDelayMs: 1,
          loadedSourcesRequestTimeoutMs: 25,
        },
      ).then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      ),
      delay(150).then(() => 'pending'),
    ]);

    expect(outcome).not.toBe('pending');
    expect(outcome).toMatch(/timed out/i);
  });

  it('logs when loaded sources exist but none match node_modules package paths', async () => {
    const logs: string[] = [];
    const parentSession: MockDebugSession = {
      id: 'session-parent-non-package',
      name: 'Debug: sample-service',
      type: 'pwa-node',
      customRequest: (): Promise<unknown> => Promise.resolve({
        sources: [
          {
            name: 'handler.js',
            path: '/workspace/srv/handler.js',
          },
          {
            name: 'shim.js',
            path: '/workspace/node_modules/.bin/sample-shim',
          },
        ],
      }),
    };

    const entries = await loadPackageEntriesFromSessions(
      'sample-service',
      [asDebugSession(parentSession)],
      (message: string): void => { logs.push(message); },
    );

    expect(entries).toEqual([]);
    expect(logs.some((message) => message.includes('none matched node_modules package paths'))).toBe(true);
  });

  it('filters package search results with valid regex and ignores invalid regex filters', async () => {
    const entries = buildPackageEntries([
      {
        name: 'index.js',
        path: '/workspace/node_modules/sample-client/dist/index.js',
      },
      {
        name: 'helper.js',
        path: '/workspace/node_modules/demo-helper/lib/helper.js',
      },
    ]);
    const index = createPackageSearchIndex(entries);

    const filteredEmptyQuery = await searchPackageEntries(index, '  ', {
      packageNameFilterRegex: '^sample-',
    });
    const invalidRegexResults = await searchPackageEntries(index, '', {
      packageNameFilterRegex: '[',
    });
    const excludedQueryResults = await searchPackageEntries(index, 'index', {
      packageNameFilterRegex: '^demo-',
    });

    expect(filteredEmptyQuery.map((entry) => entry.name)).toEqual(['sample-client']);
    expect(invalidRegexResults.map((entry) => entry.name)).toEqual(['demo-helper', 'sample-client']);
    expect(excludedQueryResults).toEqual([]);
  });

  it('searches package file contents and records the first matching line and column', async () => {
    const { entries, rootDir } = await createTempPackageEntries([
      {
        name: 'sample-client',
        files: [
          {
            relativePath: 'dist/client.js',
            content: [
              'const alpha = 1;',
              'function demo() {',
              '  sampleToken();',
              '}',
            ].join('\n'),
          },
        ],
      },
      {
        name: 'sample-worker',
        files: [
          {
            relativePath: 'dist/worker.js',
            content: 'export const workerReady = true;\n',
          },
        ],
      },
    ]);

    try {
      const index = createPackageSearchIndex(entries);
      const results = await searchPackageEntries(index, 'sampleToken');

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('sample-client');
      expect(results[0]?.files).toHaveLength(1);
      expect(results[0]?.files[0]?.match).toEqual(expect.objectContaining({
        kind: 'content',
        line: 3,
        column: 3,
        preview: expect.stringContaining('sampleToken'),
      }));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('searches package file contents through a local root when the debugger reports a remote pnpm path', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-package-remote-search-'));
    const localFilePath = createTempPackageFilePath(rootDir, '@sample-org/demo-kit', 'dist/main.js', '1.4.0');
    await mkdir(dirname(localFilePath), { recursive: true });
    await writeFile(
      localFilePath,
      [
        'export function createSampleKit() {',
        '  return "demo";',
        '}',
      ].join('\n'),
      'utf8',
    );

    const entries = buildPackageEntries([
      {
        name: 'main.js',
        path: 'file:///sample-app/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.js',
      },
    ]);

    try {
      const index = createPackageSearchIndex(entries, { localRoot: rootDir });
      const results = await searchPackageEntries(index, 'createSampleKit');

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('@sample-org/demo-kit');
      expect(results[0]?.files).toHaveLength(1);
      expect(results[0]?.files[0]?.match).toEqual(expect.objectContaining({
        kind: 'content',
        line: 1,
        column: 17,
        preview: expect.stringContaining('createSampleKit'),
      }));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('reuses cached package file contents across repeated content searches', async () => {
    const { entries, rootDir, filePaths } = await createTempPackageEntries([
      {
        name: 'sample-client',
        files: [
          {
            relativePath: 'dist/client.js',
            content: 'export function sampleCacheToken() { return true; }\n',
          },
        ],
      },
    ]);

    try {
      const index = createPackageSearchIndex(entries);
      const firstResults = await searchPackageEntries(index, 'sampleCacheToken');
      expect(firstResults).toHaveLength(1);

      const firstFilePath = filePaths[0];
      expect(firstFilePath).toBeDefined();
      if (!firstFilePath) {
        throw new Error('First package file path was not created.');
      }
      await rm(firstFilePath, { force: true });

      const secondResults = await searchPackageEntries(index, 'sampleCacheToken');
      expect(secondResults).toHaveLength(1);
      expect(secondResults[0]?.files[0]?.match).toEqual(expect.objectContaining({
        kind: 'content',
        line: 1,
        column: 17,
      }));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('tracks opened package URIs with cloned source and session metadata', () => {
    const uri = createTrackedPackageUri();
    const session: MockDebugSession = {
      id: 'session-track',
      name: 'Remote Process [0]',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };

    trackSamplePackageUri(uri, session);

    expect(getOpenedPackageUris('sample-service').map((openedUri) => openedUri.path)).toEqual([uri.path]);
    expect(findAppForOpenedPath(uri.path)).toBe('sample-service');

    const firstRecord = findOpenedPackageSourceByUri(asUri(uri));
    if (firstRecord?.source === undefined) {
      throw new Error('Expected tracked package source metadata.');
    }
    firstRecord.source.path = '/mutated/path.js';

    const clonedRecord = findOpenedPackageSourceByUri(asUri(uri));
    expect(clonedRecord).toEqual(expect.objectContaining({
      appName: 'sample-service',
      sessionId: 'session-track',
      sessionName: 'Remote Process [0]',
    }));
    expect(clonedRecord?.source).toEqual(expect.objectContaining({
      path: uri.path,
      sourceReference: 7,
      origin: 'debug-adapter',
      presentationHint: 'normal',
    }));

    trackOpenedPackageUri('sample-service', asUri(uri));

    const retainedRecord = findOpenedPackageSourceByUri(asUri(uri));
    expect(retainedRecord?.source?.sourceReference).toBe(7);
    expect(retainedRecord?.sessionId).toBe('session-track');

    clearOpenedPackageUris('sample-service');
    expect(getOpenedPackageUris('sample-service')).toEqual([]);
    expect(findOpenedPackageSourceByUri(asUri(uri))).toBeUndefined();
  });

  it('finds opened package source records by path when the URI string changes', () => {
    const originalQuery = createEncodedDebugQuery('session-a', '8');
    const alternateQuery = createEncodedDebugQuery('session-b', '8');
    const originalUri = createMockUri(
      `debug:/workspace/node_modules/sample-client/src/index.ts?${originalQuery}`,
      'debug',
      '/workspace/node_modules/sample-client/src/index.ts',
      undefined,
      originalQuery,
    );
    const alternateUri = createMockUri(
      `debug:/workspace/node_modules/sample-client/src/index.ts?${alternateQuery}`,
      'debug',
      originalUri.path,
      undefined,
      alternateQuery,
    );

    trackOpenedPackageUri('sample-service', asUri(originalUri), {
      name: 'index.ts',
      path: originalUri.path,
      sourceReference: 8,
    });

    const record = findOpenedPackageSourceByUri(asUri(alternateUri));

    expect(record).toEqual(expect.objectContaining({
      appName: 'sample-service',
      source: expect.objectContaining({
        name: 'index.ts',
        path: originalUri.path,
      }),
    }));
  });

  it('unregisters opened package URIs without disturbing sibling records', () => {
    const firstQuery = createEncodedDebugQuery('session-one');
    const secondQuery = createEncodedDebugQuery('session-two');
    const firstUri = createMockUri(
      `debug:/workspace/node_modules/sample-client/src/first.ts?${firstQuery}`,
      'debug',
      '/workspace/node_modules/sample-client/src/first.ts',
      undefined,
      firstQuery,
    );
    const secondUri = createMockUri(
      `debug:/workspace/node_modules/sample-client/src/second.ts?${secondQuery}`,
      'debug',
      '/workspace/node_modules/sample-client/src/second.ts',
      undefined,
      secondQuery,
    );

    trackOpenedPackageUri('sample-service', asUri(firstUri));
    trackOpenedPackageUri('sample-service', asUri(secondUri));

    unregisterOpenedPackageUri('sample-service', asUri(firstUri));

    expect(getOpenedPackageUris('sample-service').map((uri) => uri.path)).toEqual([secondUri.path]);

    unregisterOpenedPackageUri('sample-service', asUri(secondUri));
    unregisterOpenedPackageUri('sample-api', asUri(secondUri));

    expect(getOpenedPackageUris('sample-service')).toEqual([]);
  });

  it('extracts debug session ids from raw, encoded, and malformed debug URI queries', () => {
    const cases: { query?: string; expected: string | null }[] = [
      { expected: null },
      { query: '', expected: null },
      { query: 'session=session-a&ref=7', expected: 'session-a' },
      { query: createEncodedDebugQuery('session-b', '8'), expected: 'session-b' },
      { query: 'ref=9&session=session%20c', expected: 'session c' },
      { query: 'session=session%ZZ', expected: 'session%ZZ' },
      { query: '%E0%A4%A', expected: null },
      { query: 'ref-without-value', expected: null },
    ];

    for (const testCase of cases) {
      const uri = createMockUri(
        `debug:/workspace/node_modules/sample-client/src/index.ts?${testCase.query ?? ''}`,
        'debug',
        '/workspace/node_modules/sample-client/src/index.ts',
        undefined,
        testCase.query,
      );

      expect(extractSessionIdFromDebugUri(asUri(uri))).toBe(testCase.expected);
    }
  });

  it('opens package sources via debug URIs when sourceReference is present', async () => {
    const session: MockDebugSession = {
      id: 'session-2',
      name: 'Debug: sample-service',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };

    await openPackageSource(asDebugSession(session), {
      name: 'runtime.js',
      path: '/workspace/node_modules/sample-runtime/dist/runtime.js',
      sourceReference: 91,
    });

    expect(vscodeMockState.asDebugSourceUri).toHaveBeenCalledTimes(1);
    expect(vscodeMockState.openTextDocument).toHaveBeenCalledTimes(1);
    expect(vscodeMockState.showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: expect.objectContaining({
          scheme: 'debug',
        }),
      }),
      expect.objectContaining({ preview: true }),
    );
  });

  it('never writes a sourcesContent-only .ts to disk and opens a debug URI instead', async () => {
    // Option A: CDS Debug must NOT materialize package source to disk. A `.ts` that the
    // debugger only serves via `sourcesContent` (no on-disk file) is opened through a
    // `debug:` URI, where vscode-js-debug binds the breakpoint by `sourceReference` and
    // the pre-stop cleanup clears it — no node_modules pollution.
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-package-no-write-'));
    const sourcePath = join(
      rootDir,
      'node_modules',
      '.pnpm',
      'sample-client@1.0.0',
      'node_modules',
      'sample-client',
      'src',
      'client.ts',
    );
    const requests: string[] = [];
    const session: MockDebugSession = {
      id: 'session-no-write',
      name: 'Debug: sample-service',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        void args;
        requests.push(command);
        if (command === 'source') return Promise.resolve({ content: 'must not be written' });
        return Promise.resolve({ sources: [] });
      },
    };
    vscodeMockState.workspaceFolders = [{ uri: { fsPath: rootDir } }];

    try {
      await openPackageSource(asDebugSession(session), {
        name: 'client.ts',
        path: sourcePath,
        sourceReference: 91,
      });

      // No file created on disk.
      await expect(access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
      // No DAP `source` content fetch — there is nothing to write.
      expect(requests).not.toContain('source');
      // Opened via a debug: URI.
      expect(vscodeMockState.asDebugSourceUri).toHaveBeenCalledTimes(1);
      expect(vscodeMockState.openTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({ scheme: 'debug' }),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('never writes to an ancestor node_modules root and opens a debug URI instead', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-package-ancestor-'));
    const localRoot = join(rootDir, 'apps', 'sample-service');
    const unrelatedWorkspace = join(rootDir, 'workspace-shell');
    const sourcePath = join(
      rootDir,
      'node_modules',
      '.pnpm',
      '@sample-org+demo-helper@1.2.3',
      'node_modules',
      '@sample-org',
      'demo-helper',
      'src',
      'handler.ts',
    );
    const requests: string[] = [];
    const session: MockDebugSession = {
      id: 'session-ancestor-no-write',
      name: 'Debug: sample-service',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        void args;
        requests.push(command);
        if (command === 'source') return Promise.resolve({ content: 'must not be written' });
        return Promise.resolve({ sources: [] });
      },
    };
    vscodeMockState.workspaceFolders = [{ uri: { fsPath: unrelatedWorkspace } }];

    try {
      await mkdir(localRoot, { recursive: true });
      await mkdir(unrelatedWorkspace, { recursive: true });

      await openPackageSource(
        asDebugSession(session),
        {
          name: 'handler.ts',
          path: sourcePath,
          sourceReference: 417,
        },
        undefined,
        { localRoot },
      );

      await expect(access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(requests).not.toContain('source');
      expect(vscodeMockState.asDebugSourceUri).toHaveBeenCalledTimes(1);
      expect(vscodeMockState.openTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({ scheme: 'debug' }),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('falls back to local file URIs when no sourceReference is available', async () => {
    const session: MockDebugSession = {
      id: 'session-3',
      name: 'Debug: sample-service',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };

    await openPackageSource(asDebugSession(session), {
      name: 'index.js',
      path: 'file:///workspace/node_modules/@sample-org/demo-core/lib/index.js',
    });

    expect(vscodeMockState.asDebugSourceUri).not.toHaveBeenCalled();
    expect(vscodeMockState.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        scheme: 'file',
        path: '/workspace/node_modules/@sample-org/demo-core/lib/index.js',
      }),
    );
    expect(vscodeMockState.showTextDocument).toHaveBeenCalledTimes(1);
  });

  it('opens plain filesystem paths via Uri.file', async () => {
    const session: MockDebugSession = {
      id: 'session-3b',
      name: 'Debug: sample-service',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };

    await openPackageSource(asDebugSession(session), {
      name: 'index.js',
      path: '/workspace/node_modules/sample-client/dist/index.js',
    });

    expect(vscodeMockState.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        scheme: 'file',
        path: '/workspace/node_modules/sample-client/dist/index.js',
      }),
    );
  });

  it('opens remote package paths through the provided local root fallback when the file exists', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-package-local-root-'));
    const localRoot = join(rootDir, 'sample-service');
    const localPackagePath = join(
      localRoot,
      'node_modules',
      '.pnpm',
      '@sample-org+demo-kit@1.4.0',
      'node_modules',
      '@sample-org',
      'demo-kit',
      'dist',
      'main.js',
    );
    const session: MockDebugSession = {
      id: 'session-3e',
      name: 'Debug: sample-service',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };

    try {
      await mkdir(dirname(localPackagePath), { recursive: true });
      await writeFile(localPackagePath, 'export const sample = true;\n', 'utf8');

      await openPackageSource(
        asDebugSession(session),
        {
          name: 'main.js',
          path: '/sample-app/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.js',
        },
        undefined,
        { localRoot },
      );

      const openedUri = vscodeMockState.openTextDocument.mock.calls[0]?.[0] as MockUri | undefined;
      expect(openedUri?.scheme).toBe('file');
      expect(openedUri?.path.endsWith('/sample-service/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.js')).toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('opens path-only URI package sources without inventing a mapped node_modules file', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-package-uri-source-'));
    const localRoot = join(rootDir, 'sample-service');
    const sourcePath = 'vscode-remote://sample-host/home/sample/workspace/sample-service/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.ts';
    const session: MockDebugSession = {
      id: 'session-uri-path',
      name: 'Debug: sample-service',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };

    try {
      await mkdir(localRoot, { recursive: true });

      await openPackageSource(
        asDebugSession(session),
        {
          name: 'main.ts',
          path: sourcePath,
          sourceReference: 0,
        },
        undefined,
        { localRoot },
      );

      expect(vscodeMockState.asDebugSourceUri).not.toHaveBeenCalled();
      expect(vscodeMockState.openTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          scheme: 'vscode-remote',
        }),
      );
      expect(await pathExists(join(localRoot, 'node_modules'))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('does not materialize source-reference packages into a missing mapped localRoot fallback', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'cds-debug-package-no-local-root-materialize-'));
    const localRoot = join(rootDir, 'sample-service');
    const sourceContent = 'export function createSampleClient() { return true; }\n';
    const requests: string[] = [];
    const session: MockDebugSession = {
      id: 'session-no-local-root-materialize',
      name: 'Debug: sample-service',
      customRequest: (command: string, args: unknown): Promise<unknown> => {
        void args;
        requests.push(command);
        if (command === 'source') return Promise.resolve({ content: sourceContent });
        return Promise.resolve({ sources: [] });
      },
    };

    try {
      await mkdir(localRoot, { recursive: true });

      await openPackageSource(
        asDebugSession(session),
        {
          name: 'client.ts',
          path: '/remote-sample-service/node_modules/.pnpm/sample-client@1.0.0/node_modules/sample-client/src/client.ts',
          sourceReference: 91,
        },
        undefined,
        { localRoot },
      );

      expect(requests).toEqual([]);
      expect(vscodeMockState.asDebugSourceUri).toHaveBeenCalledTimes(1);
      expect(vscodeMockState.openTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          scheme: 'debug',
        }),
      );
      expect(await pathExists(join(localRoot, 'node_modules'))).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('reveals the requested line and column when opening a matched package source', async () => {
    const session: MockDebugSession = {
      id: 'session-3d',
      name: 'Debug: sample-service',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };
    const revealRange = vi.fn();
    vscodeMockState.showTextDocument.mockResolvedValue({ revealRange });

    await openPackageSource(
      asDebugSession(session),
      {
        name: 'client.js',
        path: 'file:///workspace/node_modules/sample-client/dist/client.js',
      },
      {
        line: 4,
        column: 6,
      },
    );

    const showOptions = vscodeMockState.showTextDocument.mock.calls[0]?.[1];
    expect(showOptions).toEqual(expect.objectContaining({
      preview: true,
      selection: expect.objectContaining({
        start: expect.objectContaining({
          line: 3,
          character: 5,
        }),
        end: expect.objectContaining({
          line: 3,
          character: 5,
        }),
      }),
    }));
    expect(revealRange).toHaveBeenCalledWith(
      expect.objectContaining({
        start: expect.objectContaining({
          line: 3,
          character: 5,
        }),
      }),
      vscodeMockState.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  });

  it('throws when a package source cannot be opened without a path or sourceReference', async () => {
    const session: MockDebugSession = {
      id: 'session-3c',
      name: 'Debug: sample-service',
      customRequest: (): Promise<unknown> => Promise.resolve({ sources: [] }),
    };

    await expect(openPackageSource(asDebugSession(session), {
      name: 'virtual.js',
    })).rejects.toThrow(/cannot be opened/i);
  });

  it('throws when loadedSources does not return a sources array', async () => {
    const session: MockDebugSession = {
      id: 'session-4',
      name: 'Debug: sample-service',
      customRequest: (): Promise<unknown> => Promise.resolve({ bad: true }),
    };

    await expect(loadPackageEntries(asDebugSession(session))).rejects.toThrow(/loaded sources/i);
  });
});
