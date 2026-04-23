import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugSession } from 'vscode';

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
  toString(): string;
}

const { vscodeMockState } = vi.hoisted(() => ({
  vscodeMockState: {
    asDebugSourceUri: vi.fn(),
    openTextDocument: vi.fn(),
    showTextDocument: vi.fn(),
  },
}));

function createMockUri(raw: string, scheme: string, path: string, fsPath?: string): MockUri {
  const uri: MockUri = {
    scheme,
    path,
    toString: (): string => raw,
  };
  if (fsPath !== undefined) {
    uri.fsPath = fsPath;
  }
  return uri;
}

function asDebugSession(session: MockDebugSession): DebugSession {
  return session as unknown as DebugSession;
}

vi.mock('vscode', () => ({
  debug: {
    asDebugSourceUri: vscodeMockState.asDebugSourceUri,
  },
  workspace: {
    openTextDocument: vscodeMockState.openTextDocument,
  },
  window: {
    showTextDocument: vscodeMockState.showTextDocument,
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
}));

import {
  buildPackageEntries,
  loadPackageEntries,
  loadPackageEntriesFromSessions,
  openPackageSource,
} from '../../src/core/packageSourceBrowser';

beforeEach(() => {
  vscodeMockState.asDebugSourceUri.mockReset();
  vscodeMockState.openTextDocument.mockReset();
  vscodeMockState.showTextDocument.mockReset();
  vscodeMockState.asDebugSourceUri.mockImplementation((source: { path?: string; name?: string }) =>
    createMockUri(
      `debug:${source.path ?? source.name ?? 'unknown'}`,
      'debug',
      source.path ?? source.name ?? 'unknown',
    ));
  vscodeMockState.openTextDocument.mockResolvedValue({ uri: createMockUri('debug:default', 'debug', 'default') });
  vscodeMockState.showTextDocument.mockResolvedValue(undefined);
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
    )).rejects.toThrow(/No loaded sources/i);
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
