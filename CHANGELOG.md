# Changelog

## Unreleased

### Added

- PAM 0.6.4 authenticated metadata-only review notification scanner and an
  owner-only, retryable OpenClaw/Discord relay with stable-marker reconciliation.

- PAM 0.6.3 bounded Fabric proposal drain, immutable proposal/digest binding,
  authenticated HTTPS decision/apply receipts with separate credentials,
  atomic record-index refresh, and verifier-only apply receipt checks.
- Opt-in scoped Git delivery with repository/branch/remote allowlists, exclusive
  locking, unrelated-change refusal, commit recovery, and non-forced
  fast-forward push. Commit and push remain disabled by default.
- Scope-bound Fabric receipts, starvation-free authenticated replay cursors,
  repository/branch/remote/target-bound Git state, and parent-dirfd private-file
  reads for config, bearer tokens, and applicator state keys.

- PAM 0.6.2 decision receipts and a separately authorized deterministic
  applicator with durable apply-receipt outbox and crash recovery.

- Mandatory exact `amf-memory/v1` confidence metadata with finite score,
  evidence basis, UTC assessment time, AAD binding, and revision-safe changes.

- Deterministic AMF candidate queue, versioned reviews, deduplication, policy
  decisions, and `approved_pending_apply` receipts.
- Strict, HMAC-chained append-only curator decision ledger with an authenticated
  sequence/length/head anchor and redacted fail-closed status output.
- `memory_curator_submit`, `memory_curator_review`,
  `memory_curator_status`, and `memory_curator_git_plan` MCP tools plus the
  `memory:curator` CLI.
- Fail-closed Git writer plan abstraction, disabled and dry-run-only by default;
  it refuses protected branches and direct push.

### Safety

- Applicator proposal digests are now enforced inside `applyProposal` after the
  per-target lock and before archive reservation or target persistence, closing
  the post-`prepared` proposal-swap TOCTOU window.

- The curator accepts complete `amf-memory/v1` records only, never RAW
  transcripts or arbitrary source payloads, and has no direct canonical write
  path.
- Automatic approval is disabled by default. Explicitly enabled eligible
  candidates still require the separate `memory:apply-receipt` applicator.
- Candidate/review artifacts require an external ledger key; manual review and
  apply require a separately allowlisted server-side capability. Recovery
  verifies the exact applied archive and canonical target before success.
- The head anchor lives outside the curator queue tree and is never recreated
  for a non-empty ledger. Dedup/status fail on any unverified artifact and
  reconcile promotion events with applied-archive history. Ledger record,
  source, and target references are HMAC-only.
- The anchor and initialized marker now live in a pre-provisioned external
  `0700` state root outside the workspace, paired with a workspace sentinel.
  Deterministic crash recovery covers candidate-fsync and ledger-before-anchor
  boundaries; strict-prefix anchor advancement requires an allowlisted admin
  capability through CLI/MCP.
- Review-fsync and apply-before-ledger boundaries now recover only from one
  exact MAC-authenticated candidate-version decision or applied archive. Exact
  retries converge; explicit admin recovery remains capability-gated and
  refuses forged, unrelated, or ambiguous external-ahead state.
- Automatic-policy retries additionally bind the normalized policy snapshot,
  deterministic actor/action/idempotency, and exact original submission. Both
  queued-review and auto-promote crash boundaries converge without weakening
  the manual-review contract.

## 0.6.0 - 2026-07-11

PAM 0.6.0 adds the optional `amf-memory/v1` Markdown record contract for
source-traceable, scope-aware durable memory.

### Added

- Zero-dependency contract-v1 frontmatter, lifecycle, scope, provenance,
  opaque-ID, sealed-claim, RFC 3339 UTC, and canonical-path validation.
- Safe graph-v1 node projections that never expose sealed content or identity
  references.
- `memory_record_validate` and `memory_propose_record` MCP tools.
- AMF record creation through the existing proposal/apply review boundary.

### Safety

