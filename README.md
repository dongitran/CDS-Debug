# ⚡ CDS Debug

> Debug multiple SAP CAP services simultaneously — directly from VS Code.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/dongtran.cds-debug?label=VS%20Marketplace&logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=dongtran.cds-debug)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/vscode-%5E1.90.0-007ACC?logo=visual-studio-code)](https://code.visualstudio.com)

---

## 😩 The Problem

Working with SAP CAP on Cloud Foundry means juggling multiple services at once:

- Opening terminals one by one, remembering ports each time
- Editing `launch.json` by hand every session
- No way to see which CF apps are actually running at a glance

**CDS Debug** removes all of that friction.

---

## 🚀 What It Does

A sidebar panel connects to your Cloud Foundry environment, shows your running apps, and with one click:

1. Starts each selected service with `cds debug` in the background
2. Writes attach configs into `.vscode/launch.json` automatically
3. Attaches the VS Code debugger — no manual setup required

---

## ✨ Features

- 🗺️ **Region Picker** — choose from the cf-sync SAP CF region catalog or enter a custom endpoint
- 🔐 **Zero-input Auth** — reads `SAP_EMAIL` / `SAP_PASSWORD` from your shell environment automatically
- 📋 **Live App List** — started apps on top, stopped dimmed below, with instant search
- ☑️ **Multi-select Debug** — tick any started apps and launch all sessions at once
- 🟢 **Session Status Panel** — watch each app go from *Connecting* → *Debugger Attached* in real time
- 🔧 **Auto `launch.json`** — configs are merged in, not overwritten; your manual entries stay safe
- 📦 **Package Browser** — browse loaded npm package sources from attached sessions without requiring a local `node_modules` install
- 🧩 **Shared CAP Config** — define one global fallback in VS Code user settings instead of copying `cap-debug-config.json` into every workspace
- 💾 **Persistent Mapping** — org ↔ folder mapping is saved, no re-setup on restart
- ⚡ **Background Cache** — app list pre-fetched in the background so loading feels instant, with automatic retry for canceled or failed sync attempts
- 🛡️ **App Watchdog** — every app you start debugging is pinged on its mapped route for 8 hours at a 90-second default interval; if it stops responding (e.g. a leftover breakpoint froze the remote process), a status bar warning points at it and opens a detail page. Apps you are actively debugging are skipped while their session is alive
- ⚙️ **Settings Panel** — control cache sync interval, watchdog ping interval, trigger a manual sync, or log out

---

## 📋 Requirements

- **Node.js** ≥ 20
- **CF CLI** installed and on `$PATH`
- Environment variables set in your shell:
  ```
  SAP_EMAIL=your@email.com
  SAP_PASSWORD=yourpassword
  ```

> If you open VS Code from the Dock or Spotlight (not a terminal), the extension automatically reads these from your shell dotfiles — no extra steps needed.

---

## 🏁 Getting Started

### 1 — Install

Search **CDS Debug** in the VS Code Extensions panel, or install directly from the Marketplace:

```
ext install dongtran.cds-debug
```

### 2 — Open the sidebar

Click the **⚡ CDS Debug** icon in the Activity Bar.

### 3 — Pick a CF region and log in

Select your region from the grid (or enter a custom endpoint), then click **Login to Cloud Foundry**. CDS Debug refreshes that region's org list through `cf-sync` before showing the org step, without loading spaces or apps. Credentials are read from your environment — nothing to type.

### 4 — Map a CF org to a local folder

Select the org you want to work with, then click **Browse…** to choose its local folder on your machine. This is saved automatically — you only do it once.

### 5 — Select apps and start debugging

Search or scroll the app list, tick the services you want to debug, and hit **▶ Start Debug Sessions**.

The extension opens a background process per service, updates `launch.json`, and attaches the debugger automatically.

### Optional — configure a shared fallback once for all workspaces

If you reuse the same CAP debug settings across many workspaces, add this to your VS Code user `settings.json`:

```json
{
  "cdsDebug.sharedCapDebugConfig": {
    "remoteRoot": "/home/vcap/app",
    "orgBranchMap": {
      "sample-org": "sample-branch"
    }
  }
}
```

`remoteRoot` can also be resolved per app when services are deployed under different folders. Use an explicit regex with `regex:<pattern>` or `/pattern/flags`; CDS Debug runs a safe `cf ssh` lookup, checks remote `package.json` folder candidates locally against the regex, and writes the concrete matching folder to `launch.json`.

```json
{
  "cdsDebug.sharedCapDebugConfig": {
    "remoteRoot": "regex:^/(usr/)?sample-service-[a-z]+$"
  }
}
```

Precedence is:

1. per-service `cap-debug-config.json`
2. user `cdsDebug.sharedCapDebugConfig`
3. workspace `.vscode/cap-debug-config.json`

### Optional — map CF apps to differently-named local folders

When you start debugging, CDS Debug matches each CF app to a local source folder under your mapped org folder by name, automatically trying the exact app name and a `-`→`_` variant. If a CF app's name differs too much from its local folder, that app would otherwise fall back to console-only debugging with no source maps. Add explicit mappings to your VS Code user `settings.json`:

```json
{
  "cdsDebug.appFolderMappings": [
    { "appName": "sample-service-billing", "folderName": "billing-internal" }
  ]
}
```

`folderName` is a folder *basename* — CDS Debug searches your mapped org folder recursively (depth ≤ 6) for a folder with that name containing a `package.json`. An explicit mapping has the highest matching priority, ahead of the exact and underscore-normalized name. If the named folder cannot be found (or has no `package.json`), resolution falls back to the automatic name matching, exactly as before. App names are matched exactly and case-sensitively; on duplicate `appName` entries the first wins.

### Optional — pre-configure the Package Regex Filter

The Packages screen has a **Package Regex Filter** field that narrows which packages are shown. You can set a default value in VS Code settings so it is pre-populated every time:

```json
// .vscode/settings.json  (workspace scope)
{
  "cdsDebug.packageRegexFilter": "^@my-org/"
}
```

Or in your user `settings.json` to apply it across all workspaces.

**Sync behaviour:**

- On first load, if `cdsDebug.packageRegexFilter` is set at workspace or user scope, the extension picks it up automatically.
- When you edit the filter in the Packages UI, the extension saves it back to the VS Code setting at the same scope where it was originally set (workspace or user), keeping settings and UI in sync.
- If you later change the VS Code setting directly (e.g. via `settings.json`), the extension detects the change and updates the UI immediately.

---

## 🛠️ Commands

| Command | Description |
|---|---|
| `CDS Debug: Reset Configuration` | Clears saved org mappings and login config |
| `CDS Debug: Show App Watchdog` | Opens the watchdog page listing watched apps and any that stopped responding |

---

## 👨‍💻 Development

```bash
pnpm install
pnpm build          # compile with esbuild
pnpm test           # run unit tests (Vitest)
pnpm test:coverage  # coverage report
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit
pnpm package        # build → cds-debug-x.x.x.vsix
```

---

## 📜 License

[MIT](LICENSE)

---

## 👨‍💻 Author

**dongtran** ✨

---

Made with ❤️ to make your work life easier!
