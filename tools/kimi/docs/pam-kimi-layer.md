# PAM Kimi Code CLI Integration

PAM works with Kimi Code CLI via the Model Context Protocol (MCP). The integration is a thin config layer: Kimi speaks to the same `tools/pam-mcp-server.mjs` that Claude Code, Cursor, and Codex CLI use.

## Install

From the repo root (or any directory inside your PAM workspace):

```bash
# Dry-run (default): preview what will be written.
node tools/kimi/install-mcp.mjs

# Install into ~/.kimi/mcp.json
node tools/kimi/install-mcp.mjs --apply

# Overwrite an existing pam entry
node tools/kimi/install-mcp.mjs --apply --force
```

The installer resolves absolute paths for:
- the MCP server (`tools/pam-mcp-server.mjs`)
- your PAM workspace root

and writes them into `~/.kimi/mcp.json`. Because the paths are absolute, a later `git pull` in your PAM workspace updates the server code without requiring any reconfiguration.

## Verify

```bash
kimi mcp list
kimi mcp test pam
```

If the test prints tool names (`pam_version`, `memory_append`, `graph_query`, etc.), the integration is live.

## Uninstall

```bash
node tools/kimi/install-mcp.mjs --uninstall --apply
```

This removes the `mcpServers.pam` entry from `~/.kimi/mcp.json` and restores the backup.

## Ad-hoc usage (no global install)

If you prefer not to touch `~/.kimi/mcp.json`, create a project-local config:

```bash
kimi --mcp-config-file tools/kimi/mcp-config.json
```

A minimal project-local config looks like:

```json
{
  "mcpServers": {
    "pam": {
      "command": "node",
      "args": [
        "tools/pam-mcp-server.mjs"
      ]
    }
  }
}
```

## Updating PAM

Because the installer writes absolute paths, simply run:

```bash
git pull
```

in your PAM workspace. The MCP server binary and tool definitions update automatically. Kimi will use the latest version on its next session.

## What you get

The same 15 typed tools available to other MCP hosts:

- **Context**: `pam_version`, `memory_state`, `maintenance_config`
- **Reads**: `memory_list`, `memory_read`, `memory_search`
- **Graph**: `graph_query`, `graph_stats`, `graph_validate`, `graph_reindex`
- **Hygiene / Write**: `memory_audit`, `memory_propose_edit`, `memory_append`, `memory_apply_proposal`
- **Maintenance**: `maintenance_run`

## Requirements

- Kimi Code CLI (`kimi`) installed and on PATH
- Node.js 18+ (already required by PAM)
- A PAM workspace (`memory/pam.version.json` present)
