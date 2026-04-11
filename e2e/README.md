# E2E Tests (Independent)

This folder contains a standalone E2E harness for the `cds-debug` VS Code extension.

## Why this setup
- Independent from the root test stack (`vitest`)
- No changes to extension source code (`src/**`)
- Real UI tests against the VS Code runtime

## Coverage
Current suite validates end-to-end user behavior with comprehensive per-screen element verification.

### Onboarding and Launcher (15 tests)
1. User can login and see mocked CF org list — verifies all REGION elements (step-badge 1/3, radio inputs, endpoint `.radio-desc`) and SELECT_ORG elements (step-badge 2/3, info-box, section label, disabled Next button, back button, `.org-item` labels with radio inputs).
2. User can see setup screen when credentials are missing — verifies all SETUP_CREDENTIALS elements (info-box, inputs, password toggle, save button, env hint, no cancel button).
3. User can see setup credential validation errors.
4. User can see non-HTTPS endpoint validation error.
5. User can login with a valid custom endpoint.
6. User can see login error when CF authentication fails.
7. User can cancel in-progress login and return to region screen — verifies all LOGGING_IN elements (spinner, heading, endpoint URL, cancel button).
8. LOGGING_IN reconnecting variant — verifies "Session expired. Reconnecting…" heading, endpoint URL, and absence of cancel button when `isReconnecting=true`.
9. User can see empty-org state when org list is empty.
10. User can navigate org selection and go back to region.
11. User can complete mapping flow and reach ready screen — verifies all READY structural elements (refresh/gear/remap buttons, footer counter, select-all row, no error box, `.sr-only[aria-live]` region).
12. User can filter/select started apps in ready screen.
13. User can see apps-load error and retry affordance — verifies `#btn-retry-apps` ID.
14. User can cancel in-progress app loading and return to folder screen — verifies LOADING_APPS spinner and cancel button.
15. User can open settings from ready and logout back to region.

### Optimistic UI (1 test)
16. Clicking Start Debug Sessions shows pending sessions immediately before the network call completes.

### Ready Screen — App List and UI Details (4 tests)
17. Stopped app has disabled checkbox, stopped badge, `.app-row.stopped` CSS class; Started/Stopped section labels present.
18. CF info box shows region (eu10 — Europe (Frankfurt)) and org values.
19. Footer shows "No started apps" and select-all count drops to (0) when all started apps have active sessions.
20. Active app shows "debugging" badge, disabled checkbox, `.app-row.in-debug` CSS class; select-all count updates; label flips to "Deselect all"; "No apps found" on unmatched search.

### Active Session Cards — Lifecycle (7 tests)
21. DEBUG_CONNECTING creates a TUNNELING card with spinner, Active Sessions label, and stop button.
22. APP_DEBUG_STATUS ATTACHED updates card to "Debugger Attached" and removes spinner.
23. APP_DEBUG_STATUS EXITED removes the card and re-enables the app checkbox.
24. APP_DEBUG_STATUS ERROR shows error message and retry button.
25. Stop single session click removes the active card.
26. SSH_ENABLING and SSH_RESTARTING show correct spinner + status text; no Open App or Retry buttons.
27. ATTACHED state with app URL shows Open App button and port number in card title.
28. Stop All button absent with one session; visible with count when two or more sessions exist.

### Ready Screen — Actions and Navigation (4 tests)
29. DEBUG_ERROR clears PENDING sessions and shows error message.
30. Change Mapping with no active sessions returns to Select CF Org.
31. Cancel app loading returns to **Ready** screen (not Select Folder) when apps were previously loaded — verifies the `state.apps.length > 0` conditional branch.
32. Refresh Apps reloads and redisplays the app list.

### Settings Screen (4 tests)
33. Keychain credentials section — verifies `.cred-source-badge.keychain`, email display, `#btn-update-credentials`, and `#btn-clear-credentials` via injected CREDENTIALS_STATUS.
34. Sync running state — verifies `.sync-status-row.running`, spinner, `.progress-bar-wrap`, `.progress-bar-fill`, disabled Sync Now button via injected SYNC_STATUS.
35. Cache disabled state — verifies unchecked `#chk-cache-enabled`, disabled `#select-interval`, disabled Sync Now, and "Caching disabled" status row via injected CACHE_CONFIG.
36. Back to Launcher — verifies all 4 sections: SAP Credentials (env badge + email), Debug Behavior (both toggles + `.pref-state-badge` + `.beta-badge` + `.pref-row .toggle-switch` × 2), App Cache (checked by default, sync interval, enabled Sync Now, "Last sync: Never"), navigation buttons.

### Select Folder Screen (1 test)
37. Save and Continue disabled until folder selected — verifies all SELECT_FOLDER elements (step-badge 3/3, org info-box, section label, "No folder selected yet", browse/back buttons).

### Preparing Branches Screen (3 tests)
38. BRANCH_PREP_START shows prep screen with service rows, branch badges, spinner status, and step-by-step updates (stashing → done → error) — verifies all 3 status block variants.
39. BRANCH_PREP_STATUS step variants — verifies checking-out, installing, building, and skipped steps; verifies `.prep-row-top`, `.prep-name`, `.prep-row-status` structural elements.
40. BRANCH_PREP all done without errors transitions status block to "Starting debug sessions…" with spinner.

### Setup Credentials Screen (2 tests)
41. Update mode — verifies "Update Credentials" title, `#btn-cancel-creds` visible, no `.cred-env-hint`, "Update & Continue" save button label; Back to Settings navigation.
42. Successful credential save without prior mappings navigates to the Region screen.

## Mocking strategy
- Credentials are scenario-based:
  - `env` mode injects `SAP_EMAIL` and `SAP_PASSWORD`.
  - `none` mode clears both variables.
- Cloud Foundry CLI is mocked by creating a temporary `cf` binary and prepending it to `PATH`.
- Scenarios include:
  - `success`
  - `auth-fail`
  - `no-orgs`
  - `apps-fail`
  - `slow-auth`
  - `slow-apps`
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

## Report
```bash
cd e2e
pnpm test:report
```

## Notes
- Each test run uses isolated temporary VS Code profile directories.
- The harness closes VS Code gracefully via CDP (`Browser.close`) and falls back to process signals only if needed.
- Playwright artifacts are written to `e2e/test-results` and `e2e/playwright-report`.
