# ⚡ CDS Debug

> Debug multiple SAP CAP services simultaneously — directly from VS Code.

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/dongtran.cds-debug?label=VS%20Marketplace&logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=dongtran.cds-debug)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/dongtran.cds-debug)](https://marketplace.visualstudio.com/items?itemName=dongtran.cds-debug)
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

- 🗺️ **Region Picker** — choose from 14 built-in CF regions or enter a custom endpoint
- 🔐 **Zero-input Auth** — reads `SAP_EMAIL` / `SAP_PASSWORD` from your shell environment automatically
- 📋 **Live App List** — started apps on top, stopped dimmed below, with instant search
- ☑️ **Multi-select Debug** — tick any started apps and launch all sessions at once
- 🟢 **Session Status Panel** — watch each app go from *Connecting* → *Debugger Attached* in real time
- 🔧 **Auto `launch.json`** — configs are merged in, not overwritten; your manual entries stay safe
- 💾 **Persistent Mapping** — org ↔ folder mapping is saved, no re-setup on restart
- ⚡ **Background Cache** — app list pre-fetched in the background so loading feels instant
- ⚙️ **Settings Panel** — control cache sync interval, trigger a manual sync, or log out

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

### 3 — Select your projects root folder

Point to the folder containing your client group folders:

```
~/Code/projects/
├── group-a/
│   └── my-service/
└── group-b/
    └── another-service/
```

### 4 — Pick a CF region and log in

Select your region from the grid (or enter a custom endpoint), then click **Login to Cloud Foundry**. Credentials are read from your environment — nothing to type.

### 5 — Map a CF org to a local folder

Select the org you want to work with and match it to its local folder. This is saved automatically — you only do it once.

### 6 — Select apps and start debugging

Search or scroll the app list, tick the services you want to debug, and hit **▶ Start Debug Sessions**.

The extension opens a background process per service, updates `launch.json`, and attaches the debugger automatically.

---

## 🛠️ Commands

| Command | Description |
|---|---|
| `CDS Debug: Reset Configuration` | Clears saved org mappings and root folder |

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
