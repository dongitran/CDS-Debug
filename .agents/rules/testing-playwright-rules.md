---
description: E2E testing rules for CDS Debug — VS Code extension E2E with Playwright, TDD-first, evidence bundles, strict test management
---
# Testing Rules — E2E (Playwright + VS Code)

> [!IMPORTANT]
> CDS Debug E2E tests run against a real VS Code instance via CDP. They are the **final quality gate** before publishing to the VS Code Marketplace. Flaky or missing tests block releases. Every feature MUST have corresponding E2E coverage.

## 1. TDD-First for E2E — Write the Test Before the Feature

- **ALWAYS** write or update the E2E test **before** implementing the feature code.
- The workflow is: (1) Add a failing E2E test describing the expected user behavior, (2) Implement the feature in `src/`, (3) Verify the test passes, (4) Refactor.
- Every PR that adds a user-visible feature MUST include an E2E test update. PRs without tests are rejected.

## 2. Test Naming — Describe User Behavior

- **ALWAYS** name tests to complete the sentence "User can...". Test names must describe behavior, not implementation.
- Group with `test.describe()` by user flow or screen.
- Correct: `test('User can login and see mocked CF org list', ...)`
- Forbidden: `test('renders region screen correctly', ...)`

## 3. Single Spec File — Append, Don't Scatter

- CDS Debug E2E uses a **single spec file** (`e2e/tests/extension-smoke.spec.ts`). This is intentional — VS Code extension E2E requires sequential test execution with shared extension-host lifecycle.
- **ALWAYS** append new tests to the existing spec file. **NEVER** create additional spec files without explicit approval.
- Group new tests under an existing `test.describe()` block or create a new block if the screen/flow is genuinely new.

## 4. Concise Tests — Assert What Matters

- Each test should be **focused and concise**. Test ONE user behavior per test.
- Assert only the elements that prove the behavior works. Do not assert every CSS class or DOM attribute unless it is the subject of the test.
- Keep test body under **30 lines**. If longer, extract a helper into `e2e/support/`.

## 5. Evidence Bundles — Diagnostics on Every Run

- Every test produces evidence bundles: `session-final-diagnostics.txt`, `session-final-workbench.png`, `session-final-workbench.html`.
- Failure runs also emit `session-failure-*` files.
- **NEVER** disable evidence collection. It is critical for debugging CI failures.

## 6. Mocking Strategy — CF CLI and Credentials

- CF CLI is mocked by creating a temporary `cf` binary and prepending it to `PATH`. Available scenarios: `success`, `auth-fail`, `no-orgs`, `apps-fail`, `slow-auth`, `slow-apps`, `slow-target`.
- Credentials are scenario-based: `env` mode injects `SAP_EMAIL`/`SAP_PASSWORD`, `none` mode clears them.
- **NEVER** use real CF credentials or real CF CLI in E2E tests.

## 7. No `waitForTimeout()` — Use Web-First Assertions

- **NEVER** use `page.waitForTimeout(ms)` or `await new Promise(r => setTimeout(r, ms))`.
- Use web-first assertions that auto-retry: `await expect(locator).toBeVisible()`, `await expect(locator).toHaveText(...)`.
- For extension-specific events, use the `sessionEvidence.ts` helper or CDP-based waiters.

## 8. E2E Coverage Registry — Keep AGENTS.md Updated

- The `AGENTS.md` file contains a **numbered test registry** of all E2E tests. When adding or removing tests, **ALWAYS** update the registry in AGENTS.md.
- This registry is the single source of truth for E2E coverage. It prevents duplicate tests and identifies coverage gaps.

## 9. CI Configuration

- Playwright config: `trace: 'on-first-retry'`, `screenshot: 'only-on-failure'`, `preserveOutput: 'always'`.
- CI uploads `playwright-report/` and `test-results/` as artifacts on every run.
- Retries: 1 in CI, 0 locally. Workers: always 1 (sequential).
