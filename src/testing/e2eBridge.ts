import type * as vscode from 'vscode';
import type {
  CredentialStatus,
  E2eBridgeCommand,
  LoadedPackageEntry,
  LoadedPackageSource,
} from '../types/index';

interface E2eFakeSessionSet {
  rootSession: vscode.DebugSession;
  sessions: vscode.DebugSession[];
}

const E2E_REMOTE_PROCESS_NAME = 'Remote Process [0]';
const fakeSessionsByApp = new Map<string, E2eFakeSessionSet>();
let credentialStatusOverride: CredentialStatus | undefined;

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

function createFakeDebugSession(
  sessionId: string,
  sessionName: string,
  sources: readonly LoadedPackageSource[],
  parentSession?: vscode.DebugSession,
): vscode.DebugSession {
  return {
    id: sessionId,
    name: sessionName,
    type: 'pwa-node',
    parentSession,
    customRequest: (command: string): Promise<unknown> => {
      if (command === 'loadedSources') {
        return Promise.resolve({ sources });
      }
      return Promise.reject(new Error(`Unsupported fake debug request: ${command}`));
    },
  } as unknown as vscode.DebugSession;
}

function createFakeSessionSet(appName: string, packages: readonly LoadedPackageEntry[]): E2eFakeSessionSet {
  const sources = flattenLoadedSources(packages);
  const rootSessionId = `e2e:${appName}:root`;
  const childSessionId = `e2e:${appName}:remote-process-0`;
  const rootSessionName = `Debug: ${appName}`;
  const rootSession = createFakeDebugSession(rootSessionId, rootSessionName, []);
  const childSession = createFakeDebugSession(childSessionId, E2E_REMOTE_PROCESS_NAME, sources, rootSession);
  return {
    rootSession,
    sessions: [rootSession, childSession],
  };
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
      fakeSessionsByApp.set(command.payload.appName, createFakeSessionSet(command.payload.appName, packages));
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
