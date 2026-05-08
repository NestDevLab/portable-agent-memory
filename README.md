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

- [memory/pam.version.json](memory/pam.version.json): explicit PAM memory format
  and schema metadata for migration detection.
- [memory/agent-memory/pam-runtime.md](memory/agent-memory/pam-runtime.md): the
  compact graph-first runtime guide for everyday agent memory lookup.
- [memory/graph/](memory/graph): AI-first JSONL graph memory. Agents can read it
  directly without Node, npm, a database, or embeddings.
- [memory/agent-memory/pam.md](memory/agent-memory/pam.md): the Portable Agent
  Memory constitution. This is the setup/protocol reference agents should
  follow when changing or auditing PAM itself.
- [memory/agent-memory/pam-openclaw.md](memory/agent-memory/pam-openclaw.md):
  specialization guide for applying PAM inside OpenClaw workspaces without
  replacing OpenClaw-native memory.
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

### OpenClaw Workspaces

If the target project is an OpenClaw workspace, or it already contains
OpenClaw-style memory such as `MEMORY.md`, `memory/**/*.md`, memory-wiki files,
or OpenClaw-specific agent instructions, read
[`memory/agent-memory/pam-openclaw.md`](memory/agent-memory/pam-openclaw.md)
after the generic PAM runtime guide.

For OpenClaw, PAM must first map its concepts onto existing runtime/project
memory. Reuse OpenClaw-native memory and local workspace conventions where they
already exist. Add only PAM-owned missing pieces, such as graph/index files, and
do not overwrite `MEMORY.md`, workspace task files, profile memory, decisions,
or wiki pages by default.

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
   If this is an OpenClaw workspace, read `memory/agent-memory/pam-openclaw.md`
   and map PAM concepts to existing OpenClaw/project memory before creating new
   files.
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
- Optional: an agent CLI for the bounded synthesis step.
- Optional: cron, Task Scheduler, launchd, systemd, or another scheduler for
  recurring runs.

Commands:

```bash
npm test
npm run memory:graph:validate
npm run memory:graph:query -- --q PAM --json
npm run memory:detect -- --json
npm run benchmark:current
npm run benchmark:compare -- --before benchmarks/baselines/pam-0.1.0-markdown.json --after benchmarks/baselines/pam-0.2.0-graph-v1.json
npm run memory:maintain:dry-run
npm run memory:maintain
npm run memory:rotate
npm run memory:index
npm run memory:synthesis
npm run memory:schedule:install
```

The deterministic rotation and archive-index steps do not require any AI
runtime. The full `memory:maintain` command runs deterministic maintenance
first, then runs optional bounded synthesis only when
`tools/memory-maintenance.config.json` enables it.

The synthesis command is configurable. It can point to Codex, Claude CLI,
OpenClaw, Ollama, a local script, or no agent at all.

## Graph Memory V1

PAM now includes a compact JSONL graph layer. This is the default read path for
everyday memory questions:

1. Read `memory/pam.version.json`.
2. Read `memory/graph/catalog.json`.
3. Search `memory/graph/aliases.jsonl` and `memory/graph/nodes.jsonl`.
4. Follow relevant entries in `memory/graph/edges.jsonl`.
5. Open long markdown source files only when the graph digest is insufficient.

The optional `memory:graph:*` scripts validate and query this data, but agents
can also use plain text search or any JSONL parser. Node is not required to read
or manually update the memory.

## Benchmarks

The benchmark tool records aggregate public metrics only: file counts, bytes,
word counts, token proxies, command durations, and read-volume estimates. It
does not store raw source text, private paths, prompts, tokens, cookies, or
credentials.

Committed baselines live under `benchmarks/baselines/` so markdown-only and
graph-v1 retrieval can be compared over time.

Current public baseline comparison:

| Scenario | 0.1.0 markdown token proxy | 0.2.0 graph-v1 token proxy | Change |
| --- | ---: | ---: | ---: |
| Generic memory query | 6655 | 1370 | -79.41% |

Benchmark files:

- [pam-0.1.0-markdown.json](benchmarks/baselines/pam-0.1.0-markdown.json)
- [pam-0.2.0-graph-v1.json](benchmarks/baselines/pam-0.2.0-graph-v1.json)

Reproduce the comparison:

```bash
npm run benchmark:compare -- --before benchmarks/baselines/pam-0.1.0-markdown.json --after benchmarks/baselines/pam-0.2.0-graph-v1.json
```

The benchmark is a read-volume proxy, not a model billing report. It estimates
the amount of text an agent needs to inspect for the same generic memory lookup
path before and after graph-v1.

## Maintenance Safety Model

The maintenance tool is conservative:

- archived entry bodies are copied unchanged;
- archive files are append-only;
- dry-run mode reports planned moves before editing;
- agent synthesis runs in a temporary workspace;
- agent synthesis copy-back is restricted to allowlisted paths;
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
- `synthesis`: optional agent command. It supports placeholders:
  `{workspace}`, `{output}`, `{prompt}`, and `{runJson}`.

Examples:

```json
{
  "synthesis": {
    "enabled": true,
    "provider": "codex",
    "command": "codex",
    "args": ["exec", "--full-auto", "-C", "{workspace}", "-o", "{output}", "{prompt}"]
  }
}
```

```json
{
  "synthesis": {
    "enabled": true,
    "provider": "ollama",
    "command": "ollama",
    "args": ["run", "llama3.1"],
    "stdin": "prompt"
  }
}
```

```json
{
  "synthesis": {
    "enabled": true,
    "provider": "claude",
    "command": "claude",
    "args": ["-p", "{prompt}"]
  }
}
```

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
  install-memory-maintenance-schedule.mjs
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
