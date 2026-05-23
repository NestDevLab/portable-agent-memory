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

If this repository is an OpenClaw workspace or contains OpenClaw-style memory
files such as MEMORY.md, memory/**/*.md, memory-wiki files, or OpenClaw-specific
agent instructions, also read memory/agent-memory/pam-openclaw.md. Map PAM
concepts onto existing OpenClaw/project memory before creating new PAM files.

Inspect the repository first. Then create the smallest useful durable memory
structure for this project.

Required outcomes:
- a memory index future agents can start from;
- a chronological work or conversation log;
- a knowledge log for durable facts, assumptions, decisions, and open questions;
- a place for raw sources or references;
- instructions that tell future agents how to read, update, and maintain memory.

Also update the local agent instruction file, such as AGENTS.md, CLAUDE.md,
GEMINI.md, or an equivalent policy file, with the PAM read/update path.

Do not add unnecessary infrastructure. Do not add a scheduler, vector search,
SQLite, MCP, or a large wiki unless this repository actually needs it.

Do not store secrets, credentials, cookies, private keys, or unnecessary raw
private communications.

After setup, add a short entry explaining what was created, what assumptions
were made, and what future agents should do next.

Before finishing, enforce the PAM installation acceptance criteria:
1. inspected existing memory/raw sources;
2. PAM read path exists;
3. searchable index exists;
4. local agent instructions were updated;
5. source traceability is preserved;
6. safety boundaries are documented;
7. project-specific conventions were preserved;
8. validation was run when tooling exists;
9. final response reports every criterion with colored status markers: 🟢 PASS, 🟡 PARTIAL, 🔵 DEFERRED, 🔴 BLOCKED, or ⚪ N/A.

Do not claim PAM is fully integrated unless every required criterion passes or a non-required criterion is explicitly deferred/opted out.
```

## Everyday Runtime Prompt

```text
Use Portable Agent Memory for this repository.

For normal memory lookup, do not start by reading the full PAM contract or
llm-wiki reference. First read memory/pam.version.json, memory/graph/catalog.json,
and the relevant JSONL records in memory/graph/.

If memory/agent-memory/pam-openclaw.md exists, read it before proposing changes
to `MEMORY.md`, OpenClaw memory corpus files, wiki pages, or any
OpenClaw/project-owned memory source.

Open long markdown source files only when the graph digest and source pointer
are insufficient. Node/npm graph tools are optional; direct JSONL reading is
valid.
```

## Existing Project Audit Prompt

```text
Audit this repository for Portable Agent Memory readiness.

Read the repository instructions and inspect existing documentation, logs,
notes, and generated summaries.

Report:
- whether the repository has OpenClaw-native memory, local workspace conventions,
  missing PAM pieces, or conflicts;
- what already acts as durable memory;
- what is missing;
- what is duplicated or stale;
- where raw sources should live;
- what future agents should read first;
- whether local agent instructions already point to PAM;
- whether a maintenance tool is useful yet.

Then propose the smallest safe change set to make the repository PAM-compatible.
Do not modify files until the plan is clear. Include the installation acceptance
criteria that must be satisfied before calling the setup complete.
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
- optional scheduler runner and installer;
- tests or a dry-run verification command.

Run a dry-run before any real maintenance.

If synthesis is needed, configure it for the available runtime instead of
assuming Codex. The command may be Codex, Claude CLI, OpenClaw, Ollama, a local
script, or any other agent command that can work from a temporary workspace.
```

## Optional Agent Layer (Claude Code Plugin)

For Claude Code users, PAM ships as a plugin that bundles the MCP server,
reference subagents (curator + scribe), slash commands (`/pam:dream`,
`/pam:pam-status`), and lifecycle hooks. The portable markdown + JSONL contract
is unchanged, and agents reading `memory/` by hand keep working exactly as
before.

### Install the PAM plugin (Claude Code)

```text
Install the Portable Agent Memory plugin in Claude Code.

Steps:
- run `/plugin install NestDevLab/portable-agent-memory@github`;
- confirm `/agents` lists `curator` and `scribe` under the `pam` plugin;
- confirm `/dream` and `/pam:pam-status` are available;
- run `/dream` from inside a PAM workspace and confirm it returns a report.

Report every step with a colored marker: 🟢 PASS, 🟡 PARTIAL, 🔵 DEFERRED,
🔴 BLOCKED, or ⚪ N/A.
```

### Use the curator subagent

```text
Run the curator to audit this PAM workspace.

Steps:
- confirm the plugin is installed (see previous prompt);
- invoke the subagent (`/pam:curator` in Claude Code) and ask it to audit
  memory;
- confirm the agent only produces a Findings report and proposal artifacts
  under memory/maintenance/proposals/, never edits files elsewhere.

The curator never auto-applies edits. Review each proposal before deciding to
apply it (via the memory_apply_proposal MCP tool).

Report every step with a colored marker: 🟢 PASS, 🟡 PARTIAL, 🔵 DEFERRED,
🔴 BLOCKED, or ⚪ N/A.
```

### Use the scribe subagent

```text
Run the scribe at session end to record durable knowledge.

Steps:
- confirm the plugin is installed and the curator can run;
- invoke the subagent (`/pam:scribe` in Claude Code) at session end and ask
  it to record any durable knowledge from the conversation;
- confirm the agent only produces a Recorded report and appends dated
  sections to memory/knowledge-log.md or memory/conversation-log.md, never
  edits existing entries.

The scribe is append-only and cannot apply curator proposals. Use it for
recording new facts/decisions; use the curator for hygiene.

Report every step with a colored marker: 🟢 PASS, 🟡 PARTIAL, 🔵 DEFERRED,
🔴 BLOCKED, or ⚪ N/A.
```

### Other MCP hosts (Cursor, Codex, OpenClaw, etc.)

The plugin format is Claude Code-specific. For other hosts, add a stdio MCP
server entry pointing at `tools/pam-mcp-server.mjs`. See
[docs/mcp-server.md](docs/mcp-server.md) for host-specific snippets.

### Kimi Code CLI

```text
Install PAM for Kimi Code CLI.

Steps:
- run `node tools/kimi/install-mcp.mjs --apply` from the PAM workspace root;
- run `kimi mcp test pam` and confirm the server responds with tool names;
- start a Kimi session in the same workspace and ask it to read `memory/pam.version.json`.

Report every step with a colored marker: 🟢 PASS, 🟡 PARTIAL, 🔵 DEFERRED,
🔴 BLOCKED, or ⚪ N/A.
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
