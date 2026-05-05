# Agent Bootstrap

Use these prompts to ask an AI agent to create or adapt a Portable Agent Memory
workspace.

The agent should not blindly copy the example structure. It should inspect the
repository, choose the smallest useful memory layout, and explain its choices.

## Minimal Setup Prompt

```text
Set up Portable Agent Memory for this repository.

Read memory/agent-memory/pam.md and memory/agent-memory/llm-wiki.md if present.
If they are missing, create equivalent files from the Portable Agent Memory
project.

Inspect the repository first. Then create the smallest useful durable memory
structure for this project.

Required outcomes:
- a memory index future agents can start from;
- a chronological work or conversation log;
- a knowledge log for durable facts, assumptions, decisions, and open questions;
- a place for raw sources or references;
- instructions that tell future agents how to read, update, and maintain memory.

Do not add unnecessary infrastructure. Do not add cron, vector search, SQLite,
MCP, or a large wiki unless this repository actually needs it.

Do not store secrets, credentials, cookies, private keys, or unnecessary raw
private communications.

After setup, add a short entry explaining what was created, what assumptions
were made, and what future agents should do next.
```

## Existing Project Audit Prompt

```text
Audit this repository for Portable Agent Memory readiness.

Read the repository instructions and inspect existing documentation, logs,
notes, and generated summaries.

Report:
- what already acts as durable memory;
- what is missing;
- what is duplicated or stale;
- where raw sources should live;
- what future agents should read first;
- whether a maintenance tool is useful yet.

Then propose the smallest safe change set to make the repository PAM-compatible.
Do not modify files until the plan is clear.
```

## Maintenance Setup Prompt

```text
Add the Portable Agent Memory maintenance tool to this repository only if the
current memory logs are large enough or recurring enough to justify it.

Before editing:
- identify which markdown logs should be managed;
- define retention and active-entry limits;
- identify archive, summary, and maintenance output paths;
- identify protected paths that the synthesis pass must never modify.

Then add or adapt:
- tools/memory-maintenance.mjs;
- tools/memory-maintenance.config.json;
- package scripts;
- optional cron runner and installer;
- tests or a dry-run verification command.

Run a dry-run before any real maintenance.
```

## Ongoing Session Closeout Prompt

```text
Close out this session using Portable Agent Memory.

Update the memory workspace with:
- what the user asked;
- what was checked or changed;
- current status;
- confirmed facts;
- assumptions;
- blockers;
- next likely actions;
- useful file paths or URLs.

Keep the entry concise. Summarize sensitive material rather than copying it.
Promote reusable procedures into the appropriate memory or wiki page.
```
