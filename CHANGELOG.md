# Changelog

## [0.3.62-pre.31] — 2026

### Fixes

- **Package Browser breakpoints now bind visibly for path-only file sources** — When a package source opens as a `file:` URI with `sourceReference: 0`, CDS Debug mirrors the breakpoint to the live debug sessions, reads the adapter's `verified=true` response, and refreshes the same VS Code breakpoint so the editor UI changes from gray/unbound to red/bound.
- **Package source identity is tracked across file and debug URIs** — Package Browser now keeps the originating source path, source reference, and session metadata for opened package files so breakpoint mirroring, tab dedupe, and cleanup all reason about the same logical source.
- **Dependency source maps are included in generated attach configs** — Generated `outFiles` now includes app, workspace, and bounded ancestor `node_modules` roots, which lets vscode-js-debug verify package breakpoints through its native source-map pipeline.
- **Source-reference package files can be materialized safely** — When a package source is only available through DAP `source` content, CDS Debug can write it to a safe local `node_modules` path and open it as a normal `file:` URI instead of forcing a virtual debug-source editor.
- **Auto-attached debug sessions are tracked by session id** — Child and worker sessions with repeated display names are retained separately, improving Package Browser source collection and breakpoint propagation.

---

## [0.3.62-pre.19] — 2026

### Changes

- **Region login now refreshes orgs through cf-sync** — Updated `@saptools/cf-sync` to `0.4.9` and use its region org-list refresh during Cloud Foundry login, so Step 2 shows the latest orgs without walking spaces or apps.
- **Org-list topology stays a live navigation hint** — CDS Debug now treats topology accounts with empty `spaces` as org-list-only data, preserving live `cf spaces` fallback until targeted space/app data is synced.

## [0.3.62-pre.17] — 2026

### Changes

- **Cache sync now delegates topology recovery to cf-sync** — Updated `@saptools/cf-sync` to `0.4.7`, moved background CF topology commands back to cf-sync's timeout-backed helpers, and removed CDS Debug's local stale-lock recovery workaround while keeping Change Mapping cancellation responsive.

---

## [0.3.62-pre.16] — 2026

### Fixes

- **Cache sync no longer strands Change Mapping** — Change Mapping now asks the extension host to stop an in-flight cache sync, background CF sync commands use the extension's timeout-backed CF client, and stale cf-sync locks are recovered before a new manual Sync Now attempt.

---

## [0.3.62-pre.15] — 2026

### Changes

- **Topology-first CF navigation** — Synced cf-sync topology now carries spaces and apps, letting the launcher skip live `cf orgs`, `cf spaces`, and `cf apps` round-trips on the cached happy path while keeping live fallbacks for misses and space sync errors.
- **Background CF session warmup** — Apps loaded from topology render immediately while the extension warms the CF target/session in the background and serializes warmup with Start Debug.
- **First-run cache bootstrap** — Saving credentials triggers an immediate background sync, and first login warms the selected cf-sync region when topology is not already available.

---

## [0.3.62-pre.14] — 2026

### Fixes

- **External CF scope changes are serialized** — Rapid external updates to `sapCap.currentScope` now queue through one handler, preventing overlapping cross-region auto-logins from leaving the launcher and CF CLI on different targets.
- **CF auth failures return faster** — `cfLogin` now skips retry backoff for clear credential/auth failures while still retrying transient network errors.
- **Remote root warmup is parallelized safely** — Started apps now warm regex remote roots in bounded batches of four instead of one at a time.
- **Cache sync skipped attempts are visible** — Settings now preserves the last successful sync time and shows the latest skipped/failed attempt reason, such as missing credentials.

---

## [0.3.62-pre.13] — 2026

### Fixes

- **Login-shell environment lookup now retries after spawn failures** — A failed login-shell environment read no longer caches an empty result for the whole VS Code session, so credentials from shell dotfiles can be found on a later user-triggered retry.
- **Settings preference toggles stay visually in sync** — Late preference refresh messages now update the Settings toggle DOM in place, preventing CI-visible races where a saved debug preference could look disabled until reopening Settings.

---

## [0.3.62-pre.12] — 2026

### Changes

- **Remote inspector stop reminder is now opt-in** — Stopping debug no longer shows the Node inspector restart reminder by default. Teams that still want the reminder can enable `cdsDebug.warnRemoteInspectorAfterStop`, while automatic app restart remains opt-in via `cdsDebug.autoRestartAppAfterStop`.

---

## [0.3.62-pre.11] — 2026

### Fixes

- **Cross-region shared CF scope errors are now visible and safe** — Failed external cross-region auto-login now reports `LOGIN_ERROR` in the launcher, reuses the credential revocation flow for auth failures, clears stale pending external scopes when a newer credential-backed scope arrives, and redacts `cf auth` command arguments from CF CLI errors before they reach logs or UI.

---

## [0.3.62-pre.10] — 2026

### Fixes

- **External CF scope changes stop active sessions first** — CDS Debug now stops active debug sessions, clears breakpoint snapshots, and notifies the user before applying an externally synced org/space change, preventing stale tunnels and cross-region reconnect races.

---

## [0.3.62-pre.9] — 2026

### Fixes

- **Shared CF scope folder mapping recovery** — External scope sync now opens the `3/3 Select Local Folder` step when the target org/space has no saved mapping, and cross-region sync without stored credentials pre-fills the target region for manual login.

---

## [0.3.62-pre.8] — 2026

### Fixes

- **Cross-region shared CF scope sync** — External updates to `sapCap.currentScope` from another CF region now trigger a credential-backed auto-login, preserve saved mappings, and reselect the target org/space when available instead of being silently ignored.

---

## [0.3.62-pre.7] — 2026

### Changes

