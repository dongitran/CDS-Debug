import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';
import { logInfo, logWarn } from './logger';
import { DEBUG_SESSION_PREFIX } from './processManager';
import { getDebugPreferences } from '../storage/cacheStore';
import type {
  BreakpointContextLocation,
  BreakpointContextScope,
  BreakpointContextSnapshot,
  BreakpointContextVariable,
} from '../types/index';
const MAX_SCOPES = 3;
const MAX_SCOPE_VARIABLES = 20;
const MAX_CHILD_VARIABLES = 8;
const MAX_EXPANDABLE_VARIABLE_CHILDREN_ROOT = 5;
const MAX_EXPANDABLE_VARIABLE_CHILDREN_NESTED = 1;
const MAX_VARIABLE_DEPTH = 2;
const MAX_VALUE_LENGTH = 240;
const CHILD_VARIABLE_REQUEST_TIMEOUT_MS = 220;
// Maximum time to spend capturing snapshot context before issuing auto-continue.
// Without a hard cap, a slow or unresponsive debug adapter can hold the process
// paused indefinitely because autoContinue is only called after captureSnapshot resolves.
const SNAPSHOT_CAPTURE_TIMEOUT_MS = 1200;
const SENSITIVE_NAME_REGEX = /(pass(word)?|token|secret|api[_-]?key|authorization|cookie|session|private[_-]?key)/i;
const SCOPE_PRIORITY: Readonly<Record<string, number>> = {
  local: 0,
  arguments: 1,
  block: 2,
  closure: 3,
};

export const breakpointSnapshotEvents = new EventEmitter();

// registerDebugAdapterTrackerFactory is the correct API for intercepting ALL DAP messages,
// including standard events like 'stopped'. The onDidReceiveDebugSessionCustomEvent API only
// fires for non-standard custom events defined by specific debug adapters and does NOT
// intercept standard DAP events like 'stopped' — using it caused the feature to silently
// never trigger (no snapshots, no auto-continue).
let trackerRegistration: vscode.Disposable | undefined;
const snapshotStore: BreakpointContextSnapshot[] = [];
const sessionQueues = new Map<string, Promise<void>>();

export function initializeBreakpointSnapshotManager(): void {
  if (trackerRegistration) return;

  trackerRegistration = vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
      return {
        onDidSendMessage(message: unknown): void {
          const msg = asRecord(message);
          if (msg?.type !== 'event' || msg.event !== 'stopped') return;
          const body = asRecord(msg.body);
          if (body?.reason !== 'breakpoint') return;
          const appName = findCdsAppName(session);
          if (!appName) return;
          if (!isBreakpointSnapshotHandlingEnabled()) return;
          logInfo(`[BreakpointSnapshots] Tracker attached — session: "${session.name}" type: ${session.type} app: ${appName}`);
          logInfo(`[BreakpointSnapshots] Breakpoint stop — app: ${appName} thread: ${String(body.threadId)}`);
          enqueueSessionTask(session.id, async () => {
            await handleBreakpointStop(session, appName, body);
          });
        },
      };
    },
  });
}

function isBreakpointSnapshotHandlingEnabled(): boolean {
  try {
    return getDebugPreferences().enableBreakpointSnapshotHandling;
  } catch {
    // Preferences store can be unavailable in early lifecycle / test harness.
    // Preserve the legacy default behavior when that happens.
    return true;
  }
}

// Walks the session hierarchy to find the CDS Debug app name.
// Returns null when neither the session nor any ancestor is a CDS Debug session.
function findCdsAppName(session: vscode.DebugSession): string | null {
  if (session.name.startsWith(DEBUG_SESSION_PREFIX)) {
    return session.name.slice(DEBUG_SESSION_PREFIX.length);
  }
  let parent = session.parentSession;
  while (parent) {
    if (parent.name.startsWith(DEBUG_SESSION_PREFIX)) {
      return parent.name.slice(DEBUG_SESSION_PREFIX.length);
    }
    parent = parent.parentSession;
  }
  return null;
}

export function disposeBreakpointSnapshotManager(): void {
  trackerRegistration?.dispose();
  trackerRegistration = undefined;
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
  const autoResumed = !pauseOnBreakpoint;

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
    await autoContinue(session, appName, threadId);
  }
}

