# E2E Tests (Independent)

This folder contains a standalone E2E harness for the `cds-debug` VS Code extension.

## Why this setup
- Independent from the root test stack (`vitest`)
- No changes to extension source code (`src/**`)
- Real UI tests against the VS Code runtime

## Coverage
Current suite validates end-to-end user behavior with comprehensive per-screen element verification.

### Onboarding and Launcher (14 tests)
1. User can login and see mocked CF org list — verifies all SELECT_ORG elements (step-badge 2/3, info-box, section label, disabled Next button, back button, org list).
2. User can see setup screen when credentials are missing — verifies all SETUP_CREDENTIALS elements (info-box, inputs, password toggle, save button).
3. User can see setup credential validation errors.
4. User can see non-HTTPS endpoint validation error.
5. User can login with a valid custom endpoint.
6. User can see login error when CF authentication fails.
7. User can cancel in-progress login and return to region screen — verifies all LOGGING_IN elements (spinner, heading, endpoint URL, cancel button).
8. User can see empty-org state when org list is empty.
9. User can navigate org selection and go back to region.
10. User can complete mapping flow and reach ready screen — verifies all READY structural elements (refresh/gear/remap buttons, footer counter, select-all row, no error box).
11. User can filter/select started apps in ready screen.
12. User can see apps-load error and retry affordance.
13. User can cancel in-progress app loading and return to folder screen — verifies LOADING_APPS spinner and cancel button.
14. User can open settings from ready and logout back to region.

### Optimistic UI (1 test)
15. Clicking Start Debug Sessions shows pending sessions immediately before the network call completes.

### Ready Screen — App List and UI Details (4 tests)
16. Stopped app has disabled checkbox and stopped badge; Started/Stopped section labels present.
17. CF info box shows region (eu10) and org values.
18. Footer shows "No started apps" and select-all count drops to (0) when all started apps have active sessions.
19. Active app shows "debugging" badge and disabled checkbox; select-all count updates; select-all label flips to "Deselect all" when all selected; "No apps found" shown on unmatched search.

### Active Session Cards — Lifecycle (7 tests)
20. DEBUG_CONNECTING creates a TUNNELING card with spinner, Active Sessions label, and stop button.
21. APP_DEBUG_STATUS ATTACHED updates card to "Debugger Attached" and removes spinner.
22. APP_DEBUG_STATUS EXITED removes the card and re-enables the app checkbox.
23. APP_DEBUG_STATUS ERROR shows error message and retry button.
24. Stop single session click removes the active card.
25. SSH_ENABLING and SSH_RESTARTING show correct spinner + status text; no Open App or Retry buttons.
26. ATTACHED state with app URL shows Open App button and port number in card title.
27. Stop All button absent with one session; visible with count when two or more sessions exist.

### Ready Screen — Actions and Navigation (4 tests)
27. DEBUG_ERROR clears PENDING sessions and shows error message.
28. Change Mapping with no active sessions returns to Select CF Org.
29. Cancel app loading returns to **Ready** screen (not Select Folder) when apps were previously loaded — verifies the `state.apps.length > 0` conditional branch.
30. Refresh Apps reloads and redisplays the app list.

### Settings Screen (1 test)
31. Back to Launcher — verifies all 4 sections: SAP Credentials (env badge + email), Debug Behavior (both toggles + "off by default" badge), App Cache (checked by default, sync interval, enabled Sync Now button, "Last sync: Never" status row), navigation buttons.

### Select Folder Screen (1 test)
31. Save and Continue disabled until folder selected — verifies all SELECT_FOLDER elements (step-badge 3/3, org info-box, section label, "No folder selected yet", browse/back buttons).

### Preparing Branches Screen (2 tests)
33. BRANCH_PREP_START shows prep screen with service rows, branch badges, spinner status, and step-by-step updates (stashing → done → error) — verifies all 3 status block variants.
34. BRANCH_PREP all done without errors transitions status block to "Starting debug sessions…" with spinner.

### Setup Credentials Screen (1 test)
35. Successful credential save without prior mappings navigates to the Region screen.

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
