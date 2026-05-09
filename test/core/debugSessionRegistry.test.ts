import type * as vscode from 'vscode';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearDebugSessionRegistry,
  DEBUG_SESSION_PREFIX,
  getActiveDebugSessionForApp,
  getDebugSessionById,
  getDebugSessionsForApp,
  hasActiveVsCodeSession,
  trackStartedDebugSession,
  untrackDebugSession,
} from '../../src/core/debugSessionRegistry';

function session(id: string, name: string, parentSession?: vscode.DebugSession): vscode.DebugSession {
  const base = {
    id,
    name,
    type: 'pwa-node',
    customRequest: () => Promise.resolve(undefined),
  };
  return parentSession === undefined
    ? base as unknown as vscode.DebugSession
    : { ...base, parentSession } as unknown as vscode.DebugSession;
}

beforeEach(() => {
  clearDebugSessionRegistry();
});

describe('debugSessionRegistry', () => {
  it('tracks active root sessions by CDS Debug app name', () => {
    const root = session('root-1', `${DEBUG_SESSION_PREFIX}demo-app`);

    trackStartedDebugSession(root);

    expect(getActiveDebugSessionForApp('demo-app')).toBe(root);
    expect(getDebugSessionById('root-1')).toBe(root);
    expect(hasActiveVsCodeSession(`${DEBUG_SESSION_PREFIX}demo-app`)).toBe(true);
  });

  it('returns child sessions after the root session for an app', () => {
    const root = session('root-1', `${DEBUG_SESSION_PREFIX}demo-app`);
    const child = session('child-1', 'Remote Process [0]', root);
    const grandchild = session('grandchild-1', 'worker', child);

    trackStartedDebugSession(grandchild);
    trackStartedDebugSession(child);
    trackStartedDebugSession(root);

    expect(getDebugSessionsForApp('demo-app')).toEqual([root, child, grandchild]);
  });

  it('ignores unrelated sessions and removes terminated sessions', () => {
    const root = session('root-1', `${DEBUG_SESSION_PREFIX}demo-app`);
    const unrelated = session('manual-1', 'Manual Launch');

    trackStartedDebugSession(root);
    trackStartedDebugSession(unrelated);
    untrackDebugSession(root);

    expect(getActiveDebugSessionForApp('demo-app')).toBeUndefined();
    expect(getDebugSessionsForApp('demo-app')).toEqual([]);
    expect(hasActiveVsCodeSession('Manual Launch')).toBe(true);
  });
});