- Person/relationship scopes and subjects, relationship claims, and
  confidential or restricted visibility require an `AES-256-GCM` envelope with external
  `keyRef` and canonical AAD hash.
- Proposal and apply enforce ancestor symlink rejection, no-follow reads,
  revision/base-hash transitions, per-target locking, archive reservation,
  recoverable atomic persistence, supersedes resolution, and real graph collision checks.
- Stale derived-graph warnings survive proposal, archive, and apply responses
  with an explicit required graph-reindex follow-up.
- MCP never decrypts records and never creates a canonical record directly.

### Compatibility

- `memoryFormat` and `graphSchemaVersion` remain `graph-v1` and
  `pam-graph-v1`.
- Existing logs, graphs, proposals, and MCP tools continue unchanged.

## 0.5.0 - 2026-05-27

PAM 0.5.0 adds a measurable file-only retrieval gate for agents that cannot use
semantic memory search. The graph schema remains `pam-graph-v1`; this release
also includes the migration-enforcement tooling introduced after 0.3.0.

### Added

- `memory:graph:coverage` CLI for graph-first coverage reports.
- Default file-only coverage scenario at `benchmarks/file-only-coverage.json`.
- Migration guide for 0.4.0 users adopting file-only coverage.
- Runtime guidance requiring graph-first lookup before broad corpus scans.

### Improved

- Graph memory now includes aliases and nodes for the coverage scenario.
- Coverage output reports aggregate read volume, targeted source counts, hit
  rate, and `PASS` / `PARTIAL` / `BLOCKED` status without raw source text or
  absolute paths.
- README documents the default 5-file / 100 KB graph-first budget and 80% hit
  rate target.

### Compatibility

- `memoryFormat` remains `graph-v1`.
- `graphSchemaVersion` remains `pam-graph-v1`.
- Existing 0.4.0 graph JSONL files remain valid.

### Added: Kimi Code CLI integration

- `tools/kimi/install-mcp.mjs` registers the PAM MCP server with Kimi Code CLI
  by writing an absolute-path entry into `~/.kimi/mcp.json`.
- `tools/kimi/templates/mcp.fragment.json` is the config template used by the
  installer.
- `tools/kimi/docs/pam-kimi-layer.md` covers install, verify, uninstall, and
  ad-hoc `--mcp-config-file` usage.
- `npm run kimi:mcp:install` shortcut for the installer.
- `docs/mcp-server.md` and `AGENT_BOOTSTRAP.md` gain Kimi-specific sections.

## 0.4.0 - 2026-05-21

PAM 0.4.0 ships the optional agent layer end-to-end: a local stdio MCP
server, the curator and scribe reference subagents, and a Claude Code
plugin that wires the MCP server, agents, slash commands, and hooks into a
single installable unit. The markdown + JSONL contract is unchanged;
existing 0.3.0 graph-v1 workspaces work without modification.

### Added: MCP server

- Local MCP server (`tools/pam-mcp-server.mjs`) that exposes PAM as 15 typed
  tools over stdio. Hand-rolled JSON-RPC 2.0 transport with zero new runtime
  dependencies. Includes `--smoke` mode (`npm run mcp:smoke`) for verifying
  the server starts without configuring a host.
- Read surface: `pam_version`, `memory_state`, `memory_list`, `memory_read`,
  `memory_search`, `graph_query`, `graph_stats`, `graph_validate`,
  `maintenance_config`, `memory_audit`.
- Hygiene mutation surface: `graph_reindex` (rewrites
  `memory/graph/catalog.json` from JSONL sources), `maintenance_run`
  (config-gated).
- Write surface: `memory_propose_edit` (records JSON proposals under
  `memory/maintenance/proposals/`, never mutates targets directly);
  `memory_append` (appends a dated `## YYYY-MM-DD - <title>` section to a
  managed log declared in `config.managedLogs`, newest-first);
  `memory_apply_proposal` (re-validates path safety + re-applies the diff,
  rejects drift, archives successful applies as `<id>.applied.json`).
