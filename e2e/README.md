# E2E Tests (Independent)

This folder contains a standalone E2E harness for the `cds-debug` VS Code extension.

## Why this setup
- Independent from the root test stack (`vitest`)
- No changes to extension source code (`src/**`)
- Real UI smoke test against VS Code runtime

## Scope
Current smoke test verifies:
1. VS Code launches with this extension loaded from source (`--extensionDevelopmentPath`)
2. The `CDS Debug` Activity Bar view can be opened
3. The extension webview renders the CF region login screen
4. Login flow transitions to `Select CF Org` using mocked `cf` CLI output

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
- Test uses isolated temporary VS Code profile directories on each run.
- The harness injects mock `SAP_EMAIL` / `SAP_PASSWORD` for the launched VS Code process to keep the initial screen deterministic without touching your real credentials.
- The harness prepends a mocked `cf` binary into `PATH` so `cf api/auth/orgs` are fully simulated during E2E.
- This is a smoke test only; full CF login/debug workflow requires real CF credentials, CLI state, and network dependencies.
