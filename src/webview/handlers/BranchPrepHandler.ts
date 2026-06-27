import * as vscode from 'vscode';
import type { BranchPrepStep, CapDebugConfig, DebugTarget} from '../../types/index';
import { readCapDebugConfig } from '../../core/launchConfigurator';
import { logError, logInfo } from '../../core/logger';
import { checkoutBranch, describeGitBranchForLog, getCurrentBranch, getGitRepoRoot, hasUncommittedChanges, listBranches, pullLatest, runPnpmBuild, runPnpmInstall, stashChanges } from '../../core/gitOperations';
import type { DebugLauncherViewProvider } from '../debugPanel';
import type { ServiceBranchInfo} from "../webviewUtils";
import { extractErrorMessage } from "../webviewUtils";

export class BranchPrepHandler {
  constructor(public provider: DebugLauncherViewProvider) {}

    /**
     * Determines the target branch for each debug target.
     * Priority: per-app `branch` field > shared fallback `orgBranchMap` > per-app `orgBranchMap` > QuickPick.
     * QuickPick is shown once per git repo root to avoid duplicate prompts in monorepos.
     */
    public async resolveTargetBranches(targets: DebugTarget[], org: string, fallbackConfig: CapDebugConfig | null): Promise<ServiceBranchInfo[]> {
        const uniqueFolderPaths = [...new Set(targets.map((t) => t.folderPath))];
        const [repoRootResults, appConfigResults] = await Promise.all([
                  Promise.all(uniqueFolderPaths.map((p) => getGitRepoRoot(p))),
                  Promise.all(uniqueFolderPaths.map((p) => readCapDebugConfig(p))),
                ]);
        const repoRoots = new Map(uniqueFolderPaths.map((p, i) => [p, repoRootResults[i]]));
        const appConfigs = new Map(uniqueFolderPaths.map((p, i) => [p, appConfigResults[i]]));
        const resolvedBranches = new Map<string, string | null>();
        const reposNeedingPrompt = new Map<string, string[]>();
        const currentBranches = new Map<string, string | null>();
        for (const target of targets) {
          const repoRoot = repoRoots.get(target.folderPath) ?? null;
          const appConfig = appConfigs.get(target.folderPath);

          if (appConfig?.branch) {
            resolvedBranches.set(target.appName, appConfig.branch);
          } else {
            const orgMap = fallbackConfig?.orgBranchMap ?? appConfig?.orgBranchMap;
            if (orgMap?.[org]) {
              resolvedBranches.set(target.appName, orgMap[org]);
            } else if (repoRoot) {
              if (!reposNeedingPrompt.has(repoRoot)) reposNeedingPrompt.set(repoRoot, []);
              const queuedNames = reposNeedingPrompt.get(repoRoot);
              if (queuedNames) queuedNames.push(target.appName);
            } else {
              resolvedBranches.set(target.appName, null);
            }
          }
        }

        for (const [repoRoot, appNamesForRepo] of reposNeedingPrompt) {
          const [branches, currentBranch] = await Promise.all([listBranches(repoRoot), getCurrentBranch(repoRoot)]);
          currentBranches.set(repoRoot, currentBranch);

          type BranchItem = vscode.QuickPickItem & { branch: string | null };
          const items: BranchItem[] = [
            {
              label: '$(close) Skip branch switch',
              description: currentBranch ? `Keep current: ${currentBranch}` : 'Keep current branch',
              branch: null,
            },
            ...branches.map((b): BranchItem => {
              const item: BranchItem = { label: `$(git-branch) ${b}`, branch: b };
              if (b === currentBranch) item.description = 'current';
              return item;
            }),
          ];

          const selected = await vscode.window.showQuickPick(items, {
            title: `Select branch to debug: ${appNamesForRepo.join(', ')}`,
            placeHolder: `Current branch: ${currentBranch ?? 'unknown'}`,
            matchOnDescription: true,
          });

          const chosenBranch = selected ? selected.branch : null;
          for (const appName of appNamesForRepo) {
            resolvedBranches.set(appName, chosenBranch);
          }
        }

        const reposWithoutCurrentBranch = [...new Set(
                  repoRootResults.filter((r): r is string => r !== null && !currentBranches.has(r)),
                )];
        if (reposWithoutCurrentBranch.length > 0) {
          const fetched = await Promise.all(reposWithoutCurrentBranch.map((r) => getCurrentBranch(r)));
          reposWithoutCurrentBranch.forEach((r, i) => currentBranches.set(r, fetched[i] ?? null));
        }

        return targets.map((target) => {
          const repoRoot = repoRoots.get(target.folderPath) ?? null;
          return {
            appName: target.appName,
            folderPath: target.folderPath,
            repoRoot,
            targetBranch: resolvedBranches.get(target.appName) ?? null,
            currentBranch: repoRoot ? (currentBranches.get(repoRoot) ?? null) : null,
          };
        });
    }

