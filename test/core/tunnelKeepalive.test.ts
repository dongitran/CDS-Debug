import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTunnelKeepalive } from '../../src/core/tunnelKeepalive';

interface MockDebugSession {
  customRequest: ReturnType<typeof vi.fn>;
}

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

function createSession(customRequest: ReturnType<typeof vi.fn>): MockDebugSession {
  return { customRequest };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startTunnelKeepalive', () => {
  it('sends a threads request on the configured interval', async () => {
    const customRequest = vi.fn().mockResolvedValue({ threads: [] });
    const onFailure = vi.fn();
    const dispose = startTunnelKeepalive(
      createSession(customRequest) as unknown as Parameters<typeof startTunnelKeepalive>[0],
      'demo-app',
      10,
      onFailure,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(customRequest).toHaveBeenCalledWith('threads', {});
    expect(onFailure).not.toHaveBeenCalled();
    dispose();
  });

  it('calls the failure callback after three consecutive failed pings', async () => {
    const customRequest = vi.fn().mockRejectedValue(new Error('adapter down'));
    const onFailure = vi.fn();
    const dispose = startTunnelKeepalive(
      createSession(customRequest) as unknown as Parameters<typeof startTunnelKeepalive>[0],
      'failing-app',
      5,
      onFailure,
    );

    await vi.advanceTimersByTimeAsync(15_000);

    expect(customRequest).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledOnce();
    dispose();
  });

  it('resets the consecutive failure count after a successful ping', async () => {
    const customRequest = vi.fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce({ threads: [] })
      .mockRejectedValueOnce(new Error('second fail'))
      .mockRejectedValueOnce(new Error('third fail'));
    const onFailure = vi.fn();
    const dispose = startTunnelKeepalive(
      createSession(customRequest) as unknown as Parameters<typeof startTunnelKeepalive>[0],
      'reset-app',
      5,
      onFailure,
    );

    await vi.advanceTimersByTimeAsync(20_000);

    expect(customRequest).toHaveBeenCalledTimes(4);
    expect(onFailure).not.toHaveBeenCalled();
    dispose();
  });

  it('clears the interval when disposed', async () => {
    const customRequest = vi.fn().mockResolvedValue({ threads: [] });
    const dispose = startTunnelKeepalive(
      createSession(customRequest) as unknown as Parameters<typeof startTunnelKeepalive>[0],
      'disposed-app',
      5,
      vi.fn(),
    );

    dispose();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(customRequest).not.toHaveBeenCalled();
  });

  it('returns a no-op dispose when disabled with interval 0', async () => {
    const customRequest = vi.fn().mockResolvedValue({ threads: [] });
    const dispose = startTunnelKeepalive(
      createSession(customRequest) as unknown as Parameters<typeof startTunnelKeepalive>[0],
      'disabled-app',
      0,
      vi.fn(),
    );

    dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(customRequest).not.toHaveBeenCalled();
  });
});
