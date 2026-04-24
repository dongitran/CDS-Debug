# .agents/config

## secrets.yml

Defines mapping between GitHub Secrets/Variables and Bitwarden items.

**Format:**
```yaml
repo: <owner>/<repo-name>
environment: null  # or environment name
type: secret       # or "variable"

secrets:
  # <Description of what this secret is used for and which project/service it belongs to>
  # Bitwarden: <Folder path in Bitwarden>/
  - name: GITHUB_SECRET_NAME    # Name on GitHub
    bitwarden: BITWARDEN_ITEM   # Item name in Bitwarden
```

> Each secret should have 2 comment lines above it:
> - Line 1: describe the purpose and usage context
> - Line 2: folder path in Bitwarden for easy lookup

**Purpose:** Enable automated secret sync from Bitwarden → GitHub using MCP tools.
