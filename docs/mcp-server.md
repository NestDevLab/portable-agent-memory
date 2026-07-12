# PAM MCP server

PAM 0.4.0 ships an optional MCP (Model Context Protocol) server that exposes
the memory store as typed tools to any MCP-capable agent host. The portable
markdown + JSONL contract is unchanged; the server is purely additive runtime.

## What you get

The server runs locally over stdio (no network, no daemon, no port) and exposes
22 tools under the `pam` namespace:

- `pam_version`, `memory_state`, `maintenance_config`: context tools
- `memory_list`, `memory_read`, `memory_search`: safe filesystem reads under `memory/`
- `memory_record_validate`: validates `amf-memory/v1` Markdown and returns a safe graph projection
- `graph_query`, `graph_stats`, `graph_validate`, `graph_reindex`: graph tools
- `memory_audit`: hygiene checks, returns findings
- `memory_propose_edit`: records a proposal artifact under `memory/maintenance/proposals/`; never mutates the target file
- `memory_propose_record`: validates an AMF record and records a create proposal; never writes the record directly
- `memory_append`: appends a dated section to a managed log; refuses unmanaged paths
- `memory_apply_proposal`: applies a recorded proposal through an exclusive
  `applying` reservation, atomic target persistence, `applied` finalization,
  and idempotent recovery
- `memory_curator_submit`, `memory_curator_review`, and
  `memory_curator_status`: deterministic AMF candidate/review orchestration
  with authenticated artifacts, a redacted HMAC-chained decision ledger, and a
  sequence/length/head anchor
- `memory_receipt_apply`: separately authorized receipt applicator; verifies an
  `approved_pending_apply` decision, uses PAM proposal/apply, and queues a
  digest-bound `memory_apply_receipt`
- `memory_curator_git_plan`: fail-closed Git writer planning; disabled and
  dry-run-only by default, with no Git execution or push path
- `memory_curator_recover`: curator-only recovery for an existing strict-prefix
  external anchor or one exact review artifact; apply recovery is an exact
  `memory_receipt_apply` retry
- `maintenance_run`: wraps the maintenance CLI (defaults to dry-run)

Write paths through the server are bounded:

- `memory_append` only writes to paths declared in `config.managedLogs`
  (typically `memory/knowledge-log.md` and `memory/conversation-log.md`).
- `memory_apply_proposal` only writes to whatever target a previously-recorded
  proposal already passed through the safety validator at propose time, and
  re-validates everything (protected paths, drift, graph integrity) before
  applying. Archive collisions and proposal-identity mismatches fail closed
  before target persistence.
- `memory_propose_record` is the only underlying proposal path for creating an
  AMF record. Only the receipt applicator delegates to it.
- The curator emits `review_required`, `rejected`, or
  `approved_pending_apply`; it never applies or reports promotion.
- Curator decisions require `memory:curate`; canonical application requires a
  distinct server-side `memory:apply-receipt` capability. Client-supplied
  reviewer labels never authorize a change.
- `graph_reindex` writes only the derived `memory/graph/catalog.json`.
- `maintenance_run` is gated by `config` and defaults to dry-run.

There is no path to write to `memory/agent-memory/`, `memory/sources/`,
`AGENTS.md`, or `CLAUDE.md` through any MCP tool. Those paths are protected.

## Requirements

