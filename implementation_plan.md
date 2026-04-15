# Implementation Plan: Launch.json Stale Debug Config Handling

## Objective
Thoroughly validate and harden stale `launch.json` cleanup behavior for CDS Debug so force-kill/restart scenarios are handled safely:
- stale CDS Debug configs are removed automatically;
- active/debug-restart flows remain stable;
- non-CDS manual debug configs are preserved.

## Deep Research Summary
1. `src/webview/debugPanel.ts` writes launch configs through `mergeLaunchJson(...)`.
2. `src/core/processManager.ts` removes per-app launch configs on stop/exit and tracks active sessions in memory.
3. `src/extension.ts` now runs activation-time cleanup (`cleanStaleDebugConfigs`) and shutdown-time best-effort cleanup (`removeLaunchConfigs`).
4. Current cleanup predicate is prefix-based (`name.startsWith('Debug: ')`), which can be overly broad for user-defined configs.
5. Unit and E2E foundations already exist (`test/core/launchConfigurator.test.ts`, `e2e/tests/extension-smoke.spec.ts`) and e2e harness now supports custom workspace paths.

## Scope and Files
1. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/src/core/launchConfigurator.ts`
   - tighten managed-config detection;
   - keep backward compatibility for legacy CDS Debug entries.
2. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/src/types/index.ts` (if needed)
   - add optional managed marker field for launch configs.
3. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/test/core/launchConfigurator.test.ts`
   - add/adjust tests for stale cleanup and manual-config preservation.
4. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/e2e/tests/extension-smoke.spec.ts`
   - add E2E scenario for stale `launch.json` cleanup on extension activation;
   - keep descriptive test title (no word `bug`).
5. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/e2e/README.md` (if test count/coverage text changes).
6. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/package.json`
   - bump extension version after completion.

## Step-by-Step Execution
1. Confirm baseline by re-running checks before code edits (done in this session).
2. Implement managed-config identification:
   - primary marker for new generated configs;
   - legacy-safe fallback predicate for existing generated configs.
3. Update cleanup/removal paths to only remove managed CDS Debug entries.
4. Add/adjust unit tests for:
   - stale managed cleanup;
   - preserving manual configs (including `Debug:`-prefixed manual cases).
5. Add E2E test for startup cleanup from pre-seeded workspace `.vscode/launch.json`.
6. Execute full verification loop:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm cspell`
   - `pnpm --dir e2e test`
7. If any check fails:
   - analyze root cause from logs/traces;
   - apply targeted fix;
   - rerun full verification loop.
8. Finalize:
   - bump version in `package.json`;
   - review diff and run final sanity checks;
   - commit with clear message;
   - push to remote.
9. Post-commit review:
   - re-read changed files for regressions;
   - verify no accidental scope creep.

## Acceptance Criteria
1. Stale CDS Debug launch entries are removed after VS Code restart/activation.
2. Manual launch configs remain intact.
3. Existing debug start/stop flows still pass unit + e2e.
4. All required checks pass and version is incremented.
