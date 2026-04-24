import { setTimeout as delay } from 'node:timers/promises';
import type * as vscode from 'vscode';
import type {
  CredentialStatus,
  E2eBridgeCommand,
  E2eLoadedSourcesPlanStep,
  LoadedPackageEntry,
  LoadedPackageSource,
} from '../types/index';

interface E2eFakeSessionSet {
  rootSession: vscode.DebugSession;
  sessions: vscode.DebugSession[];
  localRoot?: string;
}

const E2E_REMOTE_PROCESS_NAME = 'Remote Process [0]';
const fakeSessionsByApp = new Map<string, E2eFakeSessionSet>();
let credentialStatusOverride: CredentialStatus | undefined;
const DEFAULT_LOADED_SOURCES_PLAN: readonly E2eLoadedSourcesPlanStep[] = [{ kind: 'packages' }];

function clonePackageFixtures(packages: readonly LoadedPackageEntry[]): LoadedPackageEntry[] {
  return packages.map((entry) => ({
    ...entry,
    files: entry.files.map((file) => ({
      ...file,
      source: { ...file.source },
    })),
    tree: entry.tree,
  }));
}

function flattenLoadedSources(packages: readonly LoadedPackageEntry[]): LoadedPackageSource[] {
  return packages.flatMap((entry) =>
    entry.files.map((file) => ({
      ...file.source,
    })),
  );
}

function cloneLoadedSourcesPlan(
  loadedSourcesPlan: readonly E2eLoadedSourcesPlanStep[] | undefined,
): E2eLoadedSourcesPlanStep[] {
  const plan = loadedSourcesPlan && loadedSourcesPlan.length > 0
    ? loadedSourcesPlan
    : DEFAULT_LOADED_SOURCES_PLAN;
  return plan.map((step) => ({ ...step }));
}

function buildLoadedSourcesRequestHandler(
  packages: readonly LoadedPackageEntry[],
  loadedSourcesPlan: readonly E2eLoadedSourcesPlanStep[] | undefined,
): (command: string) => Promise<unknown> {
  const plan = cloneLoadedSourcesPlan(loadedSourcesPlan);
  const sources = flattenLoadedSources(packages);
  let requestCount = 0;

  return async (command: string): Promise<unknown> => {
    if (command !== 'loadedSources') {
      throw new Error(`Unsupported fake debug request: ${command}`);
    }

    const fallbackStep = DEFAULT_LOADED_SOURCES_PLAN[0];
    if (!fallbackStep) {
      throw new Error('Default loaded-sources plan is not configured.');
    }
    const step = plan[Math.min(requestCount, plan.length - 1)] ?? fallbackStep;
    requestCount += 1;

    if ('delayMs' in step && typeof step.delayMs === 'number' && step.delayMs > 0) {
      await delay(step.delayMs);
    }

    switch (step.kind) {
      case 'packages':
        return { sources };
      case 'empty':
        return { sources: [] };
      case 'error':
        throw new Error(step.message);
      case 'hang':
        return new Promise<never>((resolve) => {
          void resolve;
          return undefined;
        });
    }
  };
}

function createFakeDebugSession(
  sessionId: string,
  sessionName: string,
  onCustomRequest: (command: string) => Promise<unknown>,
  parentSession?: vscode.DebugSession,
): vscode.DebugSession {
  return {
    id: sessionId,
    name: sessionName,
    type: 'pwa-node',
    parentSession,
    customRequest: (command: string): Promise<unknown> => onCustomRequest(command),
  } as unknown as vscode.DebugSession;
}

function createFakeSessionSet(
  appName: string,
  packages: readonly LoadedPackageEntry[],
  loadedSourcesPlan?: readonly E2eLoadedSourcesPlanStep[],
  localRoot?: string,
): E2eFakeSessionSet {
  const rootSessionId = `e2e:${appName}:root`;
  const childSessionId = `e2e:${appName}:remote-process-0`;
  const rootSessionName = `Debug: ${appName}`;
  const rootSession = createFakeDebugSession(rootSessionId, rootSessionName, () => Promise.resolve({ sources: [] }));
  const childSession = createFakeDebugSession(
    childSessionId,
    E2E_REMOTE_PROCESS_NAME,
    buildLoadedSourcesRequestHandler(packages, loadedSourcesPlan),
    rootSession,
  );
  const sessionSet: E2eFakeSessionSet = {
    rootSession,
    sessions: [rootSession, childSession],
  };
  if (localRoot) sessionSet.localRoot = localRoot;
  return sessionSet;
}

export function isE2eModeEnabled(): boolean {
  return process.env.CDS_DEBUG_E2E_MODE === '1';
}

export function clearE2eBridgeState(): void {
  fakeSessionsByApp.clear();
  credentialStatusOverride = undefined;
}

export function applyE2eBridgeCommand(command: E2eBridgeCommand): void {
  if (!isE2eModeEnabled()) return;

  switch (command.action) {
    case 'SET_PACKAGE_FIXTURE': {
      const packages = clonePackageFixtures(command.payload.packages);
      fakeSessionsByApp.set(
        command.payload.appName,
        createFakeSessionSet(
          command.payload.appName,
          packages,
          command.payload.loadedSourcesPlan,
          command.payload.localRoot,
        ),
      );
      return;
    }
    case 'CLEAR_PACKAGE_FIXTURES':
      clearE2eBridgeState();
      return;
    case 'SET_CREDENTIAL_STATUS_OVERRIDE':
      credentialStatusOverride = { ...command.payload.credentialStatus };
      return;
    case 'CLEAR_CREDENTIAL_STATUS_OVERRIDE':
      credentialStatusOverride = undefined;
      return;
    default:
      return;
  }
}

export function getE2eCredentialStatusOverride(): CredentialStatus | undefined {
  return credentialStatusOverride ? { ...credentialStatusOverride } : undefined;
}

export function getE2eDebugSessionsForApp(appName: string): vscode.DebugSession[] {
  return fakeSessionsByApp.get(appName)?.sessions.slice() ?? [];
}

export function getE2eActiveDebugSessionForApp(appName: string): vscode.DebugSession | undefined {
  return fakeSessionsByApp.get(appName)?.rootSession;
}

export function getE2eDebugSessionById(sessionId: string): vscode.DebugSession | undefined {
  for (const sessionSet of fakeSessionsByApp.values()) {
    const match = sessionSet.sessions.find((session) => session.id === sessionId);
    if (match) return match;
  }
  return undefined;
}

export function getE2ePackageLocalRoot(appName: string): string | undefined {
  return fakeSessionsByApp.get(appName)?.localRoot;
}
