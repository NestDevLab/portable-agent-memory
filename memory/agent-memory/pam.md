# Portable Agent Memory Constitution

A lightweight, agent-agnostic memory protocol for Codex, OpenClaw, Claude Code, Cursor, and future AI runtimes.

This document is not a database design, folder structure, or framework specification.

It is a contract for how an AI agent should preserve, organize, search, update, and explain durable knowledge over time.

---

## 1. Guiding idea

The memory system should remain adaptable.

The agent may use markdown files, llm-wiki, MCP, graph memory, vector search, Mem0, SQLite, custom indexes, or future better tools.

The protocol only defines the required outcomes.

It does not permanently bind the project to one implementation.

---

## 2. Configurable header

Edit this header for each environment.

The values below are examples and placeholders.

```yaml
# Human-readable project name.
project:
  name: example-project
  description: Replace with your project description

# AI runtime currently using this document.
runtime:
  current: codex
  supported:
    - codex
    - openclaw
    - claude-code
    - cursor
    - other

# Conceptual references.
# These are not mandatory local paths.
references:
  llm_wiki_pattern: ./llm-wiki.md

# Source locations the agent may inspect.
# Adapt these to the local environment.
sources:
  workspace_root: /path/to/workspace

  # Human-maintained project documentation.
  primary_docs: ./docs

  # Optional runtime/agent configuration folder.
  agent_config: /path/to/agent-config

  # Optional runtime history folder.
  # Example: ~/.codex, local logs, transcripts, exported chats.
  runtime_history:
    enabled: true
    path: /path/to/runtime-history

  # Optional external knowledge folder.
  # Example: mounted drive, synced folder, shared docs export.
  external_knowledge:
    enabled: false
    path: /path/to/external-knowledge

# Required memory guarantees.
memory:
  # If false, the agent may choose/adapt the folder structure.
  strict_structure: false

  # If true, the agent may choose the best backend/tooling available.
  allow_backend_choice: true

  # The agent may maintain and update memory files.
  allow_agent_writes: true

  # Raw sources must be append-only or preserved before modification.
  raw_archive_policy: append-only

  # Destructive edits require explicit approval.
  destructive_change_policy: approval-required

  # Required outcomes.
  require_immutable_archive: true
  require_curated_memory: true
  require_searchable_index: true
  require_source_traceability: true
  require_periodic_reprocessing: true
  require_conflict_tracking: true

# Search/indexing strategy.
indexing:
  strategy: adaptive

  # Minimum acceptable indexing method.
  # The agent must be able to find relevant memory without rereading everything.
  minimum: readable-index-or-local-search

  allowed_methods:
    - markdown-indexes
    - grep-or-ripgrep
    - llm-wiki
    - sqlite-fts
    - mcp-tools
    - graph-memory
    - vector-search
    - mem0
    - future-better-methods

# Optional tools/backends.
# allowed = may be used if available.
# required = system is incomplete without it.
tools:
  llm_wiki:
    allowed: true
    preferred: true
    required: false
    local_path: null

  mcp:
    allowed: true
    preferred: true
    required: false

  graph_memory:
    allowed: true
    preferred: false
    required: false

  vector_db:
    allowed: true
    preferred: false
    required: false

  mem0:
    allowed: true
    preferred: false
    required: false

# Scoped preference memory.
preferences:
  enabled: true
  scopes:
    - global
    - project
    - channel
    - user
    - session

  priority_order:
    - system
    - global
    - project
    - channel
    - user
    - current_request

# Privacy and safety defaults.
privacy:
  store_sensitive_information_by_default: false
  redact_secrets: true
  avoid_credentials_in_memory: true

# Periodic maintenance.
scheduler:
  enabled: true
  preferred_modes:
    - cron
    - systemd
    - github-actions
    - runtime-native-scheduler

  maintenance_goal: preserve-organize-index-and-report
```

---

## 3. How an AI agent should use this document

1. Read the configurable header first.
2. Adapt paths, sources, tools, and runtime behavior to the current environment.
3. Treat the required capabilities as mandatory outcomes.
4. Choose the simplest available implementation that satisfies the contract.
5. Before answering memory-related questions, run the retrieval protocol.
   If the environment is OpenClaw-like, read `pam-openclaw.md` and map PAM
   concepts to existing runtime/project memory before implementing new
   structures.
6. During scheduled maintenance, run the maintenance routine and produce a short report.
7. If the current implementation becomes too rigid, obsolete, or inefficient, propose a migration without breaking the core contract.

