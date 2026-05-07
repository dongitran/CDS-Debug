# Changelog

## [0.3.60] — 2026

### Changes

- **CF region catalog** — Completed the `1/3 CF Region / Org` picker supplemental endpoints from SAP's Cloud Foundry region table, adding `eu10-002`, `eu10-003`, `eu10-005`, `eu20-001`, `eu20-002`, `us10-001`, and `us10-002` while keeping the product-supported `us10-004` endpoint.

---

## [0.3.58] — 2026

### Changes

- **CF region catalog** — Added the `eu10-004` Cloud Foundry region to the `1/3 CF Region / Org` picker with endpoint `https://api.cf.eu10-004.hana.ondemand.com`.

---

## [0.3.57] — 2026

### Fixes

- **Change Mapping navigation** — The launcher now returns to `1/3 CF Region / Org` when changing mappings, so users can choose a different CF region or org from the start of the mapping flow.

---

## [0.3.54] — 2026

### Changes

- **Wider VS Code compatibility** — Lowered the minimum required VS Code engine from `1.118` to `1.112`, so users on VS Code versions from 1.112 onwards can install and use CDS Debug without needing to be on the very latest editor release.

---

## [0.3.53] — 2026

### New Highlights

- **Dynamic remote roots** — Regex-based `remoteRoot` settings resolve per CF app before debug attach, covering services deployed under different remote folders such as `/usr/sample-service-a`.
- **Compatibility refresh** — VS Code 1.118 engine support and refreshed CF sync, ESLint, TypeScript ESLint, and VS Code API dependencies.

---

## [0.3.10] — 2026

### New Features

- **Package Browser** — Browse every npm package loaded in an active debug session as a collapsible tree. Jump to any source file inside a package without navigating node_modules manually.
- **Package Regex Filter** — Filter the package list by name using a regex. Pre-configure a default via `cdsDebug.packageRegexFilter` in workspace or user settings; edits in the UI sync back automatically.
- **Auto-reconnect** — SSH tunnel reconnects automatically (up to 3 attempts) when a CF timeout or network blip drops it mid-session.
- **Breakpoint Snapshots** — Capture variable context at any breakpoint without pausing execution. Snapshots accumulate in the sidebar. Enable in Settings → Breakpoint Snapshot Handling.
- **Branch Preparation** — Stash local changes, check out the target git branch, and run `pnpm install && pnpm build` before attaching the debugger so local sources always match the remote service.
- **Shared CAP Debug Config** — Set `cdsDebug.sharedCapDebugConfig` once in VS Code user settings to share `remoteRoot` and `orgBranchMap` across all workspaces.
- **What's New panel** — Displays automatically after a version upgrade so you always know what changed.

### Bug Fixes

- Suppress VS Code's save-before-start behaviour for extension-managed debug sessions, preventing spurious permission-denied errors when an unrelated editor is open at a root path.
- Package entries reload correctly when a debug session is restarted.
- Source maps for generated CAP server files resolve from the correct output path.

---

## [0.3.0]

- Breakpoint snapshot handling foundation (capture + display).
- Auto-continue after snapshot capture (configurable via `cdsDebug.pauseOnBreakpoint`).
- Performance improvements for snapshot capture latency.

## [0.2.41]

- Shared `cdsDebug.sharedCapDebugConfig` VS Code setting as a workspace-level fallback.
- Region picker — 14 built-in CF regions plus custom endpoint support.

## [0.1.0]

- Renamed "Auto-open app in browser" to "Open browser on debugger attach" with live state badge.
- Multi-select debug — tick any running apps and launch all sessions at once.
- Background app cache with configurable sync interval.

## [0.0.25]

- Region-switch fix: stale CF session cleared before switching regions.

## [0.0.21]

- Select-all, Stop-all, Refresh, port display, theme badges.

## [0.0.19]

- Various UI bug fixes and webview polish.
