# CDS Debug — Agent Guidelines

## 🤖 AI Agent Instructions (CRITICAL)
- **MANDATORY FIRST STEP**: You MUST **ALWAYS** read and review all relevant rule files inside the `.agents/rules/` directory before starting any task or writing any code. These rules govern how you should implement features, debug, and document changes.

**Rule files in `.agents/rules/`:**
| File | Coverage |
|---|---|
| `anti-laziness-and-deep-research.md` | No assumptions, mandatory planning, self-correction |
| `strict-git-hooks.md` | Never bypass git hooks (`--no-verify`) |
| `typescript-strict-rules.md` | No `any`/`!`/`@ts-ignore`/enum, explicit return types, type imports |
| `testing-playwright-rules.md` | TDD-first E2E, single spec file, evidence bundles, test registry |
| `security-guardrails.md` | No secrets in code, safe shell execution, SecretStorage, credential handling |
| `code-quality-guardrails.md` | File/function size limits, Rule of Three, no commented-out code, comments explain why |

## Project Overview
CDS Debug is a VS Code extension that enables developers to debug multiple SAP CAP services simultaneously via Cloud Foundry integration. It provides a sidebar panel with region selection, CF authentication, app listing, multi-select debug session launching, and automated `launch.json` configuration.

## Architecture
```text
cds-debug/
├── src/
│   ├── core/                # Business logic modules
│   │   ├── appMapper.ts             # CF app ↔ local folder mapping
│   │   ├── breakpointSnapshotManager.ts  # Breakpoint context capture
│   │   ├── cacheSync.ts             # Background app list caching
│   │   ├── capDebugConfig.ts        # cap-debug-config.json resolution
│   │   ├── cfClient.ts              # Cloud Foundry CLI wrapper
│   │   ├── cfLogsManager.ts         # CF app log streaming
│   │   ├── folderScanner.ts         # Workspace folder scanning
│   │   ├── gitOperations.ts         # Git branch preparation
│   │   ├── launchConfigurator.ts    # launch.json generation/merge
│   │   ├── logger.ts               # Structured output channel logger
│   │   ├── packageSourceBrowser.ts  # NPM package source viewer
│   │   ├── processManager.ts        # Debug process lifecycle
│   │   ├── shellEnv.ts             # Shell environment variable resolution
│   │   └── whatsNewManager.ts       # What's New version tracking & show logic
│   ├── storage/             # Persistence layer
│   │   ├── cacheStore.ts            # App list cache (globalState)
│   │   └── configStore.ts           # Config persistence (globalState)
│   ├── testing/             # Test infrastructure
│   │   └── e2eBridge.ts             # E2E bridge for extension-host communication
│   ├── types/               # TypeScript type definitions
│   │   └── index.ts                 # All shared types
│   ├── webview/             # UI layer (HTML/CSS/JS injected into VS Code webview)
│   │   ├── debugPanel.ts            # Main webview provider
│   │   ├── getWebviewContent.ts     # HTML template
│   │   ├── logsPanel.ts             # CF logs webview
│   │   ├── packageBrowserContent.ts # Package browser HTML
│   │   ├── packageBrowserStyles.ts  # Package browser CSS
│   │   ├── webviewRenderers.ts      # Screen renderers (region, org, ready, settings, etc.)
│   │   ├── webviewScript.ts         # Client-side JS for webview
│   │   ├── webviewStyles.ts         # Main webview CSS
│   │   └── whatsNewPanel.ts         # What's New editor-tab panel (changelog content + HTML)
│   └── extension.ts         # Extension entry point (activate/deactivate)
├── test/                    # Unit tests (Vitest)
│   ├── core/                # Tests for src/core/*
│   ├── storage/             # Tests for src/storage/*
│   ├── testing/             # Tests for src/testing/*
│   └── webview/             # Tests for src/webview/*
├── e2e/                     # E2E tests (Playwright + VS Code CDP)
│   ├── tests/               # Test specs
│   │   └── extension-smoke.spec.ts  # All E2E tests (single file)
│   ├── support/             # Test helpers
│   │   └── sessionEvidence.ts       # Evidence collection utility
│   ├── playwright.config.ts
│   └── package.json         # Independent dependency set
├── .agents/                 # Agent rules and config
├── .github/workflows/       # CI/CD pipelines
├── designs/prototypes/      # Design prototypes
└── notes/                   # Development notes
```

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | VS Code Extension API (^1.116.0) |
| Language | TypeScript 6 (strict mode) |
| Bundler | esbuild |
| Unit Testing | Vitest 4 + @vitest/coverage-v8 |
| E2E Testing | Playwright 1.53 (CDP against real VS Code) |
| Linting | ESLint 10 + typescript-eslint (strictTypeChecked + stylisticTypeChecked) |
| Spelling | cspell 10 |
| Git Hooks | Husky 9 + lint-staged 16 |
| Package Manager | pnpm 9 |

