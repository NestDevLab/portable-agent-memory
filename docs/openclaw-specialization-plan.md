# OpenClaw Specialization Plan

Status: draft  
Branch: `feat/openclaw-specialization`

## Intent

Add OpenClaw as an official Portable Agent Memory specialization profile.

PAM remains generic and portable. The OpenClaw specialization tells OpenClaw-aware agents how to apply PAM without replacing OpenClaw's native memory architecture.

## Core decision

OpenClaw-native memory mechanisms are canonical where they exist. Workspace-specific memory conventions remain owned by the workspace. PAM is an additive portability, routing, and compact-index layer over both.

This specialization must not migrate, overwrite, or redefine OpenClaw-native memory or workspace-specific memory conventions by default.


## Adaptation principle

Before creating new PAM structures, an agent must map PAM concepts onto the memory concepts, files, tools, and conventions that already exist in the target project.

The agent should then classify each PAM capability as one of:

- **native**: already provided by the runtime or project; reuse it;
- **convention**: already represented by local project files or workflows; preserve and map it;
- **missing**: not present yet; implement the smallest PAM-owned addition;
- **conflicting**: overlaps with an existing source of truth; stop and propose a safe mapping instead of overwriting.

PAM should fill gaps, not impose a parallel memory architecture.

For OpenClaw this means, for example:

- `MEMORY.md` maps to PAM curated long-term memory / index.
- OpenClaw memory search maps to PAM searchable retrieval.
- `memory-wiki` maps to PAM curated wiki / source-backed synthesis.
- Workspace task files, if present, map to PAM task or follow-up concepts as project conventions.
- PAM graph files may be added as a compact portability/index layer only when they do not replace existing sources.

## Goals

- Provide a clear OpenClaw-specific PAM entrypoint.
- Require agents to map PAM capabilities onto existing project/runtime memory concepts before creating new structures.
- Direct OpenClaw agents to use native OpenClaw memory first.
- Export compact PAM graph records from mapped OpenClaw/project memory sources.
- Preserve source traceability back to OpenClaw files/wiki pages.
- Keep the specialization useful for non-OpenClaw agents that inspect an OpenClaw workspace.
- Avoid secrets, credentials, raw private chats, and unnecessary private data.

## Non-goals

- Replace `MEMORY.md`.
- Replace workspace-specific task conventions such as `memory/tasks/`.
- Replace OpenClaw memory search.
- Replace the compiled wiki.
- Require a database, vector store, MCP server, or scheduler.
- Modify OpenClaw core.

## Repository deliverables

### 1. Specialization documentation

Add:

```text
memory/agent-memory/pam-openclaw.md
```

This file defines the OpenClaw-specific rules for agents.

It should cover:

- the PAM-to-existing-project-concepts mapping step;
- OpenClaw-native sources versus workspace conventions;
- read order for OpenClaw-aware agents;
- read order for non-OpenClaw agents;
- write boundaries;
- privacy/safety policy;
- graph mapping rules;
- quality gates.

### 2. Bootstrap routing update

Update existing PAM bootstrap docs so they say:

- if the workspace is OpenClaw or contains OpenClaw memory files, read `memory/agent-memory/pam-openclaw.md` after the generic PAM runtime guide;
- do not apply the generic PAM layout rigidly over OpenClaw's existing memory structure;
- treat OpenClaw-native memory files and workspace-owned memory conventions as existing sources, not PAM-owned files.

Likely files:

```text
README.md
AGENT_BOOTSTRAP.md
memory/agent-memory/pam-runtime.md
memory/agent-memory/pam.md
```

Keep changes small and explicit.

### 3. OpenClaw workspace and convention detection

Add deterministic detection for OpenClaw workspaces and known workspace-specific memory conventions.

Initial detection signals:

- `MEMORY.md` exists;
- `memory/tasks/` exists as a workspace convention signal, not a generic OpenClaw primitive;
- `SOUL.md`, `USER.md`, or `AGENTS.md` mention OpenClaw memory behavior;
- bundled memory-wiki tooling/files are present.

Detection should be conservative. If uncertain, report `unknown` instead of forcing the OpenClaw specialization.

### 4. Dry-run graph proposal

Add a dry-run mode that inspects OpenClaw memory sources and prints proposed PAM graph records without writing canonical OpenClaw files.

The first version can emit JSON only.

Suggested command shape:

```bash
npm run memory:openclaw:detect -- --json
npm run memory:openclaw:plan -- --json
```

