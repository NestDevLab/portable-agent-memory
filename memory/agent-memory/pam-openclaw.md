# PAM OpenClaw Specialization

Status: draft specialization  
Scope: OpenClaw workspaces and repositories that already contain OpenClaw-style durable memory.

## Purpose

Use this guide when applying Portable Agent Memory in an OpenClaw workspace.

OpenClaw memory remains canonical. PAM must act as an additive portability, source-tracing, and compact-index layer. Do not replace OpenClaw-native memory or workspace-owned conventions with a rigid PAM layout.

## First rule: map before implementing

Before creating any PAM files, map PAM concepts onto the memory concepts, files, tools, and conventions that already exist in the target project.

Classify every PAM capability as one of:

- **native**: already provided by OpenClaw or the target runtime; reuse it.
- **convention**: already represented by workspace files or workflows; preserve and map it.
- **missing**: absent; add the smallest PAM-owned structure needed.
- **conflicting**: overlaps with an existing source of truth; stop and propose a safe mapping instead of overwriting.

PAM fills gaps. It does not impose a parallel memory architecture.

## OpenClaw-native concepts

Treat these as runtime/project memory capabilities when present:

| Existing concept | PAM mapping | Rule |
| --- | --- | --- |
| `MEMORY.md` | curated long-term memory / top-level memory index | Read and source-trace; do not rewrite by default. |
| `memory/**/*.md` indexed by OpenClaw recall | searchable memory corpus | Reuse OpenClaw retrieval when available. |
| `memory_search` or equivalent recall tool | searchable retrieval | Prefer tool lookup over full-file rereads. |
| `memory-wiki` / compiled wiki | curated wiki / source-backed synthesis | Treat as canonical synthesis when enabled. |
| OpenClaw session transcripts | runtime history source | Summarize only when needed; do not copy raw private chat by default. |

## Common workspace conventions

These are common in some OpenClaw workspaces but are not universal OpenClaw primitives. Detect them conservatively and preserve ownership.

| Existing convention | PAM mapping | Rule |
| --- | --- | --- |
| `memory/tasks/` | task lists / follow-ups | Workspace-owned; do not replace. |
| `memory/profile/` | profile / preference memory | Private by default; use only when context allows. |
| `memory/decisions/` | decision log | Source-trace concise decision nodes only. |
| `memory/daily/` or dated daily notes | chronological logs | Usually source material, not primary graph nodes. |
| `shared/projects/` | project docs / project memory | Workspace-owned source corpus. |
| `shared/**` operational docs | project or procedure sources | Include only non-sensitive summaries. |

## Read order for OpenClaw-aware agents

1. Follow local instructions first: `AGENTS.md`, `SOUL.md`, `USER.md`, and any runtime-provided policy.
2. Use OpenClaw recall/search tools when available for questions about prior work, people, preferences, tasks, or decisions.
3. Read `MEMORY.md` and relevant `memory/**/*.md` files only as needed.
4. Read this specialization before applying generic PAM setup or migration behavior.
5. Use PAM graph files as a compact supplemental index, never as the sole source of truth for OpenClaw memory.

## Read order for non-OpenClaw agents

1. Read `memory/pam.version.json` if present.
2. Read `memory/agent-memory/pam-runtime.md`.
3. If `memory/agent-memory/pam-openclaw.md` exists, read it before proposing any memory changes.
4. Inspect `MEMORY.md`, `memory/`, and local repo instructions to identify existing canonical sources.
5. Propose a mapping and dry-run plan before writing.

## Write boundaries

Default write policy is fail-closed.

PAM-owned paths may be created or updated by explicit PAM commands or explicit user approval:

```text
memory/pam.version.json
memory/agent-memory/pam-openclaw.md
memory/graph/catalog.json
memory/graph/nodes.jsonl
memory/graph/edges.jsonl
memory/graph/aliases.jsonl
memory/maintenance/
```

Do not write, migrate, delete, or normalize these OpenClaw/workspace-owned paths by default:

```text
MEMORY.md
memory/tasks/
memory/profile/
memory/decisions/
memory/daily/
compiled wiki pages
shared/projects/
```

If a requested change would edit an OpenClaw-owned or workspace-owned memory source, ask for explicit confirmation and explain the safer PAM-owned alternative.

## Graph mapping rules

PAM graph records generated from OpenClaw memory must be compact, source-traced, and non-sensitive.

Required defaults:

- Include a source path or source note for each generated record.
- Keep digests short and agent-readable.
- Prefer summaries of stable facts, decisions, procedures, and indexes.
- Treat daily notes and transcripts as source material unless a durable fact has been promoted.
- Exclude secret stores, credentials, private keys, cookies, and raw private messages.
- In shared or public contexts, do not include private profile details unless the user explicitly approves.

Suggested initial mapping:

| Source | PAM node kind | Notes |
| --- | --- | --- |
| `MEMORY.md` curated index | `memory-index` | high-level routing node |
| `memory/tasks/*.md` | `task-list` | workspace convention |
| `memory/profile/*` | `profile` / `preference` | private by default |
| `memory/decisions/*` | `decision` | stable decisions only |
| `shared/projects/*` | `project` / `project-doc` | project corpus |
| compiled wiki page | `wiki-page` | source-backed synthesis |
| daily notes | `log` | source-only unless promoted |

## Detection guidance

A workspace may be treated as OpenClaw-like when one or more strong signals are present:

- `MEMORY.md` exists and describes OpenClaw memory behavior.
- `AGENTS.md`, `SOUL.md`, or `USER.md` references OpenClaw session/memory rules.
- `memory/**/*.md` is used as an indexed OpenClaw memory corpus.
- OpenClaw memory-wiki or compiled wiki files are present.

Weak signals such as `memory/tasks/` alone should be reported as local conventions, not proof of an OpenClaw workspace.

If uncertain, report `unknown` or `partial`; do not force OpenClaw specialization.

## Safe implementation sequence

1. Detect existing memory sources and conventions.
2. Produce a mapping table: native / convention / missing / conflicting.
3. Produce a dry-run graph/write plan under PAM-owned paths only.
4. Run validation for generated graph records.
5. Ask before writing outside PAM-owned paths.

## Quality gates

A PAM OpenClaw change is not ready unless:

- It preserves OpenClaw-native and workspace-owned memory as canonical.
- It includes a concept mapping before any implementation plan.
- It writes only PAM-owned paths by default.
- It avoids secrets and raw private conversations.
- It keeps source traceability for generated records.
- Generic PAM behavior remains valid for non-OpenClaw repositories.