function snapshotWithDeadline(
  session: vscode.DebugSession,
  appName: string,
  threadId: number | null,
  autoResumed: boolean,
): Promise<BreakpointContextSnapshot> {
  const now = Date.now();
  const fallback: BreakpointContextSnapshot = {
    id: `${now.toString()}-${Math.random().toString(36).slice(2, 8)}`,
    appName,
    sessionName: session.name,
    reason: 'breakpoint',
    createdAt: now,
    autoResumed,
    scopes: [],
    captureError: 'Snapshot capture timed out — process resumed without full context.',
  };
  if (threadId !== null) {
    fallback.threadId = threadId;
  }
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

function getContinueSessionCandidates(session: vscode.DebugSession): vscode.DebugSession[] {
  const seen = new Set<string>();
  const candidates: vscode.DebugSession[] = [];
  const addCandidate = (candidate: vscode.DebugSession | undefined): void => {
    if (!candidate || seen.has(candidate.id)) return;
    seen.add(candidate.id);
    candidates.push(candidate);
  };

  addCandidate(session);
  let parent = session.parentSession;
  while (parent) {
    addCandidate(parent);
    parent = parent.parentSession;
  }
  return candidates;
}

async function continueThread(session: vscode.DebugSession, threadId: number): Promise<boolean> {
  try {
    await session.customRequest('continue', { threadId });
    return true;
  } catch {
    return false;
  }
}

function getThreadIds(value: unknown): number[] {
  const record = asRecord(value);
  if (!record) return [];
  const rawThreads = asArray(record.threads);
  const ids: number[] = [];
  for (const rawThread of rawThreads) {
    const thread = asRecord(rawThread);
    const id = thread?.id;
    if (typeof id === 'number' && Number.isInteger(id)) {
      ids.push(id);
    }
  }
  return ids;
}

async function continueWithoutThreadId(session: vscode.DebugSession): Promise<boolean> {
  try {
    const threadsResponse = await session.customRequest('threads', {}) as unknown;
    const threadIds = getThreadIds(threadsResponse);
    let resumed = false;
    for (const threadId of threadIds) {
      const resumedThread = await continueThread(session, threadId);
      resumed = resumed || resumedThread;
    }
    if (resumed) return true;
  } catch {
    // Fall through to generic continue fallback.
  }

  try {
    await session.customRequest('continue', {});
    return true;
  } catch {
    return false;
  }
}

async function autoContinue(session: vscode.DebugSession, appName: string, threadId: number | null): Promise<void> {
  const candidates = getContinueSessionCandidates(session);
  for (const candidate of candidates) {
    const resumed = threadId !== null
      ? await continueThread(candidate, threadId)
      : await continueWithoutThreadId(candidate);
    if (!resumed) continue;
    const threadInfo = threadId !== null ? `thread ${threadId.toString()}` : 'all threads';
    logInfo(`[BreakpointSnapshots] Auto-continued session "${candidate.name}" ${threadInfo}`);
    return;
  }

  const threadInfo = threadId !== null ? `thread ${threadId.toString()}` : 'unknown threadId';
  logWarn(`[BreakpointSnapshots] Auto-continue failed for app "${appName}" (${threadInfo}).`);
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
    const scopes = selectScopesForSnapshot(getScopes(scopesResponse));
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

function isGlobalScope(name: string): boolean {
  const normalized = name.trim().replace(/^\[+|\]+$/g, '').trim().toLowerCase();
  return normalized === 'global';
}

function normalizeScopeName(name: string): string {
  return name.trim().replace(/^\[+|\]+$/g, '').trim().toLowerCase();
}

function getScopePriority(name: string): number {
  const normalized = normalizeScopeName(name);
  if (normalized.startsWith('block')) return SCOPE_PRIORITY.block ?? Number.MAX_SAFE_INTEGER;
  return SCOPE_PRIORITY[normalized] ?? Number.MAX_SAFE_INTEGER;
}

function sortScopesByPriority(scopes: DapScope[]): DapScope[] {
  return [...scopes].sort((a, b) => {
    const pA = getScopePriority(a.name);
    const pB = getScopePriority(b.name);
    if (pA !== pB) return pA - pB;
    return a.name.localeCompare(b.name);
  });
}

function selectScopesForSnapshot(scopes: DapScope[]): DapScope[] {
  const nonGlobal = scopes.filter((scope) => !isGlobalScope(scope.name));
  if (nonGlobal.length === 0) return [];

  // Prefer non-expensive scopes for fast snapshots. If an adapter marks every
  // scope as expensive, still capture top candidates so snapshot stays useful.
  const preferred = nonGlobal.filter((scope) => !scope.expensive);
  const candidateScopes = preferred.length > 0 ? preferred : nonGlobal;
  return sortScopesByPriority(candidateScopes).slice(0, MAX_SCOPES);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).then((value) => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return value;
  });
}

function getExpandableChildrenBudget(depth: number): number {
  if (depth >= 2) return MAX_EXPANDABLE_VARIABLE_CHILDREN_ROOT;
  if (depth === 1) return MAX_EXPANDABLE_VARIABLE_CHILDREN_NESTED;
  return 0;
}

function withStructuredPreview(raw: string, children: BreakpointContextVariable[]): string {
  if (children.length === 0) return raw;
  const compact = raw.trim();
  const hasGenericPreview = compact.includes('{…}')
    || compact.includes('{...}')
    || compact.includes('[…]')
    || compact.includes('[...]');
  if (!hasGenericPreview) return raw;

  const sample = children
    .slice(0, 3)
    .map((child) => `${child.name}: ${child.value}`)
    .join(', ');
  const suffix = children.length > 3 ? ', …' : '';
  const preview = compact.startsWith('[')
    ? `[${sample}${suffix}]`
    : `{${sample}${suffix}}`;
  if (preview.length <= MAX_VALUE_LENGTH) return preview;
  return `${preview.slice(0, MAX_VALUE_LENGTH)}...`;
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
    let expandableChildrenBudget = getExpandableChildrenBudget(depth);
    // Fetch children for all variables in parallel — same latency reasoning as captureScopes.
    const result = await Promise.all(
      vars.slice(0, limit).map(async (variable) => {
        const rawValue = sanitizeVariableValue(variable.name, variable.value);
        let children: BreakpointContextVariable[] | undefined;

        const canExpandChildren = depth > 0
          && variable.variablesReference > 0
          && expandableChildrenBudget > 0;

        if (canExpandChildren) {
          expandableChildrenBudget -= 1;
          const capturedChildren = await withTimeout(
            captureVariables(
              session,
              variable.variablesReference,
              MAX_CHILD_VARIABLES,
              depth - 1,
            ),
            CHILD_VARIABLE_REQUEST_TIMEOUT_MS,
            [],
          );
          if (capturedChildren.length > 0) {
            children = capturedChildren;
          }
        }

        const value = rawValue === '[REDACTED]'
          ? rawValue
          : withStructuredPreview(rawValue, children ?? []);

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
