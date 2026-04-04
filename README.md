# ⚡ CDS Debug

> Debug multiple SAP CAP services simultaneously — directly from VS Code.

[![Version](https://img.shields.io/badge/version-0.0.1-blue)](https://github.com/dongitran/cds-debug)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/vscode-%5E1.90.0-007ACC?logo=visual-studio-code)](https://code.visualstudio.com)

---

## 😩 The Problem

When working with SAP CAP on Cloud Foundry, debugging even two services at the same time means:

- Opening multiple terminals manually
- Running `cds watch` per service, remembering the right port each time
- Editing `launch.json` by hand every session
- No visibility into which CF apps are actually running

**CDS Debug** eliminates all of that.

---

## 🚀 What It Does

A sidebar panel connects to your Cloud Foundry environment, lists running apps, and with one click:

1. Starts each selected service in its own integrated terminal (`cds watch --inspect=<port>`)
2. Writes attach configurations into `.vscode/launch.json` automatically
3. Lets VS Code attach the debugger — no manual setup

---

## ✨ Features

- 🔐 **CF Login from VS Code** — authenticate against any CF region directly from the sidebar
- 🗺️ **Org → Folder Mapping** — map each CF org to its local project folder, saved across sessions
- 📋 **Live App List** — shows started apps at the top, stopped apps dimmed below
- ☑️ **Multi-select Debug** — tick any number of started apps and launch all debug sessions at once
- 🔧 **Auto launch.json** — merge-writes attach configs per service without touching your manual entries
- 🔢 **Incremental Ports** — each service gets its own inspect port starting from `9229`
- 💾 **Persistent Config** — your org mappings and root folder survive VS Code restarts

---

## 📋 Requirements

- **Node.js** ≥ 20
- **CF CLI** installed and available on `$PATH`
- Environment variables set:
  ```
  SAP_EMAIL=your@email.com
  SAP_PASSWORD=yourpassword
  ```

---

## 🏁 Getting Started

### 1 — Install the extension

Install from the `.vsix` file:

```
Extensions panel → ··· → Install from VSIX…
```

### 2 — Open the sidebar

Click the **⚡ CDS Debug** icon in the Activity Bar (left sidebar).

### 3 — Select your projects root folder

Point the extension to the folder that contains your client group folders, e.g.:

```
~/Code/projects/
├── group-a/
│   └── services/
└── group-b/
    └── services/
```

### 4 — Enter your CF API endpoint and log in

Type your Cloud Foundry API endpoint and click **Login to Cloud Foundry**.

```
https://api.cf.<region>.hana.ondemand.com
```

Any CF region is supported — `us10`, `eu10`, `eu20`, `ap10`, `ap11`, `br10`, `ca10`, etc.  
Credentials are read from `SAP_EMAIL` / `SAP_PASSWORD` environment variables — never stored.

### 5 — Map CF orgs to local folders

Each CF org in your account is listed. Use the dropdowns to match each org to its local client folder.  
The mapping is saved — you only do this once.

### 6 — Select apps and start debugging

Pick the apps you want to debug (only started apps are selectable), then click **▶ Start Debug Sessions**.

The extension will:
- Open a terminal per service running `npx cds watch --inspect=<port>`
- Update `.vscode/launch.json` with an attach config for each service

Hit **F5** in VS Code to attach to any of the launched configs.

---

## 🗂️ App → Folder Mapping

CF app names use hyphens, local repo folders use underscores — the extension converts automatically.  
Apps that cannot be resolved are reported as a warning; your other selections still launch normally.

---

## 📄 Launch Configuration Format

Each service gets an attach entry in `.vscode/launch.json`:

```json
{
  "name": "Debug: myapp-svc-one",
  "type": "node",
  "request": "attach",
  "address": "127.0.0.1",
  "port": 9229,
  "restart": true,
  "localRoot": "${workspaceFolder}/group-a/services/myapp_svc_one/gen/srv",
  "remoteRoot": "/myapp_svc_one/gen/srv",
  "sourceMaps": true,
  "outFiles": [
    "${workspaceFolder}/group-a/services/myapp_svc_one/gen/srv/**/*.js"
  ],
  "skipFiles": ["<node_internals>/**", "**/node_modules/**"]
}
```

Existing manual configs are preserved — only entries with matching names are replaced.

---

## 🛠️ Commands

| Command | Description |
|---|---|
| `CDS Debug: Reset Configuration` | Clears saved org mappings and root folder path |

---

## 👨‍💻 Development

```bash
pnpm install
pnpm build          # compile with esbuild
pnpm test           # run unit tests (Vitest)
pnpm test:coverage  # coverage report (≥ 80% threshold)
pnpm lint           # ESLint strict TypeChecked
pnpm typecheck      # tsc --noEmit
pnpm package        # build → cds-debug-x.x.x.vsix
```

Pre-commit hooks run ESLint, cspell, and typecheck automatically via Husky.

---

## 📜 License

[MIT](LICENSE)
