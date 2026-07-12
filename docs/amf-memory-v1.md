# AMF memory record v1

PAM 0.6.1 implements the public `amf-memory/v1` file-first contract used by
Agent Memory Fabric. It is additive: existing PAM logs and graph-v1 workspaces
continue to work unchanged.

## Canonical file

Each record is one Markdown file at:

```text
memory/amf/records/<id>.md
```

`<id>` is the record's opaque `mem_<id>`. The logical record is stored in YAML
frontmatter. PAM accepts a deterministic YAML subset: every top-level field is
one `key: value` line and nested objects/arrays use compact JSON, which is valid
YAML. Sealed records have an empty Markdown body. Plain records may use the body
only for non-claim commentary.

```markdown
---
schema: amf-memory/v1
id: mem_11111111-1111-4111-8111-111111111111
revision: 1
claimType: decision
scope: {"type":"shared","id":"shared:global"}
visibility: shared
confidence: {"score":0.99,"basis":"reviewed","assessedAt":"2026-07-11T10:00:00Z"}
subjects: [{"identityId":"agent:22222222-2222-4222-8222-222222222222","role":"owner"}]
claim: {"encoding":"plain","text":"A portable source-backed decision."}
lifecycle: {"status":"active","validFrom":"2026-07-11T10:00:00Z","validTo":null,"supersedes":[],"revokedAt":null,"revocationReason":null}
provenance: [{"sourceType":"hermes-session","sourceId":"session-stable-id","eventId":"event-idempotency-key","contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","capturedAt":"2026-07-11T10:00:00Z"}]
createdAt: 2026-07-11T10:00:00Z
updatedAt: 2026-07-11T10:00:00Z
---
Optional non-claim commentary.
```

Unknown fields and unknown major schemas fail validation. Timestamps are strict
RFC 3339 UTC (`Z`), not local offsets. Provenance is non-empty and contains
pointers and hashes, never embedded RAW.

`confidence` is mandatory and contains exactly `score`, `basis`, and
`assessedAt`. `score` is a finite number from `0` through `1`; `basis` is one
of `observed`, `asserted`, `inferred`, or `reviewed`; `assessedAt` is RFC 3339
UTC and falls between `createdAt` and `updatedAt`. Unknown or missing fields
fail closed. A revision may reassess confidence, but any change requires a
strictly newer `assessedAt`, which may never move backwards.

## Sealed claims

A claim must be sealed when any of these is true:

- primary scope is `person` or `relationship`;
- a subject is a `person` or `relationship` identity;
- `claimType` is `relationship`;
- visibility is `confidential` or `restricted`.

The sealed union is stored directly in `claim`:

```json
{
  "encoding": "sealed",
  "alg": "AES-256-GCM",
  "kekId": "kek:<versioned-id>",
  "keyRef": "key:<external-record-key-id>",
  "iv": "<12 bytes, base64>",
  "ciphertext": "<non-empty base64>",
  "tag": "<16 bytes, base64>",
  "aadSha256": "<sha256>"
}
```

PAM validates the envelope but never decrypts it. The DEK and wrapped key stay
in the external key registry referenced by `keyRef`; they must not enter Git,
logs, proposal metadata, or the PAM graph.

AAD is compact canonical JSON with object keys sorted recursively, encoded as
UTF-8. In addition to record routing fields, it binds the envelope algorithm
and external key identifiers:

```json
{"schema":"...","id":"...","revision":1,"claimType":"...","scope":{},"visibility":"...","confidence":{"score":0.99,"basis":"reviewed","assessedAt":"2026-07-11T10:00:00Z"},"subjects":[],"envelope":{"alg":"AES-256-GCM","kekId":"kek:...","keyRef":"key:..."}}
```

PAM recomputes its SHA-256 and requires an exact `aadSha256` match. An IV of any
size other than 96 bits, a tag other than 128 bits, empty ciphertext, malformed
`keyRef`, or a mismatched AAD hash fails closed. The sealed record body must be
empty.

