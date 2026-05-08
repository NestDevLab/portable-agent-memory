# OpenClaw Adaptation Plan

Status: draft

## Goal

Adapt Portable Agent Memory (PAM) as a lightweight compatibility layer for OpenClaw memory without replacing or disrupting OpenClaw's existing architecture.

OpenClaw remains canonical. PAM provides portable metadata, graph summaries, and maintenance conventions that other agents can read when they do not understand OpenClaw internals.

## Non-goals

- Do not replace `MEMORY.md`.
- Do not replace project-specific memory conventions.
- Do not replace the compiled wiki or OpenClaw memory search.
- Do not store secrets, credentials, private raw chats, cookies, or tokens.
- Do not require a database, vector store, MCP server, or scheduler.

## Canonical OpenClaw sources

For an OpenClaw workspace, PAM should treat these as source systems, not as files to overwrite:

- `MEMORY.md`: curated long-term memory index.
- `memory/**/*.md`: indexed OpenClaw memory corpus where present.
- compiled wiki vault: source-backed syntheses and entity pages where present.
- project-specific memory conventions: local task notes, decision logs, profile/preference notes, project docs, or chronological logs when the project defines them.

## Proposed layout

Minimal additive layout:

```text
memory/pam.version.json
memory/agent-memory/pam-runtime.md
memory/agent-memory/pam-openclaw.md
memory/graph/catalog.json
memory/graph/nodes.jsonl
memory/graph/edges.jsonl
memory/graph/aliases.jsonl
```

Optional reports:

```text
memory/maintenance/pam-openclaw-report.md
```

## Read path for OpenClaw-aware agents

1. Use OpenClaw native memory tools first when available.
2. Use PAM graph as a compact routing/index layer.
3. Open canonical OpenClaw files only when the graph digest is insufficient.
4. Preserve source traceability back to OpenClaw files or wiki pages.

## Read path for non-OpenClaw agents

1. Read `memory/pam.version.json`.
2. Read `memory/agent-memory/pam-runtime.md`.
3. Query/search `memory/graph/*.jsonl`.
4. Follow `src` fields into canonical OpenClaw files only as needed.
5. Do not assume permission to read private files in shared/group contexts.

## Write policy

PAM should be mostly generated from OpenClaw memory.

Allowed direct PAM writes:

- graph nodes/edges/aliases/catalog;
- PAM runtime/adaptation docs;
- maintenance reports.

Avoid direct writes from PAM tooling to canonical OpenClaw memory unless explicitly configured.

Canonical memory updates should continue through OpenClaw's existing memory/wiki/task workflows.

## Mapping proposal

| OpenClaw concept | PAM representation |
| --- | --- |
| Person/profile | `k: person` or `k: profile` node |
| Project/venture | `k: project` node |
| Project-specific task or follow-up convention | `k: task-list` or `k: follow-up` node |
| Project-specific decision or procedure convention | `k: decision` or `k: procedure` node |
| Wiki page | `k: wiki-page` node |
| Chronological log source | source-only or `k: log` node |
| Project-specific profile/preference convention | `k: profile` or `k: preference` node with scoped edges |

## Safety rules

- Graph digests must be short and non-sensitive.
- `src` paths must not point to secret stores.
- Generated graph must not include raw private conversations by default.
- Shared/group contexts must avoid private profile or preference memory unless explicitly allowed.
- Maintenance should fail closed when source classification is unclear.

## First implementation milestone

1. Keep existing PAM generic toolkit valid.
2. Add `pam-openclaw.md` as an adapter spec.
3. Add fixture tests for OpenClaw-style memory layouts.
4. Add a dry-run command that detects OpenClaw memory sources and prints a proposed graph without writing canonical files.
5. Add docs explaining that OpenClaw memory remains canonical.

## Quality gates

Before adopting in an OpenClaw workspace:

- `npm test` passes.
- `npm run memory:graph:validate` passes.
- dry-run adapter produces only PAM graph/report changes.
- no secrets or private raw chats appear in graph JSONL.
- generated `src` values point to allowed memory/wiki/docs paths only.
