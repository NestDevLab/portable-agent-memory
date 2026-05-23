# curator subagent

A Claude Code subagent that audits the local Portable Agent Memory workspace
and proposes hygiene fixes as JSON artifacts. The curator never mutates
durable memory; the human reviews proposals and decides what lands.

## Install

Install the PAM plugin (ships the MCP server, agents, slash commands, and hooks
in one package):

```
/plugin install NestDevLab/portable-agent-memory@github
```

The curator agent becomes available as `/pam:curator`. Run `/agents` to
confirm it appears in the list.

## What it does

When invoked (`/pam:curator` in Claude Code), the curator:

1. Runs a boot sequence (`pam_version`, `memory_state`, `graph_validate`,
   `graph_stats`, `maintenance_config`). Aborts on any failure.
2. Runs `memory_audit` over the workspace.
3. For each finding, decides one of: `propose-edit` (record a JSON proposal),
   `surface-only` (report, no action), or `defer` (evidence too thin).
4. Records proposals via `memory_propose_edit`, which writes
   `memory/maintenance/proposals/<id>.json` and never touches the target file.
5. Returns a structured "Findings" report.

## What it does not do

By design, the curator cannot:

- write to any path outside `memory/maintenance/proposals/`;
- run `maintenance_run` or `graph_reindex` (not in its tool whitelist);
- propose edits to `AGENTS.md`, `CLAUDE.md`, `memory/agent-memory/`, or
  `memory/sources/` (protected paths, enforced by the MCP server);
- answer general questions about memory content (it's a hygiene agent, not a
  Q&A agent);
- claim a change was applied (only "proposed", "recorded as", "would suggest").

Safety is enforced by the tool whitelist in the subagent's frontmatter and by
the MCP server's protected-path checks, not by prompt discipline alone.

## When to invoke

- After a long working session where new knowledge entries piled up.
- Before a release, to catch link rot and stale wiki pages.
- Periodically (weekly or monthly) when the workspace grows large.

Skip it for one-shot tasks; running an audit on a small, freshly-curated
workspace produces no findings and wastes a turn.

## Applying proposals

The curator only proposes. To apply a proposal:

1. Read the proposal JSON under `memory/maintenance/proposals/`.
2. Verify the rationale and the `before`/`after` content.
3. Apply via the `memory_apply_proposal` MCP tool, which re-validates path
   safety, re-applies the diff against current content, rejects drift, and
   archives the artifact as `<id>.applied.json`.

Applied proposals are not auto-rotated. Delete the `.applied.json` archives
once they're no longer useful as audit trail.

## Output shape

```
# Curator run - 2026-05-21

## Summary
- workspace state: graph-v1
- graph: 11 nodes / 11 edges / 10 aliases
- findings: 4 (0/2/2)
- proposals recorded: 1 (memory/maintenance/proposals/proposal-2026-05-21T...-abc123.json)

## Findings
### audit-2026-05-21-0001-link-rot - link-rot (warning)
- summary: Broken markdown link to ../old-runbook.md
- evidence: ../old-runbook.md
- disposition: propose-edit
- justification: Target file is renamed; replacement is deterministic.
- proposal: memory/maintenance/proposals/proposal-2026-05-21T....json

### audit-2026-05-21-0002-orphan-source - orphan-source (info)
- summary: Source file is not referenced from the graph.
- evidence: memory/sources/draft-2025-q4.md
- disposition: surface-only
- justification: Deletion is judgmental; ask the human whether to archive.
```

## Out of scope (for now)

A future PAM release may add:

- `pam-query`: a Q&A agent that resolves "what did we decide about X" with
  graph citations;
- `pam-bootstrap`: an installer agent that audits a new repo and seeds PAM.