    /**
     * Runs branch preparation (stash → checkout → install → build) for services
     * that have a target branch. Handles monorepos by processing each git root once.
     * Returns the list of DebugTargets whose preparation succeeded.
     */
    public async runBranchPreparation(targets: DebugTarget[], branchInfos: ServiceBranchInfo[]): Promise<DebugTarget[]> {
        const successfulTargets: DebugTarget[] = [];
        const repoCheckedOut = new Map<string, boolean>();
        const postStatus = (appName: string, step: BranchPrepStep, message?: string): void => {
                  const payload: { appName: string; step: BranchPrepStep; message?: string } = { appName, step };
                  if (message !== undefined) payload.message = message;
                  this.provider.postMessage({ type: 'BRANCH_PREP_STATUS', payload });
                };
        for (const info of branchInfos) {
          if (info.targetBranch === null) continue; // handled separately (targetsSkippingPrep)

          const target = targets.find((t) => t.appName === info.appName);
          if (!target) continue;

          const repoRoot = info.repoRoot ?? info.folderPath;
          const alreadyProcessedRepo = repoCheckedOut.has(repoRoot);

          try {
            if (!alreadyProcessedRepo) {
              const currentBranch = info.currentBranch;
              let changedWorkingTree = false;

              // Stash uncommitted changes if any
              const dirty = await hasUncommittedChanges(repoRoot);
              if (dirty) {
                logInfo(`[${info.appName}] Stashing uncommitted changes in ${repoRoot}`);
                postStatus(info.appName, 'stashing');
                const stashed = await stashChanges(repoRoot);
                if (stashed) changedWorkingTree = true;
              }

              if (currentBranch !== info.targetBranch) {
                logInfo(`[${info.appName}] Checking out branch ${describeGitBranchForLog(info.targetBranch)} in ${repoRoot}`);
                postStatus(info.appName, 'checking-out');
                await checkoutBranch(repoRoot, info.targetBranch);
                changedWorkingTree = true;
              }

              logInfo(
                `[${info.appName}] Pulling latest changes for branch ${describeGitBranchForLog(info.targetBranch)} in ${repoRoot}`,
              );
              postStatus(info.appName, 'pulling');
              const pullResult = await pullLatest(repoRoot);
              if (pullResult.changed) {
                changedWorkingTree = true;
              }

              if (!changedWorkingTree) {
                // Already on the correct branch, no local changes stashed, and no remote updates
                logInfo(
                  `[${info.appName}] Branch ${describeGitBranchForLog(info.targetBranch)} is up to date, skipping install/build.`,
                );
                postStatus(info.appName, 'skipped', `Up to date`);
                repoCheckedOut.set(repoRoot, false);
                successfulTargets.push(target);
                continue;
              }

              repoCheckedOut.set(repoRoot, true);
            } else if (!repoCheckedOut.get(repoRoot)) {
              // Shared repo that was already up to date — skip this service too
              logInfo(`[${info.appName}] Shared repo already up to date, skipping git ops.`);
              postStatus(info.appName, 'skipped', `Up to date`);
              successfulTargets.push(target);
              continue;
            }

            // Run pnpm install + build after checkout
            logInfo(`[${info.appName}] Running pnpm install in ${info.folderPath}`);
            postStatus(info.appName, 'installing');
            await runPnpmInstall(info.folderPath);

            logInfo(`[${info.appName}] Running pnpm build in ${info.folderPath}`);
            postStatus(info.appName, 'building');
            await runPnpmBuild(info.folderPath);

            logInfo(`[${info.appName}] Branch preparation complete.`);
            postStatus(info.appName, 'done');
            successfulTargets.push(target);
          } catch (err: unknown) {
            const msg = extractErrorMessage(err);
            logError(`Branch prep failed for ${info.appName}: ${msg}`);
            postStatus(info.appName, 'error', msg);
          }
        }

        return successfulTargets;
    }



}
