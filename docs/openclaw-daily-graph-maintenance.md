# OpenClaw Daily Graph Maintenance

Use this runbook when PAM is installed in an OpenClaw-style workspace and the
runtime supports scheduled agent jobs.

The maintenance job must keep the PAM graph useful as a compact, source-traced
knowledge map. It must not degrade into an installation acceptance checklist.
Acceptance criteria are useful during setup and audits, but daily maintenance is
about validating, scanning, and promoting safe graph updates.

## Scope

Default writable paths:

```text
memory/graph/catalog.json
memory/graph/nodes.jsonl
memory/graph/edges.jsonl
memory/graph/aliases.jsonl
memory/maintenance/
```

Do not rewrite OpenClaw-owned or project-owned sources by default, including:

```text
MEMORY.md
memory/**/*.md
compiled wiki pages
AGENTS.md
project-specific memory conventions
```

If a useful update requires a non-PAM-owned write, report it as blocked and ask
for explicit approval.

## Daily job flow

1. Read local policy first, then `memory/pam.version.json`,
   `memory/agent-memory/pam-runtime.md`, `memory/agent-memory/pam-openclaw.md`,
   and `memory/graph/catalog.json`.
2. Validate `memory/graph/*.jsonl`.
3. Read the latest PAM maintenance report to establish the previous state.
4. Do a bounded scan of recent durable memory since the previous run, usually
   the last 24-48 hours.
5. Promote only stable, useful, non-sensitive records into the graph:
   projects, systems, decisions, tasks, risks, blockers, packages,
   repositories, policies, and automations.
6. Upsert records with stable ids such as `project:*`, `system:*`,
   `decision:*`, `risk:*`, `blocker:*`, `task:*`, `package:*`, `repo:*`, and
   `automation:*`.
7. Keep every node and edge compact and source-traced.
8. Update `catalog.json` counts and health.
9. Validate again.
10. Write `memory/maintenance/pam-daily-maintenance-YYYY-MM-DD.md` with graph
    changes, highlights, skipped candidates, blockers, validation status, and next
    action.

## Highlights

Every scheduled report should include a short highlights section summarizing the
important memories found during the scan. Highlights are for the human reader,
not for schema bookkeeping.

Good highlights are:

- 3-7 bullets;
- public-safe and non-sensitive;
- focused on durable meaning: decisions, blockers, risks, project state,
  published artifacts, or changed operational posture;
- sourced by the same scanned memory used for graph promotion.

Avoid highlights that expose raw private messages, secrets, webhook values, full
paths to secret stores, or noisy implementation minutiae. If nothing meaningful
was found, say that directly and name the bounded scan window.

## Safety rules

- Do not store secrets, credentials, tokens, webhook URLs, cookies, private
  keys, raw private chat, or secret-store paths.
- Prefer source pointers over copied detail.
- Treat chronological logs and transcripts as source material, not graph content
  by default.
- In shared contexts, avoid private profile/preference details unless the user
  explicitly approves them.
- If validation fails, fix only PAM-owned files or roll back the PAM-owned
  change and report `BLOCKED`.

## Report format

Use a concise human-facing report. Example:

```text
PAM daily maintenance — YYYY-MM-DD HH:mm UTC
Status: 🟢 OK | 🟡 WARNING | 🔴 BLOCKED

Highlights:
- Approval policy was promoted as an active project memory.
- Chat ingestion remains blocked by platform access.
- A runtime security posture item remains a P1 risk.

Checks:
- 🟢 Graph validation — passed, 0 errors / 0 warnings.
- 🟢 Graph updates — added 3 nodes, 4 edges, 2 aliases.
- 🟡 Recent memory scan — skipped 2 private or unstable candidates.
- 🟢 Safety — wrote only PAM-owned paths; no secrets or raw chat stored.
- Next action: review `blocker:example` before tomorrow's run.
```

Do not make the daily report an acceptance-criteria-only checklist. Acceptance
criteria are secondary health evidence; real graph maintenance is the primary
job.
