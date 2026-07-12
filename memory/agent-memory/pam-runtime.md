# PAM Runtime Guide

Use this compact path for everyday memory work. Read the full PAM contract only
for setup, migration, audit, or protocol changes. During setup or migration,
verify the PAM installation acceptance criteria in `pam.md` before claiming
completion.

## Read Order

1. Read `memory/pam.version.json`.
2. Read `memory/graph/catalog.json`.
3. Search `memory/graph/aliases.jsonl` and `memory/graph/nodes.jsonl` for the
   current topic.
4. Follow relevant one-hop relations in `memory/graph/edges.jsonl`.
5. Open the referenced `src` files only when the graph digest is insufficient.
6. If `memory/agent-memory/pam-openclaw.md` exists and the workspace has
   OpenClaw-style memory, read it before proposing memory writes or migrations.

## File-Only Efficiency Gate

When the agent has only file read/search tools, PAM should still reduce
retrieval cost. For memory, project, task, decision, or procedure questions:

- Use the graph-first path above before scanning broad markdown corpora.
- Keep initial routing to `memory/pam.version.json`, `memory/graph/catalog.json`,
  `aliases.jsonl`, `nodes.jsonl`, and `edges.jsonl`.
- Follow at most one source file from the best matching node before falling
  back to a wider search.
- Treat missing aliases, stale statuses, and broad fallback as coverage gaps to
  record in the next maintenance pass.

Validate this behavior with:

```bash
npm run memory:graph:coverage -- --json
```

Default acceptance target: at least 80% of realistic queries should route to
the expected node with no more than 5 graph files and 100 KB read before source
fallback.

## Direct JSONL Fallback

Node tools are optional. Without Node, use any text search or JSONL parser:

```bash
rg -n "PAM|graph|migration" memory/graph
```

Each JSONL line is independent. Prefer source-traced graph records over reading
large markdown documents by default.

## When To Read Long Docs

- Read `memory/agent-memory/pam.md` for protocol questions.
- Read `memory/agent-memory/pam-openclaw.md` when `MEMORY.md`, OpenClaw recall,
  memory-wiki, or OpenClaw workspace conventions are present.
- Read `memory/agent-memory/llm-wiki.md` for wiki-pattern questions.
- Read markdown logs only for chronology or details missing from graph records.

## Agent-Facing Runbooks

PAM runbooks are primarily for future AI agents. They should shape behavior,
not only explain a process.

When creating or updating a runbook:

- Use explicit `MUST` / `DO NOT` rules for critical behavior.
- Add final quality gates near the output or completion section.
- Include compact wrong/right examples for recurring failure patterns.
- Prefer mechanically checkable completion criteria over vague guidance.

Example: write "the final recap is not ready if any ticket key appears without
a title or one-sentence description" instead of only "include useful ticket
context."

## Updating Memory

For classic PAM memory, add or update graph records first, then keep markdown
logs/indexes compatible. When `pam.version.json` enables `amfMemoryV1`, the
canonical `memory/amf/records/` Markdown record comes first and its graph node is a
safe derived projection. Create it through the proposal/apply flow and validate
it again before graph maintenance. Do not store secrets, credentials, private
data, raw private conversations, or machine-specific paths in plaintext.

In OpenClaw workspaces, first map PAM concepts to existing OpenClaw-native or
workspace-owned memory. Write only PAM-owned files by default, and do not edit
`MEMORY.md`, OpenClaw memory corpus files, wiki pages, or project-specific
memory conventions unless the user explicitly asks for that change.
