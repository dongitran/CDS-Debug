# Implementation Plan

## Goal

Raise enforced unit-test coverage above the existing 80% thresholds by adding
focused, behavior-level tests for currently under-covered branches. Do not loosen
coverage thresholds, do not exclude additional production files, and do not add
tests that only exercise implementation details without validating user-visible
or extension-host behavior.

## Current Coverage Baseline

- `pnpm test:coverage` currently fails only on branch coverage.
- Current branch total from `coverage/lcov.info`: `1432 / 1907 = 75.09%`.
- Required branch hits to reach 80%: at least 94 additional covered branches.
- Largest contributors to uncovered branches:
  - `src/core/packageSourceBrowser.ts`: 93 missing branches.
  - `src/core/packageBreakpointMirror.ts`: 63 missing branches.
  - `src/core/breakpointSnapshotManager.ts`: 50 missing branches.
  - `src/core/remoteInspectorCleanup.ts`: 44 missing branches.
  - `src/core/breakpointResolver.ts`: 39 missing branches.

## Research Summary

- `src/core/packageSourceBrowser.ts`
  - Existing tests cover the main package browser flows, but several exported
    helper behaviors are not directly asserted:
    - opened package URI tracking, cloning, fallback lookup, unregister, and
      cleanup.
    - debug URI session-id extraction for raw, encoded, missing, and malformed
      query values.
    - loaded-source normalization for invalid source records and incomplete
      `node_modules` paths.
    - search behavior when the query is empty and package-name regex filters are
      valid, invalid, or excluding.
  - These branches are meaningful because they protect package browser navigation,
    breakpoint remapping, and source lookup stability after VS Code debug session
    data changes shape.
- `src/core/packageBreakpointMirror.ts`
  - Existing tests cover refresh and migration happy paths, but not enough guard
    rails:
    - breakpoint collection should ignore non-source breakpoints and removed-only
      events.
    - source-reference lookup should tolerate missing/invalid loaded-source
      responses and timeouts without calling `setBreakpoints`.
    - focus of a verified package URI should be best-effort and must not break
      mirroring if VS Code rejects the editor command.
  - These tests are good second-pass targets if `packageSourceBrowser` additions
    do not raise branch coverage enough.
- `src/core/packageSourceContent.ts`
  - The module was mostly covered indirectly through package browser tests.
  - Direct tests should validate the source materialization safety boundary:
    positive source references only, safe `node_modules` targets only, workspace
    and local-root ancestor allowances, and graceful debugger content failures.

## Files To Touch

- `test/core/packageSourceBrowser.test.ts`
  - Add tests for opened URI registry behavior using neutral names such as
    `sample-service` and `sample-client`.
  - Add tests for debug URI session-id extraction.
  - Add tests for malformed or incomplete package source entries returned by the
    debug adapter.
  - Add tests for empty-query package filtering and invalid regex handling.
- `test/core/packageBreakpointMirror.test.ts`
  - Added after the first coverage run because branch coverage was still below
    80%.
  - Focus on branch guards around breakpoint collection, loaded-source lookup
    failure, setBreakpoints failure/unverified responses, missing active
    sessions, and best-effort focus.
- `test/core/packageSourceContent.test.ts`
  - Add direct tests for package source materialization safety and error handling
    to make coverage less fragile than a one-branch margin.
- `implementation_plan.md`
  - Keep this plan updated as the coverage strategy changes.
- `CHANGELOG.md` and `package.json`
  - Review after test work. If this phase is committed as a pre-release update,
    bump from `0.4.7-pre.4` to `0.4.7-pre.5` and add a concise Tests entry.
  - Do not update What's New because this is not a stable release note.
- `README.md`
  - No expected change for test-only work unless verification uncovers a user
    facing behavior or documented command that must be corrected.

## Test Strategy

1. Red
   - Add targeted tests against the existing behavior, starting with
     `packageSourceBrowser`.
   - Run the focused test file first to catch incorrect assumptions quickly.
2. Green
   - Fix only test code unless a real production bug is exposed.
   - Preserve strict TypeScript rules: no `any`, no `@ts-ignore`, no non-null
     assertions.
3. Coverage Iteration
   - Run `pnpm test:coverage`.
   - Final coverage result after test additions:
     - `41` test files passed.
     - `635` tests passed.
     - Global branch coverage: `80.28%`.
     - Global statements/lines/functions remain above threshold.
4. Full Verification
   - `pnpm test`
   - `pnpm test:coverage`
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm cspell`
   - `pnpm package`
   - `pnpm audit --audit-level=high`
   - `cd e2e && pnpm test`

## Release Steps

1. Review the final diff for project-name leakage; use only neutral examples such
   as `sample`, `demo`, or `mock`.
2. Bump the pre-release version only if committing this phase, following the
   user's earlier release workflow requirement.
3. Commit without bypassing hooks.
4. Push to `origin/master`.
5. Watch GitHub Actions with `gh` until triggered workflows finish; inspect logs
   and fix any failure before final response.
