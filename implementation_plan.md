# Implementation Plan: Add E2E GitHub Actions Workflow + Commit/Push + Monitor Run

## Objective
Add a dedicated GitHub Actions workflow file for E2E tests, commit all current E2E-related changes, push to `master`, and monitor the workflow run using `gh` CLI.

## Scope
- Add one new workflow file under `.github/workflows/`.
- Keep existing workflows (`ci.yml`, `publish.yml`, `security-audit.yml`) unchanged.
- Include current E2E harness files in the commit.
- Push to `origin/master`.
- Watch workflow status and report result.

## Constraints
- Do not bypass git hooks.
- Use non-interactive git commands only.
- Keep E2E pipeline isolated from existing CI pipeline.

## Files to Add
1. `.github/workflows/e2e.yml`
- Why: run extension E2E smoke tests in CI on Linux via Xvfb.
- What:
  - Trigger on `push` / `pull_request` to `master`.
  - Setup Node + pnpm.
  - Install VS Code (`code`) on Ubuntu runner.
  - Install root + `e2e` dependencies.
  - Run `xvfb-run -a pnpm --dir e2e test`.

## Execution Steps
1. Create `e2e.yml` workflow.
2. Validate local git state and stage all required files.
3. Commit with clear message.
4. Push to `origin/master`.
5. Use `gh run list` and `gh run watch` to monitor action outcome.

## Verification Plan
- Local pre-push check: ensure `pnpm --dir e2e test` passes.
- Post-push check: verify `e2e` workflow run is created and monitor until completion.
