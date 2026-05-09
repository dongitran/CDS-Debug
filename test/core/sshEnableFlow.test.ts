import type { OutputChannel } from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cfClientMockState, channelMockState } = vi.hoisted(() => ({
  cfClientMockState: {
    cfSshEnabled: vi.fn(),
    cfEnableSsh: vi.fn(),
    cfRestartApp: vi.fn(),
  },
  channelMockState: {
    appendLine: vi.fn(),
  },
}));

vi.mock('../../src/core/cfClient', () => ({
  cfSshEnabled: cfClientMockState.cfSshEnabled,
  cfEnableSsh: cfClientMockState.cfEnableSsh,
  cfRestartApp: cfClientMockState.cfRestartApp,
}));

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

import { ensureSshEnabledForDebug, type SshEnableStatus } from '../../src/core/sshEnableFlow';

function mockChannel(): OutputChannel {
  return channelMockState as unknown as OutputChannel;
}

beforeEach(() => {
  cfClientMockState.cfSshEnabled.mockReset();
  cfClientMockState.cfEnableSsh.mockReset();
  cfClientMockState.cfRestartApp.mockReset();
  channelMockState.appendLine.mockClear();
});

describe('ensureSshEnabledForDebug', () => {
  it('restarts the app when SSH is already enabled', async () => {
    cfClientMockState.cfSshEnabled.mockResolvedValue(true);
    cfClientMockState.cfRestartApp.mockResolvedValue(undefined);
    const statuses: SshEnableStatus[] = [];

    await expect(ensureSshEnabledForDebug('demo-app', mockChannel(), (status) => {
      statuses.push(status);
    })).resolves.toBe(true);

    expect(cfClientMockState.cfEnableSsh).not.toHaveBeenCalled();
    expect(cfClientMockState.cfRestartApp).toHaveBeenCalledWith('demo-app');
    expect(statuses).toEqual(['SSH_RESTARTING']);
  });

  it('enables SSH before restarting when SSH is disabled', async () => {
    cfClientMockState.cfSshEnabled.mockResolvedValue(false);
    cfClientMockState.cfEnableSsh.mockResolvedValue(undefined);
    cfClientMockState.cfRestartApp.mockResolvedValue(undefined);
    const statuses: SshEnableStatus[] = [];

    await expect(ensureSshEnabledForDebug('demo-app', mockChannel(), (status) => {
      statuses.push(status);
    })).resolves.toBe(true);

    expect(cfClientMockState.cfEnableSsh).toHaveBeenCalledWith('demo-app');
    expect(statuses).toEqual(['SSH_ENABLING', 'SSH_RESTARTING']);
  });

  it('returns false and emits ERROR when enabling SSH fails', async () => {
    cfClientMockState.cfSshEnabled.mockResolvedValue(false);
    cfClientMockState.cfEnableSsh.mockRejectedValue(new Error('not allowed'));
    const events: { status: SshEnableStatus; message?: string }[] = [];

    await expect(ensureSshEnabledForDebug('demo-app', mockChannel(), (status, message) => {
      events.push(message === undefined ? { status } : { status, message });
    })).resolves.toBe(false);

    expect(cfClientMockState.cfRestartApp).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ status: 'ERROR', message: 'Failed to enable SSH: not allowed' });
  });

  it('returns false and emits ERROR when restart fails', async () => {
    cfClientMockState.cfSshEnabled.mockResolvedValue(true);
    cfClientMockState.cfRestartApp.mockRejectedValue(new Error('restart failed'));
    const events: { status: SshEnableStatus; message?: string }[] = [];

    await expect(ensureSshEnabledForDebug('demo-app', mockChannel(), (status, message) => {
      events.push(message === undefined ? { status } : { status, message });
    })).resolves.toBe(false);

    expect(events.at(-1)).toEqual({ status: 'ERROR', message: 'App restart failed: restart failed' });
  });
});