## Revision and lifecycle safety

Canonical lifecycle statuses are `active`, `superseded`, `revoked`, and
`expired`. `proposed` exists only in the proposal queue.

For an edit of an existing record, PAM enforces all of the following both when
recording and applying the proposal:

- `revision` is exactly the current revision plus one;
- the proposal's `expectedTargetSha256` equals the SHA-256 of the complete prior
  file and `expectedRevision` equals its revision;
- ID, creation time, claim type, scope, and subjects are immutable; plaintext
  claims are byte-for-byte immutable;
- visibility can narrow but cannot widen;
- confidence reassessment requires a strictly newer assessment timestamp;
- provenance and `lifecycle.supersedes` are append-only;
- only `active` may transition to a terminal lifecycle state;
- `updatedAt` strictly increases.

A claim correction is a new record that names the prior ID in
`lifecycle.supersedes`; it is not an in-place claim rewrite.
PAM resolves every named target inside the current workspace, rejects missing,
symlinked, or invalid targets, and refuses a target newer than the correction.
Provenance entries are ordered by `capturedAt`, and none may be later than the
record's `updatedAt`.

Because revision is authenticated AAD, a sealed record revision necessarily
has a refreshed envelope. PAM requires it to remain sealed, checks the new AAD
hash, and rejects IV reuse. Verifying that the decrypted claim is unchanged is
the authorized Fabric curator's responsibility; PAM never receives the DEK.

## Proposal/apply boundary

Use `memory_propose_record` for creation or `memory_propose_edit` for a metadata
or lifecycle revision. `memory_apply_proposal` is the separate authorized apply
stage. Proposal and apply both reject symlinks in the target or any ancestor,
use no-follow reads, and revalidate schema, revision, hash and graph projection.
Apply is protected by proposal and per-target exclusive locks. Before touching
the target it reserves the final archive path with an atomic no-replace link,
so an archive collision cannot produce an untracked write. The reservation is
`applying`, never `applied`; after the target is atomically persisted and
fsynced it is finalized to `applied`. A retry recovers either state
idempotently and verifies the persisted content hash before reporting success.
An `applying` reservation is bound to the complete immutable proposal artifact,
including source, diff/provenance, rationale, findings, validation and any
future proposal fields—not only its id, target and content hash. A mismatch
cannot overwrite the reservation, persist the target, or remove the live
proposal.
If the live proposal still exists, recovery also requires the archive proposal
identity, target, proposed/persisted hashes, and validation-warning summary to
match before the proposal artifact can be removed.

Each lock carries a PID, host, random nonce, acquisition time, and heartbeat.
Takeover is fail-closed: it is allowed only when the heartbeat is stale and the
same-host owner PID is provably dead. Foreign-host, malformed, fresh, or live
locks require operator review or a later retry. Heartbeat and release verify
both the owner token and inode, so an old owner cannot update or remove a lock
that has been replaced.

The graph node returned by validation is derived. It is checked both standalone
and against the workspace's actual graph-v1 files. A collision with a
non-memory node fails. An older `memory-record` projection is allowed only as a
bounded stale derivative and produces a warning requiring regeneration after
apply. Sealed and non-shared claims project only a generic digest and never
identity IDs, ciphertext, scope IDs, or key references.

That warning is durable across the whole review boundary. Proposal results and
artifacts, applied archives, and apply results expose `graphProjectionStale`,
`regenerateAfterApply`, and a required `npm run memory:graph:index` follow-up.
An apply coordinator must not discard that follow-up when marking its task done.

## Optional curator

The deterministic AMF curator adds an idempotent queue, policy/review decisions,
deduplication, and proposal/apply orchestration without changing this record
contract. It is disabled for automatic promotion by default and never accepts
RAW transcripts. See [AMF deterministic curator](amf-curator.md).

## Validation

```bash
npm test
npm run migrations:check
npm run mcp:smoke
```
