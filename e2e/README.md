# E2E Tests (Independent)

This folder contains a standalone E2E harness for the `cds-debug` VS Code extension.

## Why this setup
- Independent from the root test stack (`vitest`)
- No changes to extension source code (`src/**`)
- Real UI tests against the VS Code runtime
- Runtime-correct package-browser coverage via the extension-host E2E bridge instead of webview-only fake state

## Coverage
Current suite validates end-to-end user behavior with comprehensive per-screen element verification.

### Launch JSON and CAP Debug Config (7 tests)
1. User can reopen VS Code and stale CDS launch configs are cleaned while manual configs are kept.
2. User setting overrides workspace cap config when generating launch.json.
3. Workspace cap config is used when no user setting is configured.
4. User can resolve regex remoteRoot to the matching CF service folder.
5. User can start debug while remoteRoot warmup is in flight and get remoteRoot in the first launch.json.
6. Per-service cap config overrides both user setting and workspace fallback.
7. Malformed user setting falls back to workspace cap config.

### Onboarding and Launcher (19 tests)
1. User can login and see mocked CF org list — verifies all REGION elements (step-badge 1/3, searchable scrollable 50-region list, representative region radio inputs, endpoint `.radio-desc`) and SELECT_ORG elements (step-badge 2/3, info-box, section label, disabled Next button, back button, `.org-item` labels with radio inputs).
2. User can keep org search hidden until synced topology is ready.
3. User can search a synced org across regions and continue after confirming — verifies the Step 1 org search tab, staged native result button selection, explicit footer confirmation, and Step 3 folder handoff.
4. User can switch to region fallback and filter regions after synced topology is ready — verifies the Region tab search input, scrollable filtered region list, supplemental SAP endpoint mappings for `eu10-*`, `eu20-*`, and `us10-*`, China endpoint mapping, and manual login button.
5. User can see setup screen when credentials are missing — verifies all SETUP_CREDENTIALS elements (info-box, inputs, password toggle, save button, env hint, no cancel button).
6. User can see setup credential validation errors.
7. User can see non-HTTPS endpoint validation error.
8. User can login with a valid custom endpoint.
9. User can see login error when CF authentication fails.
10. User can cancel in-progress login and return to region screen — verifies all LOGGING_IN elements (spinner, heading, endpoint URL, cancel button).
11. LOGGING_IN reconnecting variant — verifies "Session expired. Reconnecting…" heading, endpoint URL, and absence of cancel button when `isReconnecting=true`.
12. User can see empty-org state when org list is empty.
13. User can navigate org selection and go back to region.
14. User can select a CF space when selected org has multiple spaces — verifies SELECT_SPACE elements (step-badge 2/3, org info-box, section label, space radio inputs, disabled Next until selected, selected-space folder handoff, back navigation).
15. User can complete mapping flow and reach ready screen — verifies all READY structural elements (refresh/gear/remap buttons, footer counter, select-all row, no error box, `.sr-only[aria-live]` region).
16. User can filter/select started apps in ready screen.
17. User can see apps-load error and retry affordance — verifies `#btn-retry-apps` ID.
18. User can cancel in-progress app loading and return to folder screen — verifies LOADING_APPS spinner and cancel button.
19. User can open settings from ready and logout back to region.

### Optimistic UI (1 test)
20. Clicking Start Debug Sessions shows pending sessions immediately before the network call completes.

### Ready Screen — App List and UI Details (4 tests)
21. Stopped app has disabled checkbox, stopped badge, `.app-row.stopped` CSS class; Started/Stopped section labels present.
22. CF info box shows region (eu10 — Europe (Frankfurt)), org, and space values.
23. Footer shows "No started apps" and select-all count drops to (0) when all started apps have active sessions.
24. Active app shows "debugging" badge, disabled checkbox, `.app-row.in-debug` CSS class; select-all count updates; label flips to "Deselect all"; "No apps found" on unmatched search.

### Active Session Cards — Lifecycle (9 tests)
25. DEBUG_CONNECTING creates a TUNNELING card with spinner, Active Sessions label, and stop button.
26. APP_DEBUG_STATUS ATTACHED updates card to "Debugger Attached" and removes spinner.
27. APP_DEBUG_STATUS EXITED removes the card and re-enables the app checkbox.
28. APP_DEBUG_STATUS ERROR shows error message and retry button.
29. Stop single session click removes the active card.
30. SSH_ENABLING and SSH_RESTARTING show correct spinner + status text; no extra action button beyond stop/retry.
31. ATTACHED state keeps the Package button and port number in the card title without showing Open App.
32. ATTACHED with unmappedApps shows `.active-card-no-src` "no src" badge (debug console only, no local source folder).
33. Stop All button absent with one session; visible with count ≥ 2; disappears again when count drops back to 1 via EXITED.

### Ready Screen — Actions and Navigation (4 tests)
34. DEBUG_ERROR clears PENDING sessions, shows error message, and shows `#btn-retry-apps` alongside the error box.
35. Change Mapping with no active sessions returns to **CF Region / Org** (step 1/3), not Select CF Org.
36. Cancel app loading returns to **Ready** screen (not Select Folder) when apps were previously loaded — verifies the `state.apps.length > 0` conditional branch.
37. Refresh Apps bypasses cache and redisplays the latest app list.

