import type * as vscode from 'vscode';

export const DEBUG_SESSION_PREFIX = 'Debug: ';

const activeDebugSessions = new Map<string, vscode.DebugSession>();
const activeVsCodeSessionCounts = new Map<string, number>();

export function trackStartedDebugSession(session: vscode.DebugSession): void {
  const previous = activeDebugSessions.get(session.id);
  if (previous !== undefined) decrementSessionName(previous.name);
  activeVsCodeSessionsIncrement(session.name);
  activeDebugSessions.set(session.id, session);
}

export function untrackDebugSession(session: vscode.DebugSession): void {
  if (!activeDebugSessions.has(session.id)) return;
  activeDebugSessions.delete(session.id);
  decrementSessionName(session.name);
}

export function getActiveDebugSessionForApp(appName: string): vscode.DebugSession | undefined {
  const rootSessionName = `${DEBUG_SESSION_PREFIX}${appName}`;
  return Array.from(activeDebugSessions.values()).find((session) => session.name === rootSessionName);
}

export function getDebugSessionsForApp(appName: string): vscode.DebugSession[] {
  return Array.from(activeDebugSessions.values())
    .filter((session) => sessionBelongsToApp(session, appName))
    .sort((left, right) => sessionDepthWithinApp(left, appName) - sessionDepthWithinApp(right, appName));
}

export function getDebugSessionById(sessionId: string): vscode.DebugSession | undefined {
  return Array.from(activeDebugSessions.values()).find((session) => session.id === sessionId);
}

export function hasActiveVsCodeSession(sessionName: string): boolean {
  return activeVsCodeSessionCounts.has(sessionName);
}

export function clearDebugSessionRegistry(): void {
  activeDebugSessions.clear();
  activeVsCodeSessionCounts.clear();
}

function activeVsCodeSessionsIncrement(sessionName: string): void {
  activeVsCodeSessionCounts.set(sessionName, (activeVsCodeSessionCounts.get(sessionName) ?? 0) + 1);
}

function decrementSessionName(sessionName: string): void {
  const count = activeVsCodeSessionCounts.get(sessionName);
  if (count === undefined) return;
  if (count <= 1) {
    activeVsCodeSessionCounts.delete(sessionName);
    return;
  }
  activeVsCodeSessionCounts.set(sessionName, count - 1);
}

function sessionBelongsToApp(session: vscode.DebugSession, appName: string): boolean {
  const rootSessionName = `${DEBUG_SESSION_PREFIX}${appName}`;
  if (session.name === rootSessionName) return true;
  let parent = session.parentSession;
  while (parent) {
    if (parent.name === rootSessionName) return true;
    parent = parent.parentSession;
  }
  return false;
}

function sessionDepthWithinApp(session: vscode.DebugSession, appName: string): number {
  const rootSessionName = `${DEBUG_SESSION_PREFIX}${appName}`;
  let depth = 0;
  let current: vscode.DebugSession | undefined = session;
  while (current) {
    if (current.name === rootSessionName) return depth;
    current = current.parentSession;
    depth += 1;
  }
  return Number.MAX_SAFE_INTEGER;
}
