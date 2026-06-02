# scribe subagent

A Claude Code subagent that records new durable knowledge into PAM logs at
session end. The scribe is append-only; it never modifies existing entries and
never applies curator proposals.

## Install

Install the PAM plugin (ships the MCP server, agents, slash commands, and hooks
in one package):

```
/plugin install NestDevLab/portable-agent-memory@github
```

The scribe agent becomes available as `/pam:scribe`. Run `/agents` to
confirm it appears in the list.

## What it does

When invoked (`/pam:scribe` in Claude Code, typically at session
closeout), the scribe:

1. Runs a short boot sequence (`pam_version`, `memory_state`,
   `maintenance_config`).
2. Reads the conversation context and identifies candidates worth recording
   (decisions, facts, preferences, troubleshooting, architecture notes,
   timelines, glossary entries, unresolved questions, known conflicts).
3. For each candidate, calls `memory_search` to check for an existing entry.
   Skips duplicates.
4. Calls `memory_append` with the appropriate log
   (`knowledge-log` for durable facts, `conversation-log` for ephemeral
   session summaries).
5. Returns a structured Recorded / Skipped / Surfaced report.

## What it does not do

By design, the scribe cannot:

- write outside `config.managedLogs` (enforced by the MCP server);
- modify existing entries (no `memory_propose_edit`, no `memory_apply_proposal`
  in its whitelist);
- run hygiene audits or maintenance;
- claim a change was applied that wasn't recorded;
- copy sensitive material verbatim (prompt contract requires summarization).

Safety is enforced by the tool whitelist in the subagent's frontmatter and by
`memory_append`'s managed-log allowlist, not by prompt discipline alone.

## When to invoke

- At session end, when the conversation produced facts, decisions, or
  preferences worth preserving across sessions.
- After resolving a tricky bug, to capture the cause and fix.
- After making an architectural decision, to record the rationale.

Skip it for purely exploratory or read-only sessions that didn't change your
understanding of the project.

## Output shape

```
# Scribe run - 2026-05-21

## Recorded
- knowledge-log/## 2026-05-21 - Worker retry policy - 5 retries per upstream timeout (after deadlock analysis).
- conversation-log/## 2026-05-21 - PAM scribe rollout - designed scribe, recorded curator proposals.

## Skipped (already recorded)
- ECS deploy procedure - found existing entry: memory/knowledge-log.md:## 2026-03-12 - ECS deploy procedure.

## Surfaced (for human or curator)
- "Worker retry budget" claim conflicts with 2026-03-04 knowledge entry; recommend a curator review.
```

## How it pairs with the curator

- **Scribe** (this agent) adds new entries.
- **Curator** (`/pam:curator`) audits existing entries and proposes fixes.
- **Apply step** (human + `memory_apply_proposal`) lands curator fixes.

Run scribe at session end; run curator weekly or before a release.

## Out of scope (for now)

- Automatic invocation via Claude Code hooks (manual `/pam:scribe` only).
- Writing to arbitrary paths outside `config.managedLogs` (use
  `memory_propose_edit` for that, via the curator).
- Recording graph nodes/edges/aliases (use curator proposals against the JSONL
  files).
