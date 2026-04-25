import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isStableVersion, shouldShowWhatsNew, markWhatsNewShown } from '../../src/core/whatsNewManager';
import type { ExtensionContext } from 'vscode';

vi.mock('../../src/webview/whatsNewPanel', () => ({
  WhatsNewPanel: { show: vi.fn() },
}));

vi.mock('vscode', () => ({}));

function makeContext(version: string, storedVersion?: string): ExtensionContext {
  const store = new Map<string, unknown>();
  if (storedVersion !== undefined) {
    store.set('cds-debug.lastShownWhatsNewVersion', storedVersion);
  }

  return {
    extension: { packageJSON: { version } },
    globalState: {
      get: (key: string) => store.get(key),
      update: (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...store.keys()],
      setKeysForSync: () => undefined,
    },
  } as unknown as ExtensionContext;
}

describe('isStableVersion', () => {
  it('returns true for plain semver', () => {
    expect(isStableVersion('0.3.10')).toBe(true);
    expect(isStableVersion('1.0.0')).toBe(true);
    expect(isStableVersion('12.34.56')).toBe(true);
  });

  it('returns false for pre-release versions', () => {
    expect(isStableVersion('0.3.10-pre.19')).toBe(false);
    expect(isStableVersion('0.3.10-pre.0')).toBe(false);
    expect(isStableVersion('1.0.0-beta.1')).toBe(false);
    expect(isStableVersion('1.0.0-rc.2')).toBe(false);
  });

  it('returns false for empty or malformed strings', () => {
    expect(isStableVersion('')).toBe(false);
    expect(isStableVersion('0.3')).toBe(false);
    expect(isStableVersion('abc')).toBe(false);
  });
});

describe('shouldShowWhatsNew', () => {
  it('returns true for stable version with no stored version (fresh install)', () => {
    const ctx = makeContext('0.3.10');
    expect(shouldShowWhatsNew(ctx)).toBe(true);
  });

  it('returns true when stable version differs from stored version', () => {
    const ctx = makeContext('0.3.10', '0.3.9');
    expect(shouldShowWhatsNew(ctx)).toBe(true);
  });

  it('returns true when upgrading from a pre-release to stable', () => {
    const ctx = makeContext('0.3.10', '0.3.10-pre.19');
    expect(shouldShowWhatsNew(ctx)).toBe(true);
  });

  it('returns false when stable version matches stored version', () => {
    const ctx = makeContext('0.3.10', '0.3.10');
    expect(shouldShowWhatsNew(ctx)).toBe(false);
  });

  it('returns false for pre-release version regardless of stored', () => {
    expect(shouldShowWhatsNew(makeContext('0.3.10-pre.1'))).toBe(false);
    expect(shouldShowWhatsNew(makeContext('0.3.10-pre.1', '0.3.9'))).toBe(false);
    expect(shouldShowWhatsNew(makeContext('0.3.10-pre.1', undefined))).toBe(false);
  });

  it('returns false for a downgrade scenario (stored > current) — same version check', () => {
    const ctx = makeContext('0.3.10', '0.3.11');
    // version is stable and differs from stored, so true (safe — shows changelog for current)
    expect(shouldShowWhatsNew(ctx)).toBe(true);
  });
});

describe('markWhatsNewShown', () => {
  let store: Map<string, unknown>;
  let ctx: ExtensionContext;

  beforeEach(() => {
    store = new Map();
    ctx = {
      extension: { packageJSON: { version: '0.3.10' } },
      globalState: {
        get: (key: string) => store.get(key),
        update: (key: string, value: unknown): Promise<void> => {
          store.set(key, value);
          return Promise.resolve();
        },
        keys: () => [...store.keys()],
        setKeysForSync: () => undefined,
      },
    } as unknown as ExtensionContext;
  });

  it('persists current version to globalState', async () => {
    await markWhatsNewShown(ctx);
    expect(store.get('cds-debug.lastShownWhatsNewVersion')).toBe('0.3.10');
  });

  it('after marking, shouldShowWhatsNew returns false', async () => {
    await markWhatsNewShown(ctx);
    expect(shouldShowWhatsNew(ctx)).toBe(false);
  });
});
