# Implementation Plan: Professionalize VS Code Extension E2E Coverage

## Objective
Evolve the E2E suite from onboarding smoke checks into a robust behavior-focused harness that validates core launcher flows end-to-end in real VS Code, without touching extension runtime code.

## Constraints
- Keep all test implementation inside `e2e/**`.
- Do not modify extension source files in `src/**`.
- Keep tests isolated (fresh user-data/extensions dirs per case).
- Keep deterministic CI behavior by mocking Cloud Foundry CLI and credentials.

## Deep Research Summary
1. Screen transitions are fully driven by message types in `src/webview/webviewScript.ts` (`LOGIN_SUCCESS`, `LOGIN_ERROR`, `APPS_LOADED`, `APPS_ERROR`, `CREDENTIALS_*`).
2. Region/login/org/folder/ready/settings UIs and button IDs are deterministic in `src/webview/webviewRenderers.ts`.
3. Login and app loading are delegated to CF CLI calls through `src/webview/debugPanel.ts` -> `src/core/cfClient.ts`.
4. Folder selection is initiated by extension API (`SELECT_GROUP_FOLDER`) and fed back via `GROUP_FOLDER_SELECTED` message.
5. Stable E2E control points already exist: isolated VS Code launch, CDP attach, frame discovery, graceful teardown with kill fallback.

## Expanded Test Matrix
### A. Onboarding and Auth
1. User can login and see mocked org list.
2. User can see setup screen when credentials are missing.
3. User can see setup credential validation errors.
4. User can see non-HTTPS endpoint validation error.
5. User can login using a valid custom endpoint.
6. User can see login error when CF auth fails.
7. User can cancel in-progress login and return to region screen.
8. User can see empty-org state when org list is empty.
9. User can navigate org selection and go back to region.

### B. Mapping, Apps, Ready, Settings
10. User can complete org+folder mapping and reach ready screen with apps.
11. User can filter and select started apps in ready screen.
12. User can see apps-load error and retry affordance.
13. User can cancel in-progress app loading and return to folder screen.
14. User can open settings from ready and logout back to region.

## Technical Approach
1. Extend CF mock scenarios in `e2e/tests/extension-smoke.spec.ts`:
- `success`, `auth-fail`, `no-orgs`, `apps-fail`, `slow-auth`, `slow-apps`.
2. Add reusable flow helpers:
- login to org screen
- select org to folder screen
- simulate folder selection via webview message (no extension code change)
- complete flow to ready screen
3. Keep selector strategy semantic-first (`getByRole`, `getByText`) and use explicit IDs only where dynamic labels make role matching unstable.
4. Preserve strict teardown to prevent orphan VS Code processes between tests.

## Files To Update
1. `e2e/tests/extension-smoke.spec.ts`
- Add new CF scenarios and helper functions.
- Expand suite to 14 high-value E2E behavior cases.

2. `e2e/README.md`
- Document expanded coverage scope and scenario catalog.

## Verification Plan
1. Kill leftover VS Code extension-development processes before running.
2. Run full suite: `pnpm --dir e2e test`.
3. Confirm all cases pass locally.
4. Confirm no orphan VS Code process remains after suite completion.
