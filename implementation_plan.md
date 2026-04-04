# Implementation Plan — CDS Debug

## Context Summary
- Project is a VS Code extension for orchestrating multi-service CAP debug via Cloud Foundry.
- Baseline status on April 4, 2026:
  - `pnpm lint`: pass
  - `pnpm typecheck`: pass
  - `pnpm test`: pass
  - `pnpm cspell`: fail (scans nested `sample/demo-health-svc/node_modules/**`)

## Goals
1. Fix failing quality gate(s) so required checks are green.
2. Resolve high-impact runtime correctness risks in debug session lifecycle.
3. Improve webview UX/accessibility and runtime stability with minimal architecture disruption.
4. Keep changes narrow and fully verifiable via lint/typecheck/test/cspell/build/coverage.

## Planned Changes

### 1) Quality Gate Fix (CSpell scope)
- **File**: `cspell.json`
- **Why**: Current ignore pattern misses nested `node_modules` under `sample/`, causing thousands of false-positive spell errors.
- **How**:
  - Add `**/node_modules/**` to `ignorePaths`.
  - Keep existing root ignore entries unchanged.
- **Verification**: `pnpm cspell` passes.

### 2) Debug Stop Behavior Correctness
- **Files**: `src/core/processManager.ts`, `src/webview/debugPanel.ts` (if event payload needs adjustment)
- **Why**:
  - `stopProcess(appName)` currently calls `vscode.debug.stopDebugging()` without targeting the specific session, which can stop unrelated/active sessions.
- **How**:
  - Introduce helper to find debug session by exact launch config name (`Debug: <appName>`).
  - Stop only that specific session if present.
  - Keep process cleanup deterministic even if no debug session is currently active.
- **Verification**:
  - Unit-level behavior reasoning + no regression in existing tests/lint/typecheck.

### 3) Process Lifecycle Robustness
- **File**: `src/core/processManager.ts`
- **Why**:
  - Spawn `error` path may leave stale map state.
  - Duplicate status emissions can happen around kill/close timing.
- **How**:
  - Centralize cleanup in a small helper that is idempotent.
  - Ensure maps are cleaned on `error` and `close` safely.
  - Preserve UX event semantics (`TUNNELING` -> `ATTACHED|ERROR|EXITED`).
- **Verification**:
  - Lint/typecheck/test pass.
  - Manual reasoning confirms no stale sessions after stop/error.

### 4) Webview Runtime + UX/A11y Improvements
- **File**: `src/webview/getWebviewContent.ts`
- **Why**:
  - Repeated `DEBUG_CONNECTING` events can create orphaned intervals.
  - Icon-only action needs clearer accessibility labeling and status announcement.
  - App load failure should not present stale app list for newly selected org.
- **How**:
  - Clear existing interval before creating a new one for the same app.
  - Add an `aria-live="polite"` region for async status/error updates.
  - Ensure active action buttons have explicit `aria-label`.
  - On app load error, clear app list and selection for consistent state.
- **Verification**:
  - Lint/typecheck/test/cspell pass.
  - Manual scan against web interface guideline essentials.

### 5) Logging Privacy Hardening
- **File**: `src/webview/debugPanel.ts`
- **Why**:
  - Current log includes full login email in output channel.
- **How**:
  - Remove direct email value from logs; keep endpoint and non-sensitive context.
- **Verification**:
  - Functional behavior unchanged; logs contain no raw credential identifiers.

## Execution Order
1. Update `cspell.json`.
2. Refactor `processManager.ts` stop/cleanup logic.
3. Patch `debugPanel.ts` privacy + error-state handling.
4. Patch `getWebviewContent.ts` interval/a11y/state fixes.
5. Run full verification suite and iterate until all pass.

## Validation Checklist
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm cspell`
- `pnpm test:coverage`
- `pnpm build`

## Risk Notes
- Process/session logic touches extension runtime behavior; changes are kept minimal and localized.
- Webview script is inline and stateful; interval cleanup changes are isolated to existing message handlers.
