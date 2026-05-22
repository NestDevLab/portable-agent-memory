# PAM Claude Code integration

PAM ships as a Claude Code plugin that bundles the MCP server, two reference
subagents (`curator`, `scribe`), slash commands, and lifecycle hooks. The status
line is the one piece Claude Code does not allow plugins to own, so it has its
own small installer.

## Plugin (recommended)

```text
/plugin install NestDevLab/portable-agent-memory@github
```

This loads:

- **MCP server** `pam` (provides `pam_version`, `memory_state`, `graph_*`, `memory_*`, `maintenance_*` tools).
- **Subagents**: `/pam:curator` (audit + propose) and `/pam:scribe` (append durable knowledge at session end).
- **Slash commands**: `/pam:dream`, `/pam:status`, `/pam:explain`, `/pam:enable-status-line`.
- **Hooks**:
  - `SessionStart`: checks catalog freshness and pending proposals on launch; prints a short nudge when something needs attention. `PAM_STALE_DAYS` overrides the default 7-day threshold.
  - `PostToolUse` matching `mcp__pam__memory_append`: bumps a per-session counter at `memory/.session/<session_id>.json`. Never blocks the tool call.

After install, restart Claude Code so it picks up the plugin. Run `/agents` to
confirm `curator` and `scribe` are listed under `pam`.

## Status line (separate)

Claude Code requires the `statusLine` setting to live outside plugins, so PAM
ships a small installer that drops a statusline script into
`<claude-dir>/pam-layer/statusline/pam-statusline.sh` and wires it into
`<claude-dir>/settings.json`.

```bash
# Dry-run (default): prints the plan without writing anything.
node tools/install-pam-statusline.mjs

# Install into ~/.claude/ (default scope: user).
node tools/install-pam-statusline.mjs --apply

# Install into <cwd>/.claude/ instead.
node tools/install-pam-statusline.mjs --scope project --apply

# Install into a custom directory.
node tools/install-pam-statusline.mjs --target /path/to/repo --apply
```

The status line is silent outside PAM workspaces, so it is safe to install
user-wide. Inside a workspace it prints:

```
[Opus] my-project · main · 12% ctx
🧠 PAM 0.4.0 · ✅ 11n/11e · 📋 0 · 💤 2d · ✍️ 3
```

- `✅ 11n/11e`: graph status with node/edge counts from `memory/graph/catalog.json`. Yellow/red on warning/invalid.
- `📋 N`: pending curator proposals in `memory/maintenance/proposals/`. Yellow when N > 0.
- `💤 Nd`: age of the last graph validation. Yellow when older than ~6 days.
- `✍️ N`: `memory_append` calls this session (written by the plugin's post-memory-append hook).

### Uninstall the status line

```bash
node tools/install-pam-statusline.mjs --uninstall            # dry-run
node tools/install-pam-statusline.mjs --uninstall --apply    # remove files; clean settings.json
```

Uninstall only touches entries whose `command` path lives under the layer dir,
so it won't disturb unrelated `statusLine` settings.

## Requirements

- `jq` on PATH. The scripts degrade gracefully if it's missing (statusline reads `?` for unknown counts; hooks exit silently), but you'll lose most of the PAM signal.
- A PAM workspace (a directory containing `memory/pam.version.json`). The statusline auto-detects from `workspace.current_dir` then `workspace.project_dir`; the hooks walk up from `cwd` looking for `memory/pam.version.json`.

## Plugin layout

```
.claude-plugin/plugin.json          # plugin manifest
.mcp.json                           # bundled MCP server entry
.claude/agents/                     # curator.md, scribe.md
.claude/commands/                   # dream.md, status.md, explain.md, enable-status-line.md
hooks/                              # session-start.sh, post-memory-append.sh, hooks.json
tools/pam-mcp-server.mjs            # the MCP server itself
```

The repo also adds `memory/.session/` to `.gitignore` since the post-memory-append hook writes per-session counters there.

## Customization

- **Statusline thresholds and glyphs** - edit `pam-statusline.sh` (in `~/.claude/pam-layer/statusline/` after install). The script is short and free of dependencies on PAM internals.
- **SessionStart staleness threshold** - set `PAM_STALE_DAYS` in your shell environment before launching Claude Code (default: 7).
- **Multiple PAM workspaces** - the hooks find the PAM root by walking up from `cwd`. Switching directories inside a single Claude Code session works as long as both directories are PAM workspaces.

## Other MCP hosts

The plugin format is Claude Code-specific. For Cursor, Codex, OpenClaw, and
others, register the stdio MCP server (`tools/pam-mcp-server.mjs`) by hand.
See [docs/mcp-server.md](mcp-server.md) for host-specific snippets.

## Relationship to the MCP server and subagents

The plugin is the canonical Claude Code distribution of PAM. The MCP server
remains the only component that writes to durable memory; subagents and slash
commands invoke MCP tools and never bypass them. The status line is purely
advisory; it reads files but never mutates them.
