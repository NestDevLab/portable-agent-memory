# Portable Agent Memory

Give any AI coding agent a durable memory it can read, maintain, and improve.

Portable Agent Memory, or PAM, is a markdown-first protocol for turning an
ordinary repository into an agent-readable memory workspace. It helps agents
preserve decisions, facts, context, source notes, summaries, and follow-ups
without depending on one vendor, runtime, database, or chat history.

The goal is simple: when a new agent opens the repo tomorrow, it should know
where to look, what changed, what is trusted, what is uncertain, and how to keep
the memory healthy.

## Why This Exists

Most AI work disappears into chat history. The next session starts from a vague
summary, stale assumptions, or a full reread of the repository.

PAM gives agents a durable place to put what matters:

- decisions and rationale;
- project facts and working assumptions;
- user or team preferences;
- troubleshooting discoveries;
- source summaries;
- open questions;
- chronological work history;
- generated wiki pages and indexes;
- maintenance reports.

It is not a SaaS product, a vector database, or a new agent framework. It is a
portable contract plus a starter implementation that works with plain files.

## What Is In This Repository

The important pieces are:

- [memory/agent-memory/pam.md](memory/agent-memory/pam.md): the Portable Agent
  Memory constitution. This is the protocol agents should follow.
- [memory/agent-memory/llm-wiki.md](memory/agent-memory/llm-wiki.md): the
  persistent wiki pattern for turning raw material into curated pages.
- [AGENT_BOOTSTRAP.md](AGENT_BOOTSTRAP.md): copy/paste instructions you can give
  to Codex, Claude Code, Cursor, OpenCode, OpenClaw, or another agent.
- [memory/index.md](memory/index.md): starter memory index.
- [memory/conversation-log.md](memory/conversation-log.md): starter session log.
- [memory/knowledge-log.md](memory/knowledge-log.md): starter durable facts log.
- [tools/memory-maintenance.mjs](tools/memory-maintenance.mjs): optional
  maintenance CLI for rotating logs, rebuilding archive indexes, and refreshing
  summaries.

## Who It Is For

Use PAM when:

- your AI sessions need continuity across days or machines;
- several agents or tools touch the same project;
- you want memory that survives model, vendor, and product changes;
- your repository has recurring work where context matters;
- you need a lightweight alternative before adopting a database or RAG stack;
- you want agents to build and maintain a local wiki over time.

## The Core Idea

PAM separates memory into three layers:

1. Raw sources: original material that should be preserved.
2. Curated memory: facts, decisions, procedures, summaries, and wiki pages.
3. Maintenance: periodic checks that keep memory searchable, compact, and
   current.

The exact folder structure can change. The contract matters more than the
implementation. An agent should be able to read `pam.md`, inspect the current
repository, and create or adapt the memory layout itself.

## Quick Start For Humans

Clone this repository or copy the `memory/agent-memory/` folder into your own
project.

Then tell your agent:

```text
Read memory/agent-memory/pam.md and memory/agent-memory/llm-wiki.md.
Create or adapt a Portable Agent Memory structure for this repository.
Do not assume this repo already follows the examples.
Inspect the project first, then create the smallest useful memory layout.
Keep raw sources preserved, create a searchable index, add a conversation log,
add a knowledge log, and write clear instructions for future agents.
Do not store secrets, credentials, private tokens, cookies, or unnecessary raw
private messages.
```

That is the preferred workflow: let the agent adapt PAM to the repo instead of
forcing every project into one rigid template.

## Copy/Paste Agent Bootstrap

Use this prompt in any agent-capable environment:

```text
You are setting up Portable Agent Memory for this repository.

1. Read memory/agent-memory/pam.md and memory/agent-memory/llm-wiki.md if they
   already exist. If they do not exist, create them from the Portable Agent
   Memory project.
2. Inspect the repository structure and identify where durable memory should
   live.
3. Create a minimal memory workspace with:
   - a top-level memory index;
   - a chronological conversation or work log;
   - a knowledge log for durable facts, assumptions, and open questions;
   - a place for raw sources;
   - instructions for future agents.
4. Keep the structure simple and project-appropriate. Do not add a database,
   vector store, cron job, or large framework unless the repository needs it.
5. Mark confirmed facts, assumptions, open questions, and obsolete knowledge
   clearly.
6. Add a short session entry describing what you created and how future agents
   should continue.
7. Do not store secrets, credentials, cookies, private keys, or raw private
   communications unless the user explicitly approves and the repository is
   private.
```

For more variants, see [AGENT_BOOTSTRAP.md](AGENT_BOOTSTRAP.md).

## Optional Maintenance Tool

This repository includes a maintenance CLI, but PAM does not require it.

Use the tool when your markdown logs grow large or when you want scheduled
archive/index/report generation.

Requirements:

- Node.js 20 or newer.
- `npm`.
- Optional: Codex CLI for the bounded synthesis step.
- Optional: cron for scheduled local runs.

Commands:

```bash
npm test
npm run memory:maintain:dry-run
npm run memory:maintain
npm run memory:rotate
npm run memory:index
npm run memory:codex
npm run memory:cron:install
```

The deterministic rotation and archive-index steps do not require Codex. The
full `memory:maintain` command runs deterministic maintenance first, then an
optional bounded Codex synthesis pass.

## Maintenance Safety Model

The maintenance tool is conservative:

- archived entry bodies are copied unchanged;
- archive files are append-only;
- dry-run mode reports planned moves before editing;
- Codex runs in a temporary workspace;
- Codex copy-back is restricted to allowlisted paths;
- deletions from the temporary workspace are rejected.

Always review generated diffs before committing them.

## Configuration

Edit [tools/memory-maintenance.config.json](tools/memory-maintenance.config.json).

Common fields:

- `managedLogs`: markdown logs to maintain.
- `retentionDays`: archive dated entries older than this many days.
- `activeEntryLimit`: maximum dated entries to keep in an active log.
- `archiveRoot`: where archive slices are written.
- `summariesRoot`: where summaries may be generated.
- `maintenanceRoot`: where reports and run manifests are written.
- `workspace.indexPath`: the top-level memory index.
- `workspace.policyPaths`: local instruction files agents should respect.
- `protectedPaths`: files copied into the temp workspace but not writable by
  synthesis.

## Repository Layout

```text
memory/
  agent-memory/
    llm-wiki.md
    pam.md
  archive/
  maintenance/
  sources/
  summaries/
tools/
  memory-maintenance.mjs
  memory-maintenance.config.json
  run-memory-maintenance-nightly.sh
  install-memory-maintenance-cron.sh
```

This layout is a starter, not a law. If another structure better fits your
project, instruct the agent to adapt the contract while preserving the outcomes.

## Privacy

Do not commit secrets, credentials, cookies, tokens, private keys, or raw
confidential conversations into public repositories.

For public projects, keep examples generic. For private projects, still prefer
summaries over raw sensitive content.

## Project Status

PAM is intentionally small. The current public implementation is a practical
markdown starter kit plus a maintenance tool extracted from real day-to-day
agent work.

The next useful improvements are better templates, more bootstrap prompts for
different agents, and examples showing how PAM looks inside existing projects.
