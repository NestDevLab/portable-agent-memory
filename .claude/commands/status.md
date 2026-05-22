---
description: Dump the current state of the PAM workspace (version, graph, proposals, session activity). Read-only.
allowed-tools:
  - mcp__pam__pam_version
  - mcp__pam__memory_state
  - mcp__pam__graph_stats
  - mcp__pam__maintenance_config
  - Bash(ls:*)
  - Bash(find:*)
  - Bash(cat:*)
  - Bash(jq:*)
---

# /pam-status - PAM workspace state

Print a one-shot status snapshot for the current PAM workspace. Read-only.

## What to do

1. Call `mcp__pam__pam_version` and `mcp__pam__memory_state`. If no PAM workspace is detected, say so and stop.
2. Call `mcp__pam__graph_stats` for live node/edge counts and health.
3. Call `mcp__pam__maintenance_config` to list managed logs and thresholds.
4. Count pending proposals: `ls memory/maintenance/proposals/*.json 2>/dev/null | wc -l`.
5. Report active session activity by reading any `memory/.session/*.json` files (these are per-session append counters written by the post-memory-append hook).

## Output format

```
🧠 PAM status

Version
  pamVersion: <x.y.z>
  memoryFormat: <format>

Graph
  status: <valid|warning|invalid>
  nodes/edges: <N>/<M>
  last validated: <ISO date>

Logs (managed)
  <path> - <size, last modified>
  ...

Proposals
  pending: <N>
  <list filenames if any>

Sessions
  active counters: <list of session_id → appends, most recent first>
```

## Hard constraints

- **Read-only.** Do not call `graph_validate`, `memory_append`, `memory_propose_edit`, `memory_apply_proposal`, or any other write tool.
- Keep the report tight (this is meant to be glanceable).
