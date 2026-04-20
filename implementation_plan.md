# Implementation Plan: Default `Breakpoint Snapshot Handling` = Off

## Goal

Change the Settings UI and persisted debug-preference defaults so `Breakpoint Snapshot Handling` is disabled by default for first-time users. The change must be consistent across:

- runtime behavior
- webview initial state
- persisted preference backfill logic
- UI labels/badges/copy
- unit tests
- E2E tests
- package versioning and release verification

## Research Summary

I traced the setting end-to-end through the extension:

1. `src/types/index.ts`
   - Defines `DebugPreferences` and `DEFAULT_DEBUG_PREFERENCES`.
   - Current default is `enableBreakpointSnapshotHandling: true`.
   - This is the primary default used when no stored debug prefs exist.

2. `src/storage/cacheStore.ts`
   - `getDebugPreferences()` merges stored prefs over `DEFAULT_DEBUG_PREFERENCES`.
   - `saveDebugPreferences()` also normalizes against `DEFAULT_DEBUG_PREFERENCES`.
   - This means changing the type-level default changes first-run behavior and legacy backfill behavior.

3. `src/core/breakpointSnapshotManager.ts`
   - Calls `getDebugPreferences().enableBreakpointSnapshotHandling`.
   - If false, the manager does not intercept breakpoint stops at all.
   - Therefore this is not a cosmetic UI-only toggle. Changing the default changes default debug behavior from “capture snapshot + optional auto-continue” to “native debugger pause”.

4. `src/webview/debugPanel.ts`
   - Pushes `DEBUG_PREFS` to the webview on `LOAD_CONFIG` and when Settings opens.
   - No separate hard-coded server-side override exists here.

5. `src/webview/webviewScript.ts`
   - Has its own in-memory initial `state.debugPrefs`.
   - Current initial value for `enableBreakpointSnapshotHandling` is `true`.
   - If this stays `true` while the persisted default becomes `false`, the Settings screen can render the wrong toggle state until the extension pushes `DEBUG_PREFS`.

6. `src/webview/webviewRenderers.ts`
   - Renders the Settings toggle and badge text.
   - Current badge text assumes the feature is “enabled by default”.
   - Change required here for visible UI copy consistency.

7. Tests
   - `test/storage/cacheStore.test.ts` asserts the current default is `true` and that legacy backfill produces `true`.
   - `test/core/breakpointSnapshotManager.test.ts` seeds the mock preference state to `true` in `beforeEach`, and has test names describing the current default behavior.
   - `e2e/tests/extension-smoke.spec.ts` currently expects the Settings toggle to be checked on first open.

8. Related VS Code setting in `package.json`
   - `cdsDebug.pauseOnBreakpoint` currently defaults to `false`.
   - That setting only matters when snapshot handling is enabled and the manager actually intercepts the stop event.
   - I will not change this config in this task unless the code proves it is coupled to the requested behavior. Right now the requested default change is fully controlled by debug preferences, not by the VS Code configuration contribution.

## Files To Change

### 1. `src/types/index.ts`

Why:
- This is the source of truth for first-run defaults and backfill defaults.

How:
- Change `DEFAULT_DEBUG_PREFERENCES.enableBreakpointSnapshotHandling` from `true` to `false`.
- Update the interface comment so it documents the new default accurately.

### 2. `src/webview/webviewScript.ts`

Why:
- Prevent incorrect first paint in the webview before `DEBUG_PREFS` arrives from the extension host.

How:
- Change the initial `state.debugPrefs.enableBreakpointSnapshotHandling` from `true` to `false`.

### 3. `src/webview/webviewRenderers.ts`

Why:
- The Settings UI currently says the toggle is “enabled by default”.
- That text becomes wrong after the default changes.

How:
- Update the initial badge text to describe the new default.
- Update the live toggle-change handler so badge text stays accurate when switching on/off.
- Keep the meaning text intact: on = snapshot + auto-continue, off = native pause.

### 4. `test/storage/cacheStore.test.ts`

Why:
- Current assertions encode the old default.

How:
- Update expectations so `DEFAULT_DEBUG_PREFERENCES.enableBreakpointSnapshotHandling === false`.
- Update the legacy backfill test to expect `false` when the field is missing from stored prefs.
- Keep persistence tests that explicitly save `true` or `false`, because those still validate correct round-tripping.

### 5. `test/core/breakpointSnapshotManager.test.ts`

Why:
- The test file seeds mock debug prefs in `beforeEach`.
- Some test names currently describe the old default behavior.

How:
- Change the seeded default mock to `false` so it matches production defaults.
- For tests that verify snapshot capture behavior, explicitly enable snapshot handling inside the individual test cases that need it.
- Rename tests where necessary so they no longer claim the behavior is “by default” when it is no longer default.
- Preserve coverage for:
  - capture path when enabled
  - ignore path when disabled
  - pause-on-breakpoint interaction

### 6. `e2e/tests/extension-smoke.spec.ts`

Why:
- The smoke suite currently asserts the Settings checkbox is checked by default.
- That will fail after the change.

How:
- Update the first-open Settings assertions to expect the toggle unchecked by default.
- Update any badge-text assertions if the UI copy changes.
- Keep the persistence scenario, but invert it so it exercises the new expected path:
  - default unchecked
  - user enables it
  - leave Settings
  - reopen Settings
  - checkbox remains checked

### 7. `package.json`

Why:
- User requested a version bump before commit/push.

How:
- Increment the extension version once code and tests are green.
- Do not change unrelated metadata.

## Files Reviewed But Not Expected To Change

- `src/storage/cacheStore.ts`
  - logic already normalizes against `DEFAULT_DEBUG_PREFERENCES`; changing the default object should be sufficient.
- `src/webview/debugPanel.ts`
  - already fetches and posts debug prefs correctly.
- `src/core/breakpointSnapshotManager.ts`
  - runtime already respects the preference value correctly; only the default source changes.
- `package.json` `cdsDebug.pauseOnBreakpoint`
  - intentionally left alone unless verification shows a mismatch with the requested behavior.

## Test Strategy

### Unit

1. Update `test/storage/cacheStore.test.ts`
   - default object expectation
   - legacy stored prefs backfill expectation

2. Update `test/core/breakpointSnapshotManager.test.ts`
   - set suite default mock to disabled
   - explicitly opt in per test where snapshot capture is being exercised

### E2E

1. Review `e2e/tests/extension-smoke.spec.ts` assertions around Settings.
2. Update only the tests affected by the default inversion.
3. If the suite has no runtime path coupled to this default beyond the Settings UI, avoid unnecessary E2E churn.

## Verification Commands

After edits:

1. `pnpm run lint`
2. `pnpm run typecheck`
3. `pnpm run cspell`
4. targeted unit tests if needed
5. targeted E2E if feasible in the local environment

If full E2E is too heavy or blocked by environment, I will still confirm whether the edited E2E expectations are logically required and report what I was or was not able to run.

## Release / Git Steps

After verification passes:

1. bump `package.json` version
2. review `git diff`
3. commit without bypassing hooks
4. push to `origin/master`
5. use `gh` CLI to monitor the resulting GitHub Actions workflows until completion or until an actionable failure is available

## Risks To Watch

- First-paint mismatch if the webview local default is not updated with the persisted default.
- Legacy stored prefs missing the field will silently backfill to the new default, which is intended but must be reflected in tests.
- Tests that currently assume snapshot handling is on by default may fail in non-obvious ways unless they explicitly opt in.
- The `pauseOnBreakpoint` VS Code setting remains default `false`; this is acceptable because the breakpoint manager does nothing when snapshot handling is disabled.
