# PAM OpenClaw Specialization

Status: draft specialization  
Scope: OpenClaw workspaces and repositories that already contain OpenClaw-style durable memory.

## Purpose

Use this guide when applying Portable Agent Memory in an OpenClaw workspace.

OpenClaw memory remains canonical. PAM must act as an additive portability, source-tracing, and compact-index layer. Do not replace OpenClaw-native memory or project-specific conventions with a rigid PAM layout.

## First rule: map before implementing

Before creating any PAM files, map PAM concepts onto the memory concepts, files, tools, and conventions that already exist in the target project.

Classify every PAM capability as one of:

- **native**: already provided by OpenClaw or the target runtime; reuse it.
- **convention**: already represented by project-specific files or workflows; preserve and map it.
- **missing**: absent; add the smallest PAM-owned structure needed.
- **conflicting**: overlaps with an existing source of truth; stop and propose a safe mapping instead of overwriting.

PAM fills gaps. It does not impose a parallel memory architecture.

## OpenClaw-native concepts

Treat these as OpenClaw memory capabilities when present:

| Existing concept | PAM mapping | Rule |
| --- | --- | --- |
| `MEMORY.md` | curated long-term memory / top-level memory index | Read and source-trace; do not rewrite by default. |
| `memory/**/*.md` indexed by OpenClaw recall | searchable memory corpus | Reuse OpenClaw retrieval when available. |
| `memory_search` or equivalent recall tool | searchable retrieval | Prefer tool lookup over full-file rereads. |
| `memory-wiki` / compiled wiki | curated wiki / source-backed synthesis | Treat as canonical synthesis when enabled. |
| OpenClaw session transcripts | runtime history source | Summarize only when needed; do not copy raw private chat by default. |

## Project-specific conventions

An OpenClaw workspace may contain additional project-specific memory conventions, such as task notes, decision logs, profile/preference notes, project documentation, daily logs, or other local knowledge stores.

These conventions are not assumed to be OpenClaw primitives. Detect them conservatively, preserve their ownership, and map them only as local project memory sources.

Rules:

- Do not document a local convention as an OpenClaw-native feature.
- Do not migrate or rewrite project-specific memory by default.
- Treat private or personal convention stores as private by default.
- If a convention conflicts with PAM, stop and propose a mapping instead of overwriting.

## Read order for OpenClaw-aware agents

1. Follow local instructions first: `AGENTS.md` and any runtime-provided policy.
2. Use OpenClaw recall/search tools when available for questions about prior work, preferences, tasks, decisions, or durable context.
3. Read `MEMORY.md` and relevant `memory/**/*.md` files only as needed.
4. Read this specialization before applying generic PAM setup or migration behavior.
5. Use PAM graph files as a compact supplemental index, never as the sole source of truth for OpenClaw memory.

## Read order for non-OpenClaw agents

1. Read `memory/pam.version.json` if present.
2. Read `memory/agent-memory/pam-runtime.md`.
3. If `memory/agent-memory/pam-openclaw.md` exists, read it before proposing any memory changes.
4. Inspect `MEMORY.md`, `memory/`, and local repo instructions to identify existing canonical sources and project-specific conventions.
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

Do not write, migrate, delete, or normalize OpenClaw-native memory or project-specific memory conventions by default. This includes `MEMORY.md`, OpenClaw memory corpus files, compiled wiki pages, and any local memory stores that the project already treats as canonical.

If a requested change would edit an OpenClaw-owned or project-owned memory source, ask for explicit confirmation and explain the safer PAM-owned alternative.

## Graph mapping rules

PAM graph records generated from OpenClaw memory must be compact, source-traced, and non-sensitive.

Required defaults:

- Include a source path or source note for each generated record.
- Keep digests short and agent-readable.
- Prefer summaries of stable facts, decisions, procedures, and indexes.
- Treat chronological logs and transcripts as source material unless a durable fact has been promoted.
- Exclude secret stores, credentials, private keys, cookies, and raw private messages.
- In shared or public contexts, do not include private profile/preference details unless the user explicitly approves.

Suggested initial mapping:

| Source | PAM node kind | Notes |
| --- | --- | --- |
| `MEMORY.md` curated index | `memory-index` | high-level routing node |
| `memory/**/*.md` corpus entry | `memory-source` / specific inferred kind | source-traced, conservative classification |
| compiled wiki page | `wiki-page` | source-backed synthesis |
| project-specific task or follow-up convention | `task-list` / `follow-up` | local convention only |
| project-specific decision or procedure convention | `decision` / `procedure` | local convention only |
| project-specific profile or preference convention | `profile` / `preference` | private by default |
| project-specific documentation corpus | `project` / `project-doc` | local convention only |
| chronological log source | `log` | source-only unless promoted |

## Detection guidance

A workspace may be treated as OpenClaw-like when one or more strong signals are present:

- `MEMORY.md` exists and describes OpenClaw memory behavior.
- Local agent instructions reference OpenClaw session or memory rules.
- `memory/**/*.md` is used as an indexed OpenClaw memory corpus.
- OpenClaw memory-wiki or compiled wiki files are present.

Project-specific memory folders alone should be reported as local conventions, not proof of an OpenClaw workspace.

If uncertain, report `unknown` or `partial`; do not force OpenClaw specialization.

## Safe implementation sequence

1. Detect existing memory sources and conventions.
2. Produce a mapping table: native / convention / missing / conflicting.
3. Produce a dry-run graph/write plan under PAM-owned paths only.
4. Update the local agent instruction file, such as `AGENTS.md`, with the PAM read path.
5. Run validation for generated graph records.
6. Ask before writing outside PAM-owned paths.
7. Configure a runtime-native maintenance automation, or explicitly mark it `PARTIAL`/`BLOCKED` with the reason.
8. Report the PAM installation acceptance criteria one by one before claiming completion.


## OpenClaw-specific installation acceptance criteria

In addition to the generic PAM installation criteria, an OpenClaw workspace must
verify these OpenClaw-specific criteria:

1. OpenClaw-native memory remains canonical: `MEMORY.md`, indexed `memory/**/*.md`, OpenClaw recall/search, and memory-wiki when present.
2. PAM files are treated as an additive routing/index layer, not a replacement for OpenClaw memory.
3. Local agent instructions, usually `AGENTS.md`, point future agents to the PAM read path.
4. Project-specific conventions are preserved and are not documented as OpenClaw-native primitives.
5. A runtime-native maintenance automation is configured, preferably an OpenClaw cron job, to periodically validate/maintain PAM-owned files and write a maintenance report.
6. The automation is scoped to PAM-owned paths by default and must not rewrite `MEMORY.md`, OpenClaw corpus files, wiki pages, or project-specific conventions unless explicitly requested.
7. The final installation report lists each OpenClaw-specific criterion as `PASS`, `PARTIAL`, or `BLOCKED` with evidence.

## Quality gates

A PAM OpenClaw change is not ready unless:

- It preserves OpenClaw-native and project-owned memory as canonical.
- It includes a concept mapping before any implementation plan.
- It writes only PAM-owned paths by default.
- It avoids secrets and raw private conversations.
- It keeps source traceability for generated records.
- Generic PAM behavior remains valid for non-OpenClaw repositories.
- Local agent instructions point future agents to the PAM read path.
- A runtime-native maintenance automation exists, such as an OpenClaw cron job, or the final report explicitly marks automation as `PARTIAL`/`BLOCKED` with the reason.
- The final response reports each PAM installation acceptance criterion as `PASS`, `PARTIAL`, or `BLOCKED` with evidence.
