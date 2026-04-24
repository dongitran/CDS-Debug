---
description: Security rules for CDS Debug — no secrets in code, safe shell execution, credential handling, no eval
---
# Security Guardrails

> [!IMPORTANT]
> CDS Debug handles SAP credentials (email/password), Cloud Foundry tokens, and executes shell commands (CF CLI, ssh tunnels). The extension runs with full user privileges on the developer's machine. Security mistakes can leak production CF credentials or enable arbitrary command execution.

## 1. Never Commit Secrets or Credentials

- **NEVER** put API keys, passwords, connection strings, tokens, or credentials directly in source code — not even in comments or example values.
- All secrets MUST come from environment variables or VS Code SecretStorage API.
- CI secrets are stored in GitHub Actions secrets (managed via Bitwarden sync in `.agents/config/secrets.yml`), never in the repository.
- If you accidentally discover a secret in a diff or staged file, **STOP immediately** and alert the user before committing.

## 2. Safe Shell Command Execution

- **ALWAYS** use `child_process.execFile()` (not `exec()`) when running CF CLI or other shell commands. `execFile` does not spawn a shell, preventing injection.
- **NEVER** interpolate user input directly into shell command strings. Use argument arrays.
- Correct: `execFile('cf', ['login', '-u', email, '-p', password])`
- Forbidden: `` exec(`cf login -u ${email} -p ${password}`) ``

## 3. No `eval()` or `new Function()` with User Input

- **NEVER** use `eval()`, `new Function()`, `vm.runInThisContext()`, or any dynamic code execution with user-supplied data.
- These represent critical Remote Code Execution (RCE) vulnerabilities. There is no safe way to use them with untrusted input.
- If dynamic evaluation seems needed, reconsider the architecture and propose an alternative to the user.

## 4. Credential Handling via VS Code SecretStorage

- **ALWAYS** use the VS Code `SecretStorage` API for persisting credentials. Never write credentials to `globalState`, `workspaceState`, or disk files.
- Clear credentials from memory as soon as they are no longer needed.
- When reading credentials from environment variables (`SAP_EMAIL`, `SAP_PASSWORD`), never log their values — log only whether they were found.

## 5. Never Log Sensitive Data

- **NEVER** log passwords, API keys, tokens, connection strings, or PII (personal identifiable information).
- The extension logger (`src/core/logger.ts`) must never receive credential values.
- When in doubt about whether a field is sensitive, do not log it.