---

## 4. Core contract

Any implementation is acceptable if it provides these outcomes.

### 4.1 Preserve raw sources

Original material should be preserved.

The agent may summarize, reorganize, and index it, but should not destroy source material.

Raw archives should be append-only when possible.

### 4.2 Maintain curated memory

The agent should extract durable knowledge into cleaner memory.

Examples:

* decisions
* facts
* preferences
* troubleshooting notes
* architecture notes
* timelines
* glossary entries
* unresolved questions
* known conflicts

### 4.3 Maintain a searchable index

The agent must provide an efficient way to find relevant memory.

The index can be simple or advanced.

Acceptable examples:

* markdown index files
* grep / ripgrep
* llm-wiki exports
* SQLite FTS
* MCP memory tools
* graph memory
* vector search
* Mem0
* any better future method

The protocol requires searchability, not one specific backend.

### 4.4 Track sources

Important memory entries should point back to their source when possible.

The agent should be able to explain:

* where information came from
* when it was last updated
* whether it is confirmed, inferred, uncertain, outdated, or conflicting

### 4.5 Track conflicts and obsolete knowledge

The agent should not silently overwrite old knowledge when new knowledge conflicts with it.

It should either:

* mark the old memory as obsolete
* keep both versions and explain the conflict
* ask for clarification if the conflict matters

### 4.6 Reprocess periodically

A scheduled routine should improve the memory over time.

The routine should:

1. scan configured sources
2. preserve new raw inputs
3. extract durable knowledge
4. update curated memory
5. update indexes
6. update preference memory when appropriate
7. detect conflicts or obsolete information
8. produce a short maintenance report

---

## 5. Runtime retrieval protocol

Before answering questions about project history, past decisions, architecture, troubleshooting, preferences, or durable context, the agent must search memory first.

Recommended order:

1. understand the current request
2. load relevant user/session preferences
3. load relevant project/channel preferences
4. search curated memory
5. search indexes/wiki/graph/vector tools
6. inspect raw archive only if needed

The agent must not invent missing memory.

If memory is missing or incomplete, it should say so clearly.

---

## 6. Preference memory

The system must support scoped preferences.

Scopes:

```txt
global   -> applies to everyone
project  -> applies to one project
channel  -> applies to one Discord/Telegram/channel/context
user     -> applies to one user
session  -> applies only to the current conversation
```

Priority order:

```txt
system rules
> global preferences
> project preferences
> channel preferences
> user preferences
> current request
```

Example user preference:

```json
{
  "scope": "user",
  "user_id": "example-user",
  "key": "style.verbosity",
  "value": "concise",
  "source": "chat",
  "confidence": "high"
}
```

Example project preference:

```json
{
  "scope": "project",
  "project": "example-project",
  "key": "style.language",
  "value": "preferred-language",
  "source": "chat",
  "confidence": "medium"
}
```

The agent should save only stable preferences.

Temporary instructions should not become permanent memory.

Sensitive information should not be stored unless explicitly requested and appropriate.

---

## 7. Tool selection policy

The agent may choose the best available tools in the current environment.

The agent should prefer simple, transparent, local-first solutions first.

The agent may propose a migration if a better method becomes available.

No backend is permanent.

Suggested interpretation:

```txt
markdown/index files = simple transparent memory
llm-wiki             = knowledge compiler
MCP                  = standard access interface
Graph memory         = relationship map between entities/events/decisions
Vector search        = semantic similarity search
Mem0                 = optional external memory engine/provider
```

---

## 8. Shareable AI assets

Some memory artifacts should be easy to share with another AI runtime.

The goal is portability, not a mandatory file layout.

An implementation may store skills, runbooks, and memory notes wherever it
keeps durable knowledge, but each shareable artifact should be readable as a
self-contained Markdown document.

Shareable artifacts should:

* state their purpose and scope
* name their expected inputs and outputs
* list required tools or environment assumptions
* explain privacy and safety constraints
* point to sources or source locations when possible
* include a last verified or last updated date
* avoid secrets, credentials, cookies, private keys, and raw sensitive content
* separate confirmed facts from assumptions

Agent-facing artifact rule:

* Treat skills and runbooks as agent control surfaces, not only human-readable
  documentation.
* Write critical behavior with explicit `MUST`, `DO NOT`, `BLOCKED`,
  `PARTIAL`, and `COMPLETE` language when those states matter.
