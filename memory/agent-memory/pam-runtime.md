# PAM Runtime Guide

Use this compact path for everyday memory work. Read the full PAM contract only
for setup, migration, audit, or protocol changes.

## Read Order

1. Read `memory/pam.version.json`.
2. Read `memory/graph/catalog.json`.
3. Search `memory/graph/aliases.jsonl` and `memory/graph/nodes.jsonl` for the
   current topic.
4. Follow relevant one-hop relations in `memory/graph/edges.jsonl`.
5. Open the referenced `src` files only when the graph digest is insufficient.

## Direct JSONL Fallback

Node tools are optional. Without Node, use any text search or JSONL parser:

```bash
rg -n "PAM|graph|migration" memory/graph
```

Each JSONL line is independent. Prefer source-traced graph records over reading
large markdown documents by default.

## When To Read Long Docs

- Read `memory/agent-memory/pam.md` for protocol questions.
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

For durable AI memory, add or update graph records first, then keep markdown
logs/indexes compatible. Do not store secrets, credentials, private data, raw
private conversations, or machine-specific paths.