- **Remote inspector cleanup hardening** — CDS Debug now clears remote breakpoints before stop, warns that the Node inspector may remain open until app restart, offers opt-in auto-restart after stop, detects stale local `cf ssh` inspector tunnels on activation, warns about local `debugger;` statements after attach, and uses an app-level keepalive to recover faster from half-open debug tunnels.
- **Safer inspector activation** — The default USR1 signal now targets a likely main Node process (`server.js`, `app.js`, or `index.js`) and avoids common sidecars such as `cds-mtxs`. Set `cdsDebug.signalAllNodeProcesses` to `true` to restore the previous all-node behavior.

---

## [0.3.62-pre.6] — 2026

### Changes

- **CF region catalog source cleanup** — Updated `@saptools/cf-sync` to `0.4.6`, using its catalog for `eu10-*`, `eu20-*`, `us10-001`, and `us10-002` region endpoints while keeping CDS Debug's local fallback only for upstream-missing endpoints such as `us10-004`.

---

## [0.3.62-pre.5] — 2026

### Changes

- **Shared CF scope sync** — CDS Debug now writes the verified `regionCode`, org, and space to the VS Code global `sapCap.currentScope` setting after apps load, and compatible same-region updates from external tools automatically reselect the mapped scope in the launcher.

---

## [0.3.62-pre.4] — 2026

### Fixes

- **Org folder mappings now survive CF region switches** — Logging into another CF region now preserves all saved local folder mappings instead of deleting mappings for orgs outside the current region. Restore logic now only auto-loads mappings compatible with the active region and prefers the most recently used org/space mapping.

---

## [0.3.62-pre.3] — 2026

### Fixes

- **Auto-reconnect can no longer stall on a hung pre-reconnect hook** — The beforeReconnect hook that re-runs `mergeLaunchJson` is now bounded by a 3-second timeout. A locked launch.json, slow disk, or unresponsive cap-debug-config.json read will log a warning and proceed with the existing configuration instead of leaving the session stuck in `TUNNELING…`.
- **Breakpoints in lazily-loaded scripts now bind on Windows when drive-letter casing differs** — The DAP loadedSource re-resolve now compares filesystem paths case-insensitively on Windows, where VS Code's `Uri.fsPath` (`C:\…`) and the DAP `source.path` (`c:\…`) can differ in casing despite referring to the same file.

---

## [0.3.62-pre.2] — 2026

### Fixes

- **Breakpoint-bind Sprint 3 advanced cases** — Generated launch configurations now set `autoAttachChildProcesses: true` so SAP CAP MTX sidecar / cluster workers are debugged automatically, ship default `sourceMapPathOverrides` for the Cloud Foundry runtime layout (`/home/vcap/app/*`, `/home/vcap/deps/0/node_modules/*`, plus the existing webpack defaults), and a new debug-adapter tracker re-issues `setBreakpoints` after `loadedSource` events so breakpoints land in lazily-required scripts that were eagerly loaded before attach completed (workaround for microsoft/vscode-js-debug#1510).
- **Breakpoint snapshot handling default is now fail-safe** — When the preferences store is unavailable, snapshot handling reports as disabled instead of accidentally enabling the auto-continue UX, and the first auto-continue per session surfaces an informational notification with shortcuts to the relevant settings.

---

## [0.3.62-pre.1] — 2026

### Fixes

- **Breakpoint-bind Sprint 2 cleanup** — Generated launch configurations no longer set `restart: true` so vscode-js-debug stops racing the extension's own auto-reconnect, the regex `remoteRoot` warning surfaces in a one-shot VS Code notification with actions to open the offending `cap-debug-config.json` or the CDS Debug output channel instead of failing silently, and auto-reconnect re-runs `mergeLaunchJson` before the next attach so edits to `cap-debug-config.json` made mid-session are picked up.

### Changes

- **`cap-debug-config.json` and `cdsDebug.sharedCapDebugConfig` schema extended** — Added `outFiles`, `outFilesExtra`, `resolveSourceMapLocations`, and `sourceMapPathOverrides` fields with strict type guards so users can replace, append to, or refine the source-map handling produced by the extension without hand-editing `launch.json`.

---

## [0.3.62-pre.0] — 2026

### Fixes

- **Breakpoints bind on the first attach (Sprint 1 of breakpoint-bind hardening)** — Generated launch configurations now expand `outFiles` to cover `srv`, `gen/srv`, `app`, `lib`, `dist`, and `build` (excluding `node_modules`), set `resolveSourceMapLocations: null` so source maps with embedded remote paths are no longer silently dropped, resolve `localRoot` through `fs.realpath` to handle macOS `/private/var/...` symlink workspaces, and fall back to `localRoot` when a regex `remoteRoot` is configured but has not yet resolved — eliminating the "Stop and Start again to bind" workaround for several common configurations.

---

## [0.3.61-pre.1] — 2026

### Fixes

- **Verified SSH tunnel cleanup** — Stop and debug-session termination now await local debug port cleanup and verify the port is free before fast restarts, preventing confusing `address already in use` failures when restarting the same CF app quickly.

---

## [0.3.61-pre.0] — 2026

### Security

- **Branch preparation RCE hardening** — Replaced shell-based git and pnpm execution with `execFile` argument arrays, added strict branch-name validation for `cap-debug-config.json` and `cdsDebug.sharedCapDebugConfig`, and surface unsafe branch config warnings without logging payloads.

---

## [0.3.61] — 2026

### Fixes

- **Custom endpoint flow** — Moved custom CF API endpoint entry out of the scrollable region list into a dedicated Region tab panel action, keeping the `1/3 CF Region / Org` header, selector tabs, and `Login to Cloud Foundry` footer position stable.

---

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
