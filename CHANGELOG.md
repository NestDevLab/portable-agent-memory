# Changelog

## 0.2.0 - 2026-05-05

PAM 0.2.0 changes the default runtime shape from "read markdown docs first" to
"inspect compact graph memory first, then open source markdown only when
needed." Markdown remains fully supported and is still the portable source layer.

### Added

- Graph-v1 JSONL memory artifacts:
  - `memory/graph/nodes.jsonl`
  - `memory/graph/edges.jsonl`
  - `memory/graph/aliases.jsonl`
  - `memory/graph/catalog.json`
- Explicit memory/schema metadata in `memory/pam.version.json`, separate from
  the npm package version.
- Compact runtime guide in `memory/agent-memory/pam-runtime.md`.
- Optional graph tooling:
  - `npm run memory:graph:validate`
  - `npm run memory:graph:query`
  - `npm run memory:graph:stats`
  - `npm run memory:graph:index`
- Version-aware migration detection with `npm run memory:detect`.
- Migration guides for markdown-only, partial, and unknown layouts.
- Anonymous benchmark tooling:
  - `npm run benchmark:current`
  - `npm run benchmark:compare`
- Committed public benchmark baselines for `0.1.0` markdown-only and `0.2.0`
  graph-v1 retrieval.

### Improved

- Everyday agent memory lookup can now start from compact JSONL records instead
  of loading the full PAM contract and llm-wiki reference.
- The public benchmark shows generic memory query read volume dropping from
  `6655` token proxy in the `0.1.0` markdown baseline to `1370` token proxy in
  graph-v1, a `79.41%` reduction.
- Synthesis maintenance now includes graph memory in the allowed write scope
  while keeping policy docs and raw sources protected.
- Setup/protocol docs are now clearly separated from routine runtime lookup.

### Compatibility

- Node/npm tools are optional for agents reading memory. The graph format is
  plain JSONL and can be inspected with text search or any JSON parser.
- Existing markdown logs, indexes, sources, and archives remain valid.
- `memory/agent-memory/pam.md` and `memory/agent-memory/llm-wiki.md` remain the
  setup, audit, migration, and protocol references.

### Privacy

- Public benchmark files contain aggregate metrics only: counts, bytes, words,
  token proxies, command duration fields, and relative public repo paths.
- Benchmark outputs do not include raw source text, prompts, private paths,
  secrets, credentials, cookies, or tokens.

## 0.1.0

- Initial markdown-first Portable Agent Memory toolkit.