- Node.js 18 or newer (already required by PAM's existing tools).
- An MCP-capable host: Claude Code, Cursor, Codex CLI, OpenClaw, or any other
  client that speaks MCP over stdio.

## Verify the server starts

From the repo root:

```bash
npm run mcp:smoke
```

The smoke run prints two JSON-RPC frames (initialize result and tools/list
result) and exits 0. If it errors, fix the workspace before configuring a host.

## Host configuration

### Claude Code

Add to project `.mcp.json` (preferred) or `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "pam": {
      "command": "node",
      "args": ["tools/pam-mcp-server.mjs"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

Restart Claude Code, then run `/mcp` to confirm `pam` is connected.

### Cursor

Add to `~/.cursor/mcp.json` (resolve `cwd` to an absolute path):

```json
{
  "mcpServers": {
    "pam": {
      "command": "node",
      "args": ["tools/pam-mcp-server.mjs"],
      "cwd": "/absolute/path/to/your/repo"
    }
  }
}
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.pam]
command = "node"
args = ["tools/pam-mcp-server.mjs"]
cwd = "/absolute/path/to/your/repo"
```

### Kimi Code CLI

Install via the PAM helper (dry-run by default):

```bash
node tools/kimi/install-mcp.mjs --apply
```

This writes absolute paths into `~/.kimi/mcp.json`. Verify with:

```bash
kimi mcp list
kimi mcp test pam
```

To uninstall:

```bash
node tools/kimi/install-mcp.mjs --uninstall --apply
```

For ad-hoc usage without touching global config:

```bash
kimi --mcp-config-file tools/kimi/mcp-config.json
```

See `tools/kimi/docs/pam-kimi-layer.md` for full details.

### OpenCode / OpenClaw

Point your MCP host configuration at `node tools/pam-mcp-server.mjs` with `cwd`
set to the repo root. The exact config file location depends on your client.

## Tool naming across hosts

Each host prefixes MCP tools with the server name. Claude Code surfaces them as
`mcp__pam__memory_audit`, `mcp__pam__graph_validate`, and so on. Cursor and
Codex use similar prefixes. The unprefixed tool name within the server is
always one of the 22 listed above.

## Workspace selection

By default the server resolves the workspace as the directory containing
`tools/pam-mcp-server.mjs` (i.e. the PAM repo root). To target a different
workspace, pass `--workspace <path>`:

```bash
node tools/pam-mcp-server.mjs --workspace /path/to/other/repo
```

The host config's `cwd` field is the simplest way to do this in practice.

## Limitations

- stdio transport only (no HTTP/SSE/WebSocket).
- No streaming notifications, no cancellation.
- One-file-per-call for `memory_propose_edit`; diffs are capped at 64 KB.
- Symlinks are refused for every file operation.

The transport is hand-rolled (zero new dependencies). If a future host requires
features we don't support, falling back to `@modelcontextprotocol/sdk` is a
one-file change in `tools/lib/mcp-transport.mjs`.

## Safety surface

`memory_propose_edit`, `memory_propose_record`, and the curator tools produce
artifacts intended for review. The separate receipt applicator delegates
canonical changes to the proposal/apply tools. They reject, with a clear error
message:

- paths matching `config.protectedPaths` (`AGENTS.md`, `CLAUDE.md`, `memory/agent-memory/`, `memory/sources/`);
- paths that resolve outside the workspace;
- symlinks;
- multi-file diffs;
- diffs over 64 KB;
- unified-diff hunks whose `before` doesn't match current content;
- JSONL edits whose result fails `validateGraph`.
- AMF records that fail schema, lifecycle, scope, provenance, sealing, or path
  validation.

Proposal artifacts are JSON files under `memory/maintenance/proposals/`.
Applying a proposal is a manual step that the human takes after review,
typically via `memory_apply_proposal` below.

For the record schema, sealed-claim rules, lifecycle constraints, and safe graph
projection, see [AMF memory record v1](amf-memory-v1.md).
For curator policy, idempotency, recovery, and the redacted decision ledger,
see [AMF deterministic curator](amf-curator.md).

## Write tools

### `memory_append`

Inputs:

- `log` (required): the managed log to append to. Match on
  `config.managedLogs[].archiveKey` (preferred, e.g. `"knowledge-log"`) or
  `.source` (e.g. `"memory/knowledge-log.md"`).
- `headerTitle` (required): the title portion of the new section header. The
  server constructs the full header as `## YYYY-MM-DD - <headerTitle>`.
- `body` (required): markdown body of the new section.
- `date` (optional): ISO `YYYY-MM-DD`. Defaults to today UTC.

The server rejects:

- logs not declared in `config.managedLogs`;
- empty `headerTitle` or `body`;
- headers that don't match `## YYYY-MM-DD - <title>`;
- malformed `date` strings;
- missing target files (no auto-create);
- symlinked target files.

Inserts the new section immediately after the file's intro prefix and before
the first existing dated section (newest-first ordering).

### `memory_apply_proposal`

Inputs:

- `proposalId` (required): the id of a JSON artifact under
  `memory/maintenance/proposals/<id>.json`.

The server uses this state machine:

1. Acquires the exclusive proposal lock and loads the archive/proposal state.
   A pending or `applying` operation also acquires the per-target lock before
   target validation or persistence.
2. Re-runs the same safety checks `memory_propose_edit` ran at propose time
   (protected paths, workspace escape, symlinks).
3. Re-applies the diff against the *current* target content. If the file has
   drifted since the proposal was recorded (`before` no longer matches, or
   unified-diff hunks don't align), apply is rejected and the artifact is
   untouched.
4. For JSONL targets, runs `validateGraph` on the proposed result.
5. Exclusively reserves `<id>.applied.json` with `status: "applying"` before
   touching the target. The reservation binds the complete immutable proposal
   identity. A pre-existing foreign, malformed, or mismatched archive is a
   collision and fails closed without overwriting the archive, writing the
   target, or deleting the live proposal.
6. Atomically persists and fsyncs the target, then reloads and verifies that
   the same reservation still owns the archive path.
7. Finalizes the archive as `status: "applied"` with `appliedAt` and the
   persisted content hash.
8. Removes the live `<id>.json` proposal only after finalization succeeds.

Retries are idempotent. A matching `applying` reservation resumes the operation
whether or not the target was already persisted. A matching `applied` archive
is recovered only after its proposal identity and target hash are verified; a
lingering live proposal is removed only after that verification. If persistence
succeeds but finalization does not, the live proposal and recoverable archive
state remain for a later retry.

Drift detection is intentional. A proposal that fails apply is a signal that
the target changed since review; re-run the curator, get a fresh proposal,
re-review, then apply.

## Uninstall

Remove the host config entry. No state remains outside `memory/maintenance/`,
which you can keep or clean up at your discretion.
