import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

import {
  incrementLocalTelemetryCounter,
  initializeLocalTelemetry,
  readLocalTelemetryCounters,
} from '../../src/core/localTelemetry';

function makeContext(initial?: Record<string, unknown>): Parameters<typeof initializeLocalTelemetry>[0] {
  const store = new Map<string, unknown>();
  if (initial !== undefined) {
    store.set('cds-debug.localTelemetryCounters', initial);
  }
  return {
    globalState: {
      get: (key: string): unknown => store.get(key),
      update: (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as Parameters<typeof initializeLocalTelemetry>[0];
}

describe('localTelemetry', () => {
  beforeEach(() => {
    initializeLocalTelemetry(makeContext());
  });

  it('increments local counters in globalState', async () => {
    await incrementLocalTelemetryCounter('remoteInspectorReminderShown');
    await incrementLocalTelemetryCounter('remoteInspectorReminderShown');
    await incrementLocalTelemetryCounter('keepaliveReconnectTriggered');

    expect(readLocalTelemetryCounters()).toEqual({
      remoteInspectorReminderShown: 2,
      keepaliveReconnectTriggered: 1,
    });
  });

  it('ignores unknown stored fields when reading counters', () => {
    initializeLocalTelemetry(makeContext({
      remoteInspectorReminderShown: 1,
      unknown: 99,
      keepaliveReconnectTriggered: 'bad',
    }));

    expect(readLocalTelemetryCounters()).toEqual({
      remoteInspectorReminderShown: 1,
    });
  });
});
