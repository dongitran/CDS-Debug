import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';
import { logWarn } from './logger';
import { DEBUG_SESSION_PREFIX } from './processManager';
import type {
  BreakpointContextLocation,
  BreakpointContextScope,
  BreakpointContextSnapshot,
  BreakpointContextVariable,
} from '../types/index';
const MAX_SCOPES = 4;
const MAX_SCOPE_VARIABLES = 30;
const MAX_CHILD_VARIABLES = 10;
const MAX_VARIABLE_DEPTH = 1;
const MAX_VALUE_LENGTH = 240;
// Maximum time to spend capturing snapshot context before issuing auto-continue.
// Without a hard cap, a slow or unresponsive debug adapter can hold the process
// paused indefinitely because autoContinue is only called after captureSnapshot resolves.
const SNAPSHOT_CAPTURE_TIMEOUT_MS = 3000;
const SENSITIVE_NAME_REGEX = /(pass(word)?|token|secret|api[_-]?key|authorization|cookie|session|private[_-]?key)/i;

export const breakpointSnapshotEvents = new EventEmitter();

let sessionEventListener: vscode.Disposable | undefined;
const snapshotStore: BreakpointContextSnapshot[] = [];
const sessionQueues = new Map<string, Promise<void>>();

export function initializeBreakpointSnapshotManager(): void {
  if (sessionEventListener) return;

  // Despite its name, onDidReceiveDebugSessionCustomEvent fires for ALL events from the
  // debug adapter — including standard DAP events like 'stopped' — not only extension-defined
  // custom events. This is the established VS Code extension pattern for intercepting DAP
  // events without a DebugAdapterTracker, and is confirmed by VS Code's extension host
  // implementation (ExtHostDebugService). The alternative, registerDebugAdapterTrackerFactory,
  // requires knowing each adapter type identifier (e.g. 'node', 'pwa-node') and is better
  // suited for protocol-level tracing rather than selective event handling.
  sessionEventListener = vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
    if (event.event !== 'stopped') return;
    if (!event.session.name.startsWith(DEBUG_SESSION_PREFIX)) return;

    const body = asRecord(event.body);
    if (body?.reason !== 'breakpoint') return;

    const appName = event.session.name.slice(DEBUG_SESSION_PREFIX.length);
    enqueueSessionTask(event.session.id, async () => {
      await handleBreakpointStop(event.session, appName, body);
    });
  });
}

export function disposeBreakpointSnapshotManager(): void {
  sessionEventListener?.dispose();
  sessionEventListener = undefined;
  snapshotStore.length = 0;
  sessionQueues.clear();
}

export function getBreakpointSnapshots(): BreakpointContextSnapshot[] {
  return [...snapshotStore];
}

export function clearBreakpointSnapshots(): void {
  snapshotStore.length = 0;
}

function enqueueSessionTask(sessionId: string, task: () => Promise<void>): void {
  const prev = sessionQueues.get(sessionId) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(task)
    .catch((err: unknown) => {
      logWarn(`[BreakpointSnapshots] Task error: ${err instanceof Error ? err.message : String(err)}`);
    });
  sessionQueues.set(sessionId, next);
  void next.finally(() => {
    if (sessionQueues.get(sessionId) === next) {
      sessionQueues.delete(sessionId);
    }
  });
}

async function handleBreakpointStop(
  session: vscode.DebugSession,
  appName: string,
  body: Record<string, unknown>,
): Promise<void> {
  const threadId = getThreadId(body);
  const pauseOnBreakpoint = vscode.workspace
    .getConfiguration('cdsDebug')
    .get('pauseOnBreakpoint') === true;
  const autoResumed = !pauseOnBreakpoint && threadId !== null;

  // When auto-resuming, race captureSnapshot against a deadline so autoContinue is
  // guaranteed to run even if the debug adapter is slow or an individual DAP request
  // hangs. Without this guard, a single stalled customRequest keeps the remote process
  // paused indefinitely.
  let snapshot: BreakpointContextSnapshot;
  if (autoResumed) {
    snapshot = await snapshotWithDeadline(session, appName, threadId, true);
  } else {
    snapshot = await captureSnapshot(session, appName, threadId, false);
  }
  pushSnapshot(snapshot);

  if (autoResumed) {
    await autoContinue(session, threadId);
  }
}

