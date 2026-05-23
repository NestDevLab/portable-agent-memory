---
description: PAM memory hygiene pass; refresh graph catalog and run audit. Read-mostly (only writes memory/graph/catalog.json).
allowed-tools:
  - mcp__pam__pam_version
  - mcp__pam__memory_state
  - mcp__pam__graph_stats
  - mcp__pam__graph_validate
  - mcp__pam__graph_reindex
  - mcp__pam__memory_audit
  - mcp__pam__maintenance_config
---

# /dream - PAM hygiene pass

Run a memory hygiene cycle for the current PAM workspace. This is the same routine that would run on a nightly cron, made available manually.

## What to do

Perform these steps in order and report results inline:

1. **Confirm workspace.** Call `mcp__pam__memory_state` and `mcp__pam__pam_version`. If no PAM workspace is detected in the current directory, stop and say so plainly; do not invent state.
2. **Validate integrity.** Call `mcp__pam__graph_validate` to check the JSONL sources. Capture any errors/warnings verbatim.
3. **Refresh graph catalog.** Call `mcp__pam__graph_reindex` (no `dryRun`) to rewrite `memory/graph/catalog.json` from the JSONL sources. This is the only mutation in a /dream run.
4. **Re-read catalog stats.** Call `mcp__pam__graph_stats` to capture the post-reindex `nodeCount` / `edgeCount` and confirm the rewrite landed.
5. **Audit memory.** Call `mcp__pam__memory_audit`. Capture every warning and error verbatim; do not paraphrase, do not filter.
6. **Cross-check config.** Call `mcp__pam__maintenance_config` to see which logs are managed and whether any thresholds are relevant to the warnings you saw.

## Output format

Produce a single concise report with these sections, in this order:

```
🧠 PAM dream report

Graph
  status: <valid|warning|invalid>
  nodes/edges: <N>/<M>
  catalog rewritten: <path or "no change">

Audit findings
  <bullet list of every warning/error; "none" if clean>

Recommended next step
  <one line: do nothing, run /pam:curator, run /pam:scribe, etc.>
```

## Hard constraints

- **No mutations** beyond the catalog refresh `graph_reindex` performs (a single rewrite of `memory/graph/catalog.json`).
- **Do not** invoke `mcp__pam__memory_propose_edit`, `mcp__pam__memory_append`, or any tool that writes to the logs. If the audit suggests changes are needed, name them in "Recommended next step". Do not perform them.
- **Do not** spawn other agents.
- If a tool call errors, report the error verbatim and continue with the remaining steps.
