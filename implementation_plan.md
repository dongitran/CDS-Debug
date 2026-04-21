# Implementation Plan: Global User Setting Fallback for CAP Debug Config

## Goal

Allow the extension to read a shared VS Code user setting before falling back to workspace file-based config.

Required precedence:

1. per-service `cap-debug-config.json`
2. VS Code user setting contributed by this extension
3. workspace `.vscode/cap-debug-config.json`
4. existing built-in defaults / interactive fallback behavior

The new user setting must accept the same JSON shape currently used by `cap-debug-config.json`, so users can stop copying the same config into every workspace.

## Important Clarification

The request text mentions `cds-debug-config.json`, but the current codebase consistently uses `cap-debug-config.json`.

Reviewed evidence:

- `src/core/launchConfigurator.ts`
- `src/types/index.ts`
- `src/webview/webviewRenderers.ts`
- `test/core/launchConfigurator.test.ts`

I will implement the new behavior against the actual file format already shipped in this repo: `cap-debug-config.json`.

## Research Summary

### Current runtime behavior

1. `src/core/launchConfigurator.ts`
   - `readCapDebugConfig(folderPath)` reads `folderPath/cap-debug-config.json`.
   - `generateLaunchConfigurations()` reads per-service config and only uses workspace fallback for `remoteRoot`.
   - `mergeLaunchJson()` currently loads workspace fallback from `.vscode/cap-debug-config.json`.

2. `src/webview/debugPanel.ts`
   - branch prep reads workspace fallback separately with `readCapDebugConfig(join(workspaceRoot, '.vscode'))`.
   - `resolveTargetBranches()` uses:
     - per-app `branch`
     - workspace `orgBranchMap`
     - per-app `orgBranchMap`
     - QuickPick

3. `src/types/index.ts`
   - `CapDebugConfig` supports:
     - `remoteRoot?: string`
     - `branch?: string`
     - `orgBranchMap?: Record<string, string>`

### Testing surface today

1. `test/core/launchConfigurator.test.ts`
   - covers file parsing, launch config generation, and `mergeLaunchJson()`
   - does not cover VS Code settings precedence

2. `e2e/tests/extension-smoke.spec.ts`
   - has a real VS Code harness via `--user-data-dir`
   - currently does not write user `settings.json`
   - already has filesystem-driven tests around `launch.json`, so this harness can be extended for the new setting

### VS Code capability research

From the official VS Code docs:

1. Extensions can contribute settings in `package.json` and read them via `workspace.getConfiguration()`.
2. Settings can use `scope`; `application` scope is user-only, which matches the requested “shared for all workspaces” behavior.
3. `WorkspaceConfiguration.get()` returns the effective merged value.
4. For `object` settings, VS Code merges values across default, global, workspace, and folder scopes.
5. `WorkspaceConfiguration.inspect()` exposes `globalValue` and `workspaceValue` separately.

Design implication:

- I should not use the merged result from `get()` for this feature, because merged object settings would allow workspace settings to override user settings.
- To honor the requested behavior exactly, I need to read the leaf setting with `inspect()` and use `globalValue` first. Only when no user value exists should the code fall back to `.vscode/cap-debug-config.json`.

## User Journeys

1. As a user, I want to define one shared CAP debug config in VS Code user settings, so I do not need to copy the same file into every workspace.
2. As a user, I want per-service `cap-debug-config.json` to keep taking priority, so project-specific overrides still work.
3. As a user, I want existing workspace `.vscode/cap-debug-config.json` files to keep working when no user setting is configured, so the change is backward-compatible.
4. As a user, I want invalid user setting data to fail safely, so the extension does not crash and still falls back to workspace behavior.

## Proposed Design

### New contributed setting

Add one extension setting in `package.json`:

- key: `cdsDebug.sharedCapDebugConfig`
- type: `object`
- scope: `application`
- default: `null`

Schema:

- `remoteRoot`: string
- `branch`: string
- `orgBranchMap`: object with string values
- `additionalProperties: false`

Reasoning:

- `application` scope prevents workspace JSON settings from competing with the intended global setting.
- `null` default makes “not configured” explicit.
- Using one object keeps parity with `cap-debug-config.json`.

### Shared config resolution module

Create one shared resolver for CAP debug config sources instead of repeating precedence logic in multiple places.

Responsibility:

- parse/normalize raw config objects
- read file-based config safely
- read the user setting from VS Code safely
- resolve fallback precedence for:
  - launch `remoteRoot`
  - branch prep workspace defaults

Expected exported helpers:

1. a safe normalizer for unknown config input
2. a file reader for `cap-debug-config.json`
3. a user-setting reader using `workspace.getConfiguration('cdsDebug').inspect('sharedCapDebugConfig')`
4. a workspace-default resolver returning:
   - user setting when configured and valid
   - otherwise workspace `.vscode/cap-debug-config.json`