function snapshotWithDeadline(
  session: vscode.DebugSession,
  appName: string,
  threadId: number,
  autoResumed: boolean,
): Promise<BreakpointContextSnapshot> {
  const now = Date.now();
  const fallback: BreakpointContextSnapshot = {
    id: `${now.toString()}-${Math.random().toString(36).slice(2, 8)}`,
    appName,
    sessionName: session.name,
    reason: 'breakpoint',
    createdAt: now,
    threadId,
    autoResumed,
    scopes: [],
    captureError: 'Snapshot capture timed out — process resumed without full context.',
  };
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<BreakpointContextSnapshot>((resolve) => {
    deadlineHandle = setTimeout(() => { resolve(fallback); }, SNAPSHOT_CAPTURE_TIMEOUT_MS);
  });
  // Clear the timer as soon as captureSnapshot wins so the handle does not linger
  // for SNAPSHOT_CAPTURE_TIMEOUT_MS after the race is already settled.
  const capture = captureSnapshot(session, appName, threadId, autoResumed).then((s) => {
    clearTimeout(deadlineHandle);
    return s;
  });
  return Promise.race([capture, deadline]);
}

function pushSnapshot(snapshot: BreakpointContextSnapshot): void {
  snapshotStore.unshift(snapshot);
  const maxSnapshots: number = vscode.workspace
    .getConfiguration('cdsDebug')
    .get('breakpointSnapshotMaxEntries', 120);
  const bounded = Math.max(20, Math.min(1000, maxSnapshots));
  if (snapshotStore.length > bounded) {
    snapshotStore.length = bounded;
  }
  breakpointSnapshotEvents.emit('snapshotAdded', snapshot);
}

