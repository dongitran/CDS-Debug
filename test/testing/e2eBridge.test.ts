import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyE2eBridgeCommand,
  clearE2eBridgeState,
  getE2eActiveDebugSessionForApp,
  getE2eDebugSessionById,
  getE2eDebugSessionsForApp,
  isE2eModeEnabled,
} from '../../src/testing/e2eBridge';

const originalE2eMode = process.env.CDS_DEBUG_E2E_MODE;

function createPackageFixture() {
  return [
    {
      id: '@sample-org/demo-kit@1.4.0',
      name: '@sample-org/demo-kit',
      displayName: '@sample-org/demo-kit@1.4.0',
      version: '1.4.0',
      files: [
        {
          id: '@sample-org/demo-kit@1.4.0:dist/main.js',
          label: 'dist/main.js',
          relativePath: 'dist/main.js',
          source: {
            name: 'main.js',
            path: '/workspace/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.js',
          },
        },
      ],
      tree: [],
    },
  ];
}

describe('e2eBridge', () => {
  beforeEach(() => {
    process.env.CDS_DEBUG_E2E_MODE = '1';
    clearE2eBridgeState();
  });

  afterEach(() => {
    clearE2eBridgeState();
    if (originalE2eMode === undefined) {
      delete process.env.CDS_DEBUG_E2E_MODE;
      return;
    }
    process.env.CDS_DEBUG_E2E_MODE = originalE2eMode;
  });

  it('reports whether E2E mode is enabled', () => {
    expect(isE2eModeEnabled()).toBe(true);
    delete process.env.CDS_DEBUG_E2E_MODE;
    expect(isE2eModeEnabled()).toBe(false);
  });

  it('creates a fake root session and child loadedSources session from package fixtures', async () => {
    applyE2eBridgeCommand({
      action: 'SET_PACKAGE_FIXTURE',
      payload: {
        appName: 'sample-service',
        packages: createPackageFixture(),
      },
    });

    const rootSession = getE2eActiveDebugSessionForApp('sample-service');
    const sessions = getE2eDebugSessionsForApp('sample-service');

    expect(rootSession?.name).toBe('Debug: sample-service');
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.parentSession?.id).toBe(rootSession?.id);

    const response = await sessions[1]?.customRequest('loadedSources', {});
    expect(response).toEqual({
      sources: [
        {
          name: 'main.js',
          path: '/workspace/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.js',
        },
      ],
    });
  });

  it('can return empty loadedSources before packages become available', async () => {
    applyE2eBridgeCommand({
      action: 'SET_PACKAGE_FIXTURE',
      payload: {
        appName: 'sample-service',
        packages: createPackageFixture(),
        loadedSourcesPlan: [
          { kind: 'empty', delayMs: 5 },
          { kind: 'packages', delayMs: 5 },
        ],
      },
    });

    const childSession = getE2eDebugSessionsForApp('sample-service')[1];
    expect(childSession).toBeDefined();

    await expect(childSession?.customRequest('loadedSources', {})).resolves.toEqual({ sources: [] });
    await expect(childSession?.customRequest('loadedSources', {})).resolves.toEqual({
      sources: [
        {
          name: 'main.js',
          path: '/workspace/node_modules/.pnpm/@sample-org+demo-kit@1.4.0/node_modules/@sample-org/demo-kit/dist/main.js',
        },
      ],
    });
  });

  it('can simulate a hanging loadedSources request', async () => {
    applyE2eBridgeCommand({
      action: 'SET_PACKAGE_FIXTURE',
      payload: {
        appName: 'sample-service',
        packages: createPackageFixture(),
        loadedSourcesPlan: [{ kind: 'hang' }],
      },
    });

    const childSession = getE2eDebugSessionsForApp('sample-service')[1];
    expect(childSession).toBeDefined();

    const pendingRequest = childSession?.customRequest('loadedSources', {});
    const outcome = await Promise.race([
      pendingRequest?.then(() => 'resolved', () => 'rejected'),
      delay(50).then(() => 'pending'),
    ]);

    expect(outcome).toBe('pending');
  });

  it('can look up fake sessions by id and clear fixtures', () => {
    applyE2eBridgeCommand({
      action: 'SET_PACKAGE_FIXTURE',
      payload: {
        appName: 'sample-service',
        packages: createPackageFixture(),
      },
    });

    const childSession = getE2eDebugSessionsForApp('sample-service')[1];
    expect(childSession).toBeDefined();
    expect(getE2eDebugSessionById(childSession?.id ?? '')?.name).toBe('Remote Process [0]');

    applyE2eBridgeCommand({ action: 'CLEAR_PACKAGE_FIXTURES' });
    expect(getE2eDebugSessionsForApp('sample-service')).toEqual([]);
    expect(getE2eActiveDebugSessionForApp('sample-service')).toBeUndefined();
  });
});