### Settings Screen (6 tests)
38. Keychain credentials section — verifies `.cred-source-badge.keychain`, email display, `#btn-update-credentials`, and `#btn-clear-credentials` via injected CREDENTIALS_STATUS.
39. No-credentials section — verifies "No credentials configured." text and `#btn-update-credentials` (Set Credentials) when `source: 'none'`.
40. Stopping-sync state — `.sync-status-row.running` + spinner + "Stopping sync…" when cache disabled but sync still in progress.
41. Sync running state — verifies `.sync-status-row.running`, spinner, `.progress-bar-wrap`, `.progress-bar-fill`, disabled Sync Now button via injected SYNC_STATUS.
42. Cache disabled state — verifies unchecked `#chk-cache-enabled`, disabled `#select-interval`, disabled Sync Now, and "Caching disabled" status row via injected CACHE_CONFIG.
43. Back to Launcher — verifies all 4 sections: SAP Credentials (env badge + email + info icon), Debug Behavior (both toggles + `.pref-state-badge` + `.beta-badge` + `.pref-row .toggle-switch` × 2), App Cache (checked by default, sync interval, enabled Sync Now, "Last sync: Never"), navigation buttons.

### Select Folder Screen (1 test)
44. Save and Continue disabled until folder selected — verifies all SELECT_FOLDER elements (step-badge 3/3, org info-box, section label, "No folder selected yet", browse/back buttons).

### Preparing Branches Screen (5 tests)
45. BRANCH_PREP_START shows prep screen with service rows, branch badges, spinner status, and step-by-step updates (stashing → done → error) — verifies all 3 status block variants.
46. BRANCH_PREP_START with empty services shows `.org-list-empty` "No services to prepare." placeholder inside `.prep-list`.
47. DEBUG_CONNECTING from PREPARING_BRANCHES screen transitions to READY with the new session card; prep rows cleared.
48. BRANCH_PREP_STATUS step variants — verifies checking-out, installing, building, and skipped steps; verifies `.prep-row-top`, `.prep-name`, `.prep-row-status` structural elements.
49. BRANCH_PREP all done without errors transitions status block to "Starting debug sessions…" with spinner.

### Setup Credentials Screen (5 tests)
50. CREDENTIALS_ERROR directly injected shows `.error-box` and re-enables `#btn-save-creds` (bypasses macOS SecretStorage race).
51. Update mode — verifies "Update Credentials" title, `#btn-cancel-creds` visible, no `.cred-env-hint`, "Update & Continue" save button label; Back to Settings navigation.
52. CREDENTIALS_REVOKED forces redirect to SETUP_CREDENTIALS with the revocation error in `.error-box`; setup mode (env hint visible, no cancel button, save button enabled — because handler sets `hasCredentials=false`).
53. CREDENTIALS_STATUS `{hasCredentials:false}` when `prevHad=true` forces redirect to SETUP_CREDENTIALS setup mode; no error box (clean credential-clear path).
54. Successful credential save without prior mappings navigates to the Region screen.

## Mocking strategy
- Credentials are scenario-based:
  - `env` mode injects `SAP_EMAIL` and `SAP_PASSWORD`.
  - `none` mode clears both variables.
- Cloud Foundry CLI is mocked by creating a temporary `cf` binary and prepending it to `PATH`.
- `cf ssh -c` is mocked for remote `package.json` discovery, so regex `remoteRoot` E2E tests never call a real CF app.
- Scenarios include:
  - `success`
  - `auth-fail`
  - `no-orgs`
  - `apps-fail`
  - `slow-auth`
  - `slow-apps`
  - `slow-target`
  - `slow-target-after-apps`
  - `reload-changes`
  - `multi-spaces`
- Folder selection in mapping flow is simulated via the same webview message (`GROUP_FOLDER_SELECTED`) used by the extension after native folder-pick.

## Prerequisites
- macOS with `code` CLI available in PATH
- Node.js >= 20
- `pnpm`

## Install
```bash
cd e2e
pnpm install
```

## Run
```bash
cd e2e
pnpm test
```

Optional deep-observation run:
```bash
cd e2e
CDS_DEBUG_E2E_CAPTURE_STEPS=1 CDS_DEBUG_E2E_STEP_DELAY_MS=10000 pnpm test -- --grep "Packages Browser"
```

## Report
```bash
cd e2e
pnpm test:report
```

## Notes
- Each test run uses isolated temporary VS Code profile directories.
- The harness closes VS Code gracefully via CDP (`Browser.close`) and falls back to process signals only if needed.
- Playwright artifacts are written to `e2e/test-results` and `e2e/playwright-report`.
- Every test now preserves its output directory and emits a default evidence bundle:
  - `session-final-diagnostics.txt`
  - `session-final-workbench.png`
  - `session-final-workbench.html`
  - failure runs also emit `session-failure-*`
- `playwright-report/results.json` is emitted on every run for machine-readable inspection.
- `CDS_DEBUG_E2E_CAPTURE_STEPS=1` adds best-effort workbench snapshots at key harness checkpoints; combine it with `CDS_DEBUG_E2E_STEP_DELAY_MS=10000` when you want to watch the UI evolve in real time.
