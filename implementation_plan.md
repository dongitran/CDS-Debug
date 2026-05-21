# Implementation Plan

## Goal

Fix the Settings cache-sync state where a previous canceled or failed sync can
remain visible as `Last sync: ... · Last attempt ...: sync was canceled` without
an automatic recovery attempt soon enough. The extension should keep the last
successful sync visible, but retry retryable failures (`aborted`, `fatal-error`,
`lock-contention`) independently of the normal cache interval.

## Research Summary

- `src/core/cacheSync.ts`
  - `doSync()` records skipped attempts with `lastSkipReason` and preserves
    `lastCompletedAt`.
  - The normal scheduler in `initCacheSync()` and `restartCacheSyncTimer()` decides
    staleness only from the most recent successful sync timestamp, preferring the
    shared `cf-sync` structure timestamp over VS Code `globalState`.
  - That means an aborted/fatal/lock-contention attempt after a successful sync may
    wait until the full cache interval before another automatic attempt.
  - A Change Mapping action calls `requestCacheSyncStop()`, which can correctly
    produce `lastSkipReason: 'aborted'`, but there is no short retry timer after
    the user is back in the launcher.
- `src/webview/webviewRenderers.ts`
  - Settings renders the exact string from `state.syncStatus.lastSkipReason`.
    `aborted` maps to `sync was canceled`, so the user-facing text is expected.
  - The UI does not decide retry behavior; the fix belongs in the extension-host
    cache scheduler.
- `src/webview/debugPanel.ts`
  - Settings requests current sync status with `GET_SYNC_STATUS`.
  - Manual Sync Now calls `TRIGGER_SYNC`; saving credentials already triggers an
    immediate sync.
  - The provider pushes `SYNC_STATUS` progress events to the webview, so any retry
    run will naturally update Settings while it is open.
- `node_modules/@saptools/cf-sync`
  - Runtime lock and state recovery are already handled by `tryAcquireSyncLock()`
    and related helpers. CDS Debug only needs to decide when to ask for another
    sync.

## Files To Touch

- `test/core/cacheSync.test.ts`
  - Add tests first for retry scheduling:
    1. startup retries an old retryable skipped attempt even when the last success
       is not stale under the normal cache interval.
    2. fresh `cf-sync` structure timestamps reconcile stale VS Code sync progress
       so Settings does not keep showing an older canceled attempt after another
       tool produced a newer successful snapshot.
    3. a retryable fatal sync result schedules one delayed retry, and non-retryable
       skip reasons do not schedule the short retry loop.
- `src/core/cacheSync.ts`
  - Add a bounded retry timer for retryable skip reasons.
  - Keep normal interval behavior unchanged for successful syncs, disabled cache,
    and missing credentials.
  - Reconcile `globalState` sync progress with a newer shared `cf-sync` structure
    timestamp on activation/restart so UI status reflects the newest successful
    shared snapshot and clears older skip reasons only when the shared success is
    newer than the failed attempt.
  - Dispose retry timers cleanly on deactivation and when cache is disabled.
- `test/webview/webviewMarkup.test.ts`
  - Add a focused renderer test for the retryable failure copy shown in Settings.
- `src/webview/webviewRenderers.ts`
  - Keep the existing last sync / last attempt wording and append concise retry
    guidance only for retryable skip reasons while cache sync is enabled.
- `e2e/tests/extension-smoke.spec.ts`
  - Add a concise Settings Screen E2E test that injects an old canceled status,
    verifies the warning row remains understandable, triggers Sync Now, and verifies
    the Settings UI transitions into the running retry state with the button
    disabled. This covers the visible recovery path without real CF credentials.
- `AGENTS.md` and `e2e/README.md`
  - Update the E2E registry because the Settings Screen E2E coverage changes.
- `README.md`
  - Update the Settings/Background Cache description if behavior changes are
    user-facing. This phase changes retry behavior, so add one concise note.
- `CHANGELOG.md`
  - Add `0.4.7-pre.4` with a Fixes entry for automatic cache-sync retry recovery.
- `package.json`
  - Bump version from `0.4.7-pre.3` to `0.4.7-pre.4`.

## Test Strategy

1. Red
   - Add unit/E2E tests first and run the targeted tests to confirm they fail on
     the current scheduler.
2. Green
   - Implement the narrow scheduler and progress reconciliation changes.
3. Verification
   - `pnpm test -- test/core/cacheSync.test.ts`
   - `pnpm test -- test/webview/webviewMarkup.test.ts` if touched
   - `pnpm test`
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm cspell`
   - `pnpm package`
   - `cd e2e && pnpm test`
   - `pnpm audit --audit-level=high`
   - `pnpm test:coverage`

## Release Steps

1. Review diff for project-name leakage; examples must stay neutral (`demo`,
   `sample`, `mock` only).
2. Do not update What's New for this pre-release fix.
3. Commit without bypassing hooks.
4. Push to `origin/master`.
5. Watch GitHub Actions with `gh` until triggered workflows finish; inspect logs
   and fix any failure before final response.
