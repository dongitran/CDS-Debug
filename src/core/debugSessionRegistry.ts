import type * as vscode from 'vscode';

export const DEBUG_SESSION_PREFIX = 'Debug: ';

const activeDebugSessions = new Map<string, vscode.DebugSession>();
const activeVsCodeSessions = new Set<string>();

export function trackStartedDebugSession(session: vscode.DebugSession): void {
  activeVsCodeSessions.add(session.name);
  activeDebugSessions.set(session.name, session);
}

export function untrackDebugSession(session: vscode.DebugSession): void {
  activeVsCodeSessions.delete(session.name);
  activeDebugSessions.delete(session.name);
}

export function getActiveDebugSessionForApp(appName: string): vscode.DebugSession | undefined {
  return activeDebugSessions.get(`${DEBUG_SESSION_PREFIX}${appName}`);
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
  return activeVsCodeSessions.has(sessionName);
}

export function clearDebugSessionRegistry(): void {
  activeDebugSessions.clear();
  activeVsCodeSessions.clear();
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