- `memory_audit` hygiene checks: duplicate-knowledge-entry, link-rot,
  graph-source-link-rot, dangling-alias, stale-wiki-page, rotation-candidate,
  contradiction, oversized-digest, orphan-source.

### Added: Subagents

- `curator`: read-mostly hygiene auditor. Tool whitelist enforces no
  `Write`, `Edit`, `Bash`, `maintenance_run`, `graph_reindex`,
  `memory_append`, or `memory_apply_proposal`. Emits proposals; never
  applies.
- `scribe`: session-end closeout. Uses `memory_search` to dedup-check, then
  `memory_append` to record durable knowledge into `knowledge-log` or
  `conversation-log`. Append-only.

### Added: Claude Code plugin

- `.claude-plugin/plugin.json` declares the plugin (name `pam`, version
  0.4.0) and inlines the `mcpServers` config; installing the plugin starts
  the PAM MCP server automatically.
- `tools/claude/commands/`: `/pam:dream` (hygiene pass: `graph_validate` +
  `graph_reindex` + `memory_audit`), `/pam:status` (read-only workspace
  snapshot), `/pam:explain` (inlined shell block that prints the status-line
  legend with live values; zero LLM reasoning per invocation),
  `/pam:enable-status-line` (toggle the statusline by renaming the
  `statusLine` key in `settings.json` to/from `_pamDisabledStatusLine`).
- `tools/claude/agents/`: `curator` and `scribe`.
- `tools/claude/hooks/hooks.json` wires `SessionStart` (catalog-freshness check, pending-
  proposal nag, statusline-style summary) and `PostToolUse` matching
  `mcp__pam__memory_append` (per-session append counter at
  `memory/.session/<session_id>.json`).
- Statusline (`tools/claude/templates/statusline/pam-statusline.sh`)
  shows `🧠 PAM <version> · <glyph> <N>n/<M>e · 📋 <pending> · 💤 <age> ·
  ✍️ <appends>`. Pending-proposal count excludes `*.applied.json`.
- `tools/claude/install-statusline.mjs` (`npm run claude:statusline:install`) for
  users who want only the statusline without the full plugin.

### Added: Docs and tests

- `docs/mcp-server.md` (generic MCP docs), `tools/claude/docs/curator-agent.md`,
  `tools/claude/docs/scribe-agent.md`, `tools/claude/docs/pam-claude-layer.md`.
- `AGENT_BOOTSTRAP.md` gains an "Optional Agent Layer (PAM 0.4.0+)" section
  with copy/paste install prompts.
- Tests: `test-mcp-transport.mjs`, `test-memory-audit.mjs`,
  `test-memory-proposals.mjs`, `test-memory-append.mjs`,
  `test-memory-apply-proposal.mjs`, `test-pam-mcp-server.mjs` (66 subtests).

### Compatibility

No migration required. The markdown + JSONL contract is unchanged; the new
layer is additive runtime. Existing 0.3.0 graph-v1 workspaces work unchanged,
including agents that read `memory/` by hand without the MCP server.

### Privacy

`memory_propose_edit` proposal artifacts and applied-proposal archives
(`memory/maintenance/proposals/`) may quote memory content. `memory_append`
quotes whatever the scribe provides as `body`; the scribe's prompt contract
requires summarizing secrets/PII rather than copying them. Treat all
proposal artifacts with the same care as existing maintenance run reports.

### Out of scope

- Bootstrap (`pam-bootstrap`) and Query (`pam-query`) subagents.
- Cursor / Codex / OpenClaw subagent presets (Claude Code only).
- Remote MCP transport (HTTP/SSE/WebSocket).
- Vector or semantic search.
- Direct graph-mutation tools beyond `graph_reindex` (derived) and
  `maintenance_run` (config-gated).
- Auto-rotation of `memory/maintenance/proposals/`.
- Apply-batch (`memory_apply_proposals(ids: [...])`).
- Auto-invocation hooks for `scribe` (session-end hook). Manual invocation
  only.
- `memory_replace` / `memory_delete` for managed logs. Use
  `memory_propose_edit` + `memory_apply_proposal` instead.

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