* Put final quality gates near the output or completion section so an agent can
  check them immediately before answering.
* Include compact wrong/right examples for failure patterns that a model is
  likely to compress, skip, or misread.
* Prefer mechanically checkable completion criteria over vague guidance.

Example:

```text
Weak: Include useful context for each ticket.
Strong: The final recap is not ready if any ticket key appears without a title
or one-sentence description.
```

### 8.1 Skill template

Use a skill for a reusable capability that an AI agent can invoke when a task
matches a trigger.

```markdown
# Skill: <name>

## Purpose

What this skill helps the agent do.

## Scope

Where the skill applies and where it should not be used.

## Trigger

When the agent should load or follow this skill.

## Required tools

Tools, permissions, runtimes, or files the skill expects.

## Workflow

Step-by-step behavior the agent should follow.

## Safety and privacy

Constraints, forbidden actions, and sensitive data handling rules.

## Sources

Where the skill came from or which docs validate it.

## Last verified

YYYY-MM-DD or unknown.
```

### 8.2 Runbook template

Use a runbook for an operational procedure that should be repeatable.

```markdown
# Runbook: <name>

## Goal

The outcome this runbook should produce.

## Prerequisites

Accounts, tools, files, state, or access needed before starting.

## Inputs

Information the agent or human must provide.

## Outputs

Artifacts, reports, state changes, or decisions produced.

## Procedure

Numbered steps to perform the work.

## Verification

Checks that prove the procedure succeeded.

Include a final quality gate when the procedure produces a report, answer,
state transition, or decision. The gate should be written for an AI agent under
context pressure, not only for a human reviewer. Use concrete checks such as:

* no required source is missing;
* every ID has a title or description;
* every `PARTIAL` or `BLOCKED` item has a blocker and next action;
* the final message does not claim writes or state changes that were not
  performed.

## Failure modes

Known problems, recovery steps, and escalation points.

## Rollback

How to undo or contain side effects when applicable.

## Sources

Primary references and source traces.

## Last verified

YYYY-MM-DD or unknown.
```

### 8.3 Memory note template

Use a memory note for a compact, source-traceable piece of durable knowledge.

```markdown
# Memory Note: <short title>

## Status

Confirmed, inferred, uncertain, obsolete, or conflicting.

## Claim

The fact, assumption, preference, decision, or open question being recorded.

## Source

Where this knowledge came from.

## Confidence

High, medium, low, or unknown.

## Updated

YYYY-MM-DD.

## Related memory

Links or references to related notes, decisions, runbooks, or raw sources.
```

---

## 9. llm-wiki role

llm-wiki should be treated as a knowledge compiler, not as the whole memory system.

It may transform raw conversations and documents into a cleaner wiki.

The system may use llm-wiki for:

* summaries
* wiki pages
* AI-readable exports
* knowledge organization

But the protocol must remain valid without llm-wiki.

---

## 10. MCP role

MCP is the preferred standard interface for agents to access memory tools.

MCP may expose operations such as:

```txt
memory_search
memory_read
memory_recent
memory_sources
memory_status
memory_graph
memory_rebuild
```

However, MCP is optional in the first version.

A document-driven workflow is acceptable if it satisfies the required capabilities.

---

## 11. Scheduled maintenance

A scheduler may periodically invoke an AI agent with this document.

Example concept:

```bash
codex exec "Read memory/agent-memory/pam.md and perform the scheduled memory maintenance routine."
```

Or:

```bash
openclaw run --agent example-agent --instruction ./memory/agent-memory/pam.md --task "Perform scheduled memory maintenance routine"
```

The exact command depends on the runtime.

The maintenance report should include:

```txt
- sources scanned
- raw inputs preserved
- curated memory updated
- indexes updated
- preferences updated
- conflicts detected
- errors found
- suggested improvements
```

---

## 12. Success criteria

A good implementation makes the agent:

* faster at finding context
* less repetitive
* more aware of past decisions
* better at preserving knowledge
* clearer about uncertainty
* safer with source material
* easier to migrate to better tools later

If the memory structure becomes too rigid, heavy, or obsolete, the agent should propose a simpler or better design.

---

## 13. Core principle

The memory system is not a folder structure.

It is not a database.

It is not llm-wiki.

It is not Mem0.

It is a contract:

```txt
The agent must preserve, organize, search, update, and explain durable knowledge across time.
```