async function autoContinue(session: vscode.DebugSession, threadId: number): Promise<void> {
  try {
    await session.customRequest('continue', { threadId });
  } catch (err: unknown) {
    logWarn(
      `[BreakpointSnapshots] Auto-continue failed for ${session.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function captureSnapshot(
  session: vscode.DebugSession,
  appName: string,
  threadId: number | null,
  autoResumed: boolean,
): Promise<BreakpointContextSnapshot> {
  const now = Date.now();
  const base: BreakpointContextSnapshot = {
    id: `${now.toString()}-${Math.random().toString(36).slice(2, 8)}`,
    appName,
    sessionName: session.name,
    reason: 'breakpoint',
    createdAt: now,
    autoResumed,
    scopes: [],
  };

  if (threadId === null) {
    return {
      ...base,
      captureError: 'No threadId found in breakpoint event.',
    };
  }

  try {
    const stackTraceResponse = await session.customRequest('stackTrace', {
      threadId,
      startFrame: 0,
      levels: 1,
    }) as unknown;

    const frame = getTopFrame(stackTraceResponse);
    const location = frame ? toLocation(frame) : undefined;
    const scopes = frame ? await captureScopes(session, frame.id) : [];

    const snapshot: BreakpointContextSnapshot = {
      ...base,
      threadId,
      scopes,
    };
    if (location) snapshot.location = location;
    return snapshot;
  } catch (err: unknown) {
    return {
      ...base,
      threadId,
      captureError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function captureScopes(session: vscode.DebugSession, frameId: number): Promise<BreakpointContextScope[]> {
  try {
    const scopesResponse = await session.customRequest('scopes', { frameId }) as unknown;
    const scopes = getScopes(scopesResponse).slice(0, MAX_SCOPES);
    // Fetch variables for all scopes in parallel to minimize total pause time over
    // high-latency transports (e.g. CF SSH tunnels where each sequential round-trip
    // adds 100-300 ms). Sequential fetching could take 10+ seconds for typical payloads.
    return await Promise.all(
      scopes.map(async (scope) => {
        const variables = await captureVariables(
          session,
          scope.variablesReference,
          MAX_SCOPE_VARIABLES,
          MAX_VARIABLE_DEPTH,
        );
        return {
          name: scope.name,
          expensive: scope.expensive,
          variables,
        };
      }),
    );
  } catch {
    return [];
  }
}

async function captureVariables(
  session: vscode.DebugSession,
  variablesReference: number,
  limit: number,
  depth: number,
): Promise<BreakpointContextVariable[]> {
  if (variablesReference <= 0) return [];
  try {
    const response = await session.customRequest('variables', {
      variablesReference,
      start: 0,
      count: limit,
    }) as unknown;
    const vars = getVariables(response);
    // Fetch children for all variables in parallel — same latency reasoning as captureScopes.
    const result = await Promise.all(
      vars.slice(0, limit).map(async (variable) => {
        const value = sanitizeVariableValue(variable.name, variable.value);
        let children: BreakpointContextVariable[] | undefined;

        if (depth > 0 && variable.variablesReference > 0) {
          const capturedChildren = await captureVariables(
            session,
            variable.variablesReference,
            MAX_CHILD_VARIABLES,
            depth - 1,
          );
          if (capturedChildren.length > 0) {
            children = capturedChildren;
          }
        }

        const mapped: BreakpointContextVariable = {
          name: variable.name,
          value,
        };
        if (variable.type !== undefined) mapped.type = variable.type;
        if (children !== undefined) mapped.children = children;
        return mapped;
      }),
    );

    return result;
  } catch {
    return [];
  }
}

function sanitizeVariableValue(name: string, raw: string): string {
  if (SENSITIVE_NAME_REGEX.test(name)) return '[REDACTED]';
  if (raw.length <= MAX_VALUE_LENGTH) return raw;
  return `${raw.slice(0, MAX_VALUE_LENGTH)}...`;
}

function getThreadId(body: Record<string, unknown>): number | null {
  const raw = body.threadId;
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface DapStackFrame {
  id: number;
  name: string;
  line: number;
  column: number;
  sourcePath?: string;
}

function getTopFrame(value: unknown): DapStackFrame | null {
  const record = asRecord(value);
  if (!record) return null;
  const rawFrames = asArray(record.stackFrames);
  if (rawFrames.length === 0) return null;
  const first = rawFrames[0];
  const frameRecord = asRecord(first);
  if (!frameRecord) return null;

  const id = frameRecord.id;
  const name = frameRecord.name;
  const line = frameRecord.line;
  const column = frameRecord.column;
  if (
    typeof id !== 'number'
    || typeof name !== 'string'
    || typeof line !== 'number'
    || typeof column !== 'number'
  ) {
    return null;
  }

  let sourcePath: string | undefined;
  const source = asRecord(frameRecord.source);
  if (source && typeof source.path === 'string') {
    sourcePath = source.path;
  }

  const frame: DapStackFrame = { id, name, line, column };
  if (sourcePath !== undefined) {
    frame.sourcePath = sourcePath;
  }
  return frame;
}

function toLocation(frame: DapStackFrame): BreakpointContextLocation {
  return {
    sourcePath: frame.sourcePath ?? '(unknown source)',
    line: frame.line,
    column: frame.column,
    functionName: frame.name,
  };
}

interface DapScope {
  name: string;
  expensive: boolean;
  variablesReference: number;
}

function getScopes(value: unknown): DapScope[] {
  const record = asRecord(value);
  if (!record) return [];
  const rawScopes = asArray(record.scopes);
  if (rawScopes.length === 0) return [];

  return rawScopes.flatMap((item): DapScope[] => {
    const scope = asRecord(item);
    if (!scope) return [];
    const name = scope.name;
    const expensive = scope.expensive;
    const variablesReference = scope.variablesReference;
    if (
      typeof name !== 'string'
      || typeof expensive !== 'boolean'
      || typeof variablesReference !== 'number'
    ) {
      return [];
    }
    return [{ name, expensive, variablesReference }];
  });
}

interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

function getVariables(value: unknown): DapVariable[] {
  const record = asRecord(value);
  if (!record) return [];
  const rawVars = asArray(record.variables);
  if (rawVars.length === 0) return [];

  return rawVars.flatMap((item): DapVariable[] => {
    const variable = asRecord(item);
    if (!variable) return [];
    const name = variable.name;
    const val = variable.value;
    const variablesReference = variable.variablesReference;
    if (typeof name !== 'string' || typeof val !== 'string' || typeof variablesReference !== 'number') {
      return [];
    }
    const type = typeof variable.type === 'string' ? variable.type : undefined;
    const mapped: DapVariable = {
      name,
      value: val,
      variablesReference,
    };
    if (type !== undefined) mapped.type = type;
    return [mapped];
  });
}
