import * as vscode from 'vscode';
import type { LoadedPackageEntry, LoadedPackageSource, PackageSourceLocation} from '../../types/index';
import { logError, logInfo } from '../../core/logger';
import { getActiveDebugSessionForApp, getDebugSessionById, getDebugSessionsForApp, getProcessOutputChannel, getSessionParams } from '../../core/processManager';
import { createPackageSearchIndex, loadPackageEntriesFromSessions, openPackageSource, searchPackageEntries, type PackageSearchIndex } from '../../core/packageSourceBrowser';
import { getLoadedSourcesForSessionIds, onLoadedSourceChanged } from '../../core/loadedSourceRegistry';
import { getE2eActiveDebugSessionForApp, getE2eDebugSessionById, getE2eDebugSessionsForApp, getE2ePackageLocalRoot } from '../../testing/e2eBridge';
import type { DebugLauncherViewProvider } from '../debugPanel';

export class PackageBrowserHandler {
  constructor(public provider: DebugLauncherViewProvider) {}

    public async handleLoadPackageSources(appName: string): Promise<void> {
        const log = this.provider.buildPackageLogger(appName);
        try {
          const packages = await this.provider.getOrLoadPackageEntriesForApp(appName, log, true);
          this.provider.postMessage({ type: 'PACKAGE_SOURCES_LOADED', payload: { appName, packages } });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logError(`Failed to load package sources for ${appName}: ${message}`);
          log(`Load failed: ${message}`);
          this.provider.postMessage({ type: 'PACKAGE_SOURCES_ERROR', payload: { appName, message } });
        }
    }

    public async handleSearchPackageSources(appName: string, query: string, requestId: number, packageNameFilterRegex?: string): Promise<void> {
        const log = this.provider.buildPackageLogger(appName);
        try {
          const packages = await this.provider.getOrLoadPackageEntriesForApp(appName, log, false);
          const existingIndex = this.provider.packageSearchIndexByApp.get(appName);
          const index = existingIndex ?? this.provider.createPackageSearchIndexForApp(appName, packages);
          if (!existingIndex) this.provider.packageSearchIndexByApp.set(appName, index);

          const searchResults = await searchPackageEntries(index, query, { packageNameFilterRegex });
          this.provider.postMessage({
            type: 'PACKAGE_SEARCH_RESULTS',
            payload: { appName, query, requestId, packages: searchResults },
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logError(`Failed to search package sources for ${appName}: ${message}`);
          log(`Search failed: ${message}`);
          this.provider.postMessage({ type: 'PACKAGE_SOURCES_ERROR', payload: { appName, message } });
        }
    }

    public async handleOpenPackageSource(appName: string, source: LoadedPackageSource, location?: PackageSourceLocation): Promise<void> {
        const session = source.debugSessionId
                  ? (getE2eDebugSessionById(source.debugSessionId) ?? getDebugSessionById(source.debugSessionId))
                  : (getE2eActiveDebugSessionForApp(appName) ?? getActiveDebugSessionForApp(appName));
        if (!session) {
          this.provider.postMessage({ type: 'PACKAGE_SOURCES_ERROR', payload: { appName, message: `No attached debug session found for ${appName}.` } });
          return;
        }

        try {
          this.provider.logPackageDiagnostic(
            appName,
            `Opening source from ${session.name} [${session.id}] path="${source.path ?? source.name ?? 'unknown'}" sourceRef=${String(source.sourceReference ?? 0)}`,
          );
          const localRoot = this.provider.getPackageLocalRoot(appName);
          const openedUri = await openPackageSource(
            session,
            source,
            location,
            { ...(localRoot ? { localRoot } : {}), appName },
          );
          this.provider.logPackageDiagnostic(
            appName,
            `Opened editor URI scheme=${openedUri.scheme} query="${openedUri.query || '<none>'}" toString=${openedUri.toString()}`,
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logError(`Failed to open package source for ${appName}: ${message}`);
          this.provider.logPackageDiagnostic(appName, `Open failed: ${message}`);
          this.provider.postMessage({ type: 'PACKAGE_SOURCES_ERROR', payload: { appName, message } });
        }
    }

    public async getOrLoadPackageEntriesForApp(appName: string, log: (message: string) => void, forceReload: boolean): Promise<LoadedPackageEntry[]> {
        if (!forceReload) {
          const cachedPackages = this.provider.packageEntriesByApp.get(appName);
          if (cachedPackages) return cachedPackages;
        }

        const resolveSessions = (): readonly vscode.DebugSession[] => {
                  const e2eSessions = getE2eDebugSessionsForApp(appName);
                  return e2eSessions.length > 0 ? e2eSessions : getDebugSessionsForApp(appName);
                };
        const rootSession = getE2eActiveDebugSessionForApp(appName) ?? getActiveDebugSessionForApp(appName);
        log(`Packages requested. Root session: ${rootSession ? `${rootSession.name} [${rootSession.id}]` : 'none'}`);
        const getExtraSources = (): readonly LoadedPackageSource[] =>
                  getLoadedSourcesForSessionIds(resolveSessions().map((session) => session.id));
        const pendingWakeResolvers: (() => void)[] = [];
        const wakeAll = (): void => { for (const resolve of pendingWakeResolvers.splice(0)) resolve(); };
        const sessionDisposable = vscode.debug.onDidStartDebugSession(wakeAll);
        const loadedSourceDisposable = onLoadedSourceChanged(wakeAll);
        const makeWakeSignal = (): Promise<void> =>
                  new Promise<void>((resolve) => { pendingWakeResolvers.push(resolve); });
        let packages: LoadedPackageEntry[];
        try {
          packages = await loadPackageEntriesFromSessions(
            appName,
            resolveSessions,
            log,
            { makeWakeSignal, getExtraSources },
          );
        } finally {
          sessionDisposable.dispose();
          loadedSourceDisposable.dispose();
          wakeAll();
        }

        this.provider.packageEntriesByApp.set(appName, packages);
        this.provider.packageSearchIndexByApp.set(appName, this.provider.createPackageSearchIndexForApp(appName, packages));
        return packages;
    }

    public createPackageSearchIndexForApp(appName: string, packages: LoadedPackageEntry[]): PackageSearchIndex {
        const localRoot = this.provider.getPackageLocalRoot(appName);
        return createPackageSearchIndex(packages, localRoot ? { localRoot } : undefined);
    }

    public logPackageDiagnostic(appName: string, message: string): void {
        const line = `[Packages][${appName}] ${message}`;
        logInfo(line);
        getProcessOutputChannel(appName)?.appendLine(`[Extension] ${line}`);
    }

    public buildPackageLogger(appName: string): (message: string) => void {
        return (message: string): void => {
          this.provider.logPackageDiagnostic(appName, message);
        };
    }

    public getPackageLocalRoot(appName: string): string | undefined {
        return getSessionParams(appName)?.folderPath ?? getE2ePackageLocalRoot(appName);
    }









}
