# Changelog

## Unreleased

## 0.3.1 - 2026-05-27

PAM 0.3.1 adds automated semantic migration enforcement. The graph schema
remains `pam-graph-v1`; this release adds a policy/tooling migration so future
operational, runtime, agent, graph, and tool changes must declare a versioned
migration path.

### Added

- Migration enforcement command: `npm run migrations:check`.
- CI-friendly checks for:
  - matching `package.json` and `memory/pam.version.json` versions;
  - valid semver migration filenames;
  - one-step patch/minor/major migration transitions;
  - contiguous migration chains from the base version to the target version;
  - migration-sensitive changes without a PAM version bump.
- Migration-sensitive path policy for PAM runtime/tooling, graph files, agent
  instructions, OpenClaw operational docs, and package metadata.
- Test coverage for semantic migration path validation.

### Compatibility

- `memoryFormat` remains `graph-v1`.
- `graphSchemaVersion` remains `pam-graph-v1`.
- Existing 0.3.0 graph JSONL files remain valid.

## 0.3.0 - 2026-05-08

PAM 0.3.0 adds an OpenClaw specialization profile and makes installation
completion more auditable across agent runtimes. The graph schema remains
`pam-graph-v1`; this release does not require a data migration for existing
0.2.0 graph users.

### Added

- OpenClaw specialization guide: `memory/agent-memory/pam-openclaw.md`.
- Documentation plans for OpenClaw adaptation and implementation phases under
  `docs/`.
- Generic PAM installation acceptance criteria with required final
  `PASS` / `PARTIAL` / `DEFERRED` / `BLOCKED` reporting.
- Colored human-facing status markers for acceptance reports:
  - 🟢 `PASS`
  - 🟡 `PARTIAL`
  - 🔵 `DEFERRED`
  - 🔴 `BLOCKED`
  - ⚪ `N/A`
- Explicit setup guidance to update local agent instruction files such as
  `AGENTS.md`, `CLAUDE.md`, or equivalent policy files with the PAM read path.
- OpenClaw-specific acceptance criteria: map before implementing, preserve
  OpenClaw-native memory, keep PAM additive, offer runtime-native maintenance
  automation, and scope automation to PAM-owned paths when accepted.
- Migration/adoption guide for 0.2.0 users adopting the 0.3.0 OpenClaw
  specialization.

### Improved

- Graph node digest validation now enforces the documented digest budget.
- Runtime docs clarify that PAM graph is a routing/index layer, not a replacement
  for runtime-native memory.
- OpenClaw docs distinguish generic OpenClaw-native memory concepts from
  project-specific conventions.

### Compatibility

- `memoryFormat` remains `graph-v1`.
- `graphSchemaVersion` remains `pam-graph-v1`.
- Existing 0.2.0 graph JSONL files remain valid.
- OpenClaw adoption is additive and should not rewrite existing canonical memory
  files by default.

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
