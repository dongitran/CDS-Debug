# E2E Tests (Independent)

This folder contains a standalone E2E harness for the `cds-debug` VS Code extension.

## Why this setup
- Independent from the root test stack (`vitest`)
- No changes to extension source code (`src/**`)
- Real UI tests against the VS Code runtime

## Coverage
Current suite validates end-to-end user behavior across onboarding and launcher flows:
1. User can login and see mocked CF org list.
2. User can see setup screen when credentials are missing.
3. User can see setup credential validation errors.
4. User can see non-HTTPS endpoint validation error.
5. User can login with a valid custom endpoint.
6. User can see login error when CF authentication fails.
7. User can cancel in-progress login and return to region screen.
8. User can see empty-org state when org list is empty.
9. User can navigate org selection and go back to region.
10. User can complete mapping flow and reach ready screen.
11. User can filter/select started apps in ready screen.
12. User can see apps-load error and retry affordance.
13. User can cancel in-progress app loading and return to folder screen.
14. User can open settings from ready and logout back to region.

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