The dry-run should propose writes only under PAM-owned paths:

```text
memory/pam.version.json
memory/agent-memory/pam-openclaw.md
memory/graph/catalog.json
memory/graph/nodes.jsonl
memory/graph/edges.jsonl
memory/graph/aliases.jsonl
memory/maintenance/
```

### 5. Mapping rules

Mapping is mandatory before implementation. Agents must reuse existing concepts first, then add only PAM-owned missing pieces.

Initial OpenClaw/workspace-to-PAM mapping:

| Source | PAM node kind | Notes |
| --- | --- | --- |
| `MEMORY.md` curated index | `memory-index` | high-level routing node |
| `memory/tasks/*.md` | `task-list` | workspace convention, not OpenClaw-native |
| `memory/profile/*` | `profile` / `preference` | workspace convention; only when safe for context |
| `memory/decisions/*` | `decision` | workspace convention |
| `shared/projects/*` | `project` / `project-doc` | workspace convention |
| compiled wiki page | `wiki-page` | source-backed synthesis |
| daily notes | `log` | usually source-only unless promoted |

Node digest rule:

- short, non-sensitive, source-traced summaries only;
- no raw private messages by default;
- no secrets or paths to secret stores.

### 6. Fixtures and tests

Add OpenClaw-style fixture workspaces under tests/fixtures or equivalent.

Scenarios:

1. Minimal generic PAM workspace: no OpenClaw specialization.
2. OpenClaw workspace with `MEMORY.md` plus workspace task convention: detected as OpenClaw with task convention support.
3. Partial/ambiguous workspace: reports unknown/partial.
4. Sensitive source path: excluded or warned.
5. Generated graph digests validate under existing graph limits.

Quality gates:

```bash
npm test
npm run memory:graph:validate
npm run memory:openclaw:detect -- --fixture <fixture> --json
npm run memory:openclaw:plan -- --fixture <fixture> --json
```

### 7. Safety and write boundaries

The OpenClaw specialization must fail closed.

Rules:

- No writes to OpenClaw-native memory or workspace-owned memory conventions unless explicitly configured.
- No deletion of OpenClaw files.
- No copying raw private chats into graph JSONL.
- No graph records sourced from secret storage.
- No public/group-chat assumption that private profile memory is readable.
- All generated records must include a source path or source note.

## Implementation phases

### Phase 1 — Documentation-only specialization

- Add `pam-openclaw.md`.
- Update bootstrap docs with OpenClaw routing rule.
- Keep all tooling unchanged except tests if needed.

Acceptance:

- docs are clear enough for an agent to follow manually;
- generic PAM behavior remains unchanged;
- tests still pass.

### Phase 2 — Detection and dry-run planning

- Add OpenClaw detection utility.
- Add JSON dry-run planner.
- Add fixtures and tests.

Acceptance:

- OpenClaw fixture detected correctly;
- generic PAM fixture remains generic;
- dry-run output only proposes PAM-owned paths;
- tests pass.

### Phase 3 — Optional graph export

- Add explicit command to write/update PAM graph files from OpenClaw sources.
- Keep command opt-in.
- Add report under `memory/maintenance/`.

Acceptance:

- command never edits `MEMORY.md`, workspace task files, or wiki pages;
- generated graph validates;
- report explains source coverage and exclusions.

### Phase 4 — Adoption docs

- Add a short user-facing guide: how to enable PAM in an OpenClaw workspace.
- Add examples for OpenClaw agents and non-OpenClaw agents.

Acceptance:

- clear setup path;
- clear rollback path: delete PAM-owned files only.

## Recommended first PR scope

Keep the first OpenClaw support PR documentation-first:

- add `pam-openclaw.md`;
- update bootstrap/readme routing;
- include this plan or a condensed version;
- no canonical memory writes;
- no scheduler;
- no OpenClaw core assumptions beyond file-layout detection notes.

Then follow with a second PR for detection/dry-run tooling.

## Open questions

- Should OpenClaw detection live in the existing migration tool or a dedicated `memory-openclaw.mjs` tool?
- Should the graph export read compiled wiki files directly, or only consume their public/source-backed summaries?
- What is the safest default for private profile/preference memory in shared workspaces?
- Should OpenClaw specialization be enabled by explicit config only, or auto-detected with confirmation?

## Current recommendation

Implement OpenClaw support as an explicit specialization profile that can be auto-detected but should only write PAM-owned files after explicit command invocation.

This gives OpenClaw agents a clear path while preserving OpenClaw's native memory model.