I expect this to live in a separate module because it becomes a distinct shared responsibility used by both `launchConfigurator` and `debugPanel`.

## Files To Change

### 1. `package.json`

Why:

- contribute the new VS Code user setting
- expose schema and description in Settings UI

How:

- add `cdsDebug.sharedCapDebugConfig`
- make description explicit about precedence:
  - used before workspace `.vscode/cap-debug-config.json`
  - per-service `cap-debug-config.json` still wins

### 2. `src/types/index.ts`

Why:

- keep the config shape reusable and explicit

How:

- keep `CapDebugConfig` as the shared shape
- add a small type only if needed for normalized setting inspection; avoid unnecessary abstraction

### 3. `src/core/launchConfigurator.ts`

Why:

- `mergeLaunchJson()` and `generateLaunchConfigurations()` currently depend on workspace file fallback

How:

- move raw config parsing out if needed
- switch workspace fallback loading to the shared resolver
- preserve existing precedence:
  - app file `remoteRoot`
  - resolved shared/workspace fallback `remoteRoot`

### 4. `src/webview/debugPanel.ts`

Why:

- branch prep currently reads `.vscode/cap-debug-config.json` directly

How:

- replace direct workspace-file read with the shared resolver
- keep branch precedence intact:
  - per-app `branch`
  - resolved fallback `orgBranchMap`
  - per-app `orgBranchMap`
  - QuickPick

### 5. New core test file for config resolution

Why:

- current tests do not isolate setting inspection / parsing / precedence

How:

- add focused unit tests for:
  - valid user setting object
  - invalid user setting object
  - absent user setting
  - user setting chosen over workspace file
  - workspace file used when user setting absent
  - malformed workspace file ignored safely

### 6. `test/core/launchConfigurator.test.ts`

Why:

- existing integration coverage around launch generation should assert the new fallback precedence

How:

- add tests proving:
  - app file overrides user setting fallback
  - user setting fallback overrides workspace file
  - workspace file still works when user setting absent
  - invalid user setting falls back to workspace file

### 7. `e2e/tests/extension-smoke.spec.ts`

Why:

- user explicitly asked for E2E coverage with edge cases
- this repo already has a real VS Code harness suitable for testing actual user settings

How:

- extend the session setup helper so it can pre-write `User/settings.json` under `--user-data-dir`
- create workspace fixtures with service folders and `.vscode` files using neutral names only
- add E2E cases that verify actual extension behavior through resulting `launch.json`

## E2E Scope

### E2E case 1: user setting overrides workspace fallback

Setup:

- workspace has `.vscode/cap-debug-config.json` with one `remoteRoot`
- user settings define `cdsDebug.sharedCapDebugConfig.remoteRoot` with a different value
- service folder has no local `cap-debug-config.json`

Assert:

- generated managed launch config uses the user-setting `remoteRoot`

### E2E case 2: workspace fallback still works when user setting absent

Setup:

- workspace file exists
- no user setting
- service folder has no config file

Assert:

- generated managed launch config uses workspace `remoteRoot`

### E2E case 3: per-service file still overrides both

Setup:

- user setting exists
- workspace file exists
- service folder has its own `cap-debug-config.json`

Assert:

- generated managed launch config uses per-service `remoteRoot`

### E2E case 4: malformed user setting fails safe

Setup:

- user setting has wrong shape, e.g. `remoteRoot: 123`
- workspace file exists with valid `remoteRoot`

Assert:

- extension does not crash
- generated managed launch config falls back to workspace file

## Test Data Rules

Per request, use neutral names only.

Examples to use in tests:

- `demo-service-a`
- `demo-service-b`
- `sample-group`
- `sample-branch`
- `sample-root`

Do not introduce special names or personal project names.

## Implementation Order

1. write / update this implementation plan
2. add failing unit tests for config resolution and launch precedence
3. add failing E2E helper + tests for user settings
4. implement shared resolver
5. wire `launchConfigurator` and `debugPanel` to the resolver
6. add the contributed setting schema in `package.json`
7. run verification and fix any regressions
8. update docs only if the behavior is user-facing enough to require README coverage

## Verification Commands

Required:

1. `pnpm run build`
2. `pnpm run typecheck`
3. `pnpm run lint`
4. `pnpm run cspell`
5. `pnpm run test`
6. `pnpm run test:coverage`
7. `pnpm --dir e2e test`

If any command fails, inspect the exact failing file or output and fix the root cause before moving on.

## Risks To Watch

1. Using `get()` instead of `inspect()` would accidentally read merged workspace settings and violate the requested precedence.
2. Adding workspace-scoped configuration in `package.json` would blur the separation between shared user config and workspace fallback file.
3. Invalid config objects must never throw into activation or debug-start paths.
4. E2E must not depend on special names or brittle CSS selectors.
5. The feature should remain backward-compatible for users who only use `.vscode/cap-debug-config.json` today.