## TDD Workflow (MANDATORY)

> [!IMPORTANT]
> Every code change MUST follow the Red-Green-Refactor cycle. No exceptions.

### For Unit Tests (Vitest)
1. **Red**: Write a failing unit test in `test/` that describes the expected behavior
2. **Green**: Write the minimum code in `src/` to make the test pass
3. **Refactor**: Clean up while keeping tests green
4. **Verify**: `pnpm test` must pass with 80%+ coverage on branches, functions, lines, statements

### For E2E Tests (Playwright)
1. **Red**: Add a failing test to `e2e/tests/extension-smoke.spec.ts` describing user behavior
2. **Green**: Implement the feature in `src/` (webview + core logic)
3. **Verify**: `cd e2e && pnpm test` must pass
4. **Register**: Update the E2E Test Registry below

### Coverage Thresholds (Enforced)
```
branches:   80%
functions:  80%
lines:      80%
statements: 80%
```
Coverage scope: `src/core/**/*.ts`, `src/storage/**/*.ts`
Excluded: `logger.ts`, `processManager.ts`, `cacheSync.ts`, `src/webview/**`, `extension.ts`, `src/types/**`

## Setup & Commands

```bash
pnpm install              # Install dependencies
pnpm build                # Compile with esbuild
pnpm watch                # Rebuild on changes
pnpm test                 # Unit tests (Vitest)
pnpm test:watch           # Unit tests in watch mode
pnpm test:coverage        # Unit tests with coverage report
pnpm typecheck            # tsc --noEmit
pnpm lint                 # ESLint (src + test, max-warnings=0)
pnpm cspell               # Spell check
pnpm package              # Build → cds-debug-x.x.x.vsix
```

### E2E Tests (separate workspace)
```bash
cd e2e
pnpm install
pnpm test                 # Build extension + run Playwright
pnpm test:report          # Open HTML report
```

## E2E Test Registry

### Launch JSON and CAP Debug Config
1. User can reopen VS Code and stale CDS launch configs are cleaned while manual configs are kept.
2. User setting overrides workspace cap config when generating launch.json.
3. Workspace cap config is used when no user setting is configured.
4. User can resolve regex remoteRoot to the matching CF service folder.
5. User can start debug while remoteRoot warmup is in flight and get remoteRoot in the first launch.json.
6. Per-service cap config overrides both user setting and workspace fallback.
7. Malformed user setting falls back to workspace cap config.
8. User can see a security warning instead of executing an unsafe cap config branch.

### CF Region / Org
1. User can switch to region catalog fallback and filter `cf-sync` supplemental SAP endpoints plus the local `us10-004` fallback and China region endpoints after synced topology is ready.
2. User can open custom endpoint without losing Region/Org context, keeping the header, tabs, and login footer position stable.

### Ready Screen — Actions and Navigation
1. User can change mapping and return to CF Region / Org.

### Shared CF Scope
1. User can sync the current scope through VS Code global settings.
2. User can receive an external scope from another region and auto-login to it.
3. User can map a folder after receiving an external same-region scope without a saved mapping.
4. User can prefill the target region for an external scope when credentials are missing.

### Org-Folder Caching
1. User can return to a previous region without selecting its local folder again.
2. User can restart VS Code and restore the most recently used org in the same region.

### Debug Session Process Lifecycle
1. User can stop and restart the same attached session without port reuse errors.
2. User can stop an attached session and see the remote inspector reminder.
3. User can suppress the remote inspector reminder with settings.
4. User can open the first local debugger statement warning match.
5. User can start debug with the default main-process USR1 signal command.

## Debug Cleanup Workflow

CDS Debug opens the remote Node inspector with `SIGUSR1` and attaches through a local `cf ssh -L` tunnel. Stopping a session closes the local tunnel and clears remote breakpoints defensively, but the Node inspector listener can remain open inside the CF container until the app restarts. Keep the default reminder enabled unless a workflow has another explicit inspector reset step. Use `cdsDebug.autoRestartAppAfterStop` only when an automatic `cf restart <app>` is acceptable for that space.

## What's New Workflow

When shipping a notable release, update **both** in the same PR — neither alone is enough:

| Step | File | Rule |
|---|---|---|
| 1. Prototype | `designs/prototypes/whats-new-prototype.html` | Update cards, screenshot with Playwright, review visually |
| 2. In-code | `src/webview/whatsNewPanel.ts` | Update `CHANGELOG` constant — `label: "vX.Y.Z"` (no date suffix), max 4 cards |

**Card content**: run `git log --oneline <last-stable>..HEAD`, pick the 4 most impactful changes. Fold fixes into a "Stability & Fixes" card rather than a separate section.

**When panel shows**: stable versions only (no `-pre` suffix), once per version via `globalState` (`src/core/whatsNewManager.ts`).
