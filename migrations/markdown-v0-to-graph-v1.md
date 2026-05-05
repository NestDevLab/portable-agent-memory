# Migration: Markdown-Only PAM To Graph V1

## Goal

Add AI-first graph memory without removing portable markdown logs or source
documents.

## Detect Current State

1. Read `memory/pam.version.json` if present.
2. If missing, inspect `memory/index.md`, `memory/conversation-log.md`,
   `memory/knowledge-log.md`, and `memory/agent-memory/`.
3. Classify markdown-only layouts as `markdown-v0`.
4. Classify missing or inconsistent graph artifacts as `partial`.

Optional helper:

```bash
npm run memory:detect -- --json
```

## Migration Steps

1. Add `memory/pam.version.json` with `memoryFormat: graph-v1`.
2. Add `memory/graph/nodes.jsonl`, `edges.jsonl`, `aliases.jsonl`, and
   `catalog.json`.
3. Add a compact runtime guide that makes graph lookup the default path.
4. Keep existing markdown logs and raw sources unchanged.
5. Validate graph references and duplicate IDs.

Optional validation:

```bash
npm run memory:graph:validate
```

## Recovery

If graph files are incomplete, keep the markdown memory as source of truth and
repair or regenerate graph records. Do not delete raw sources or archived logs.
