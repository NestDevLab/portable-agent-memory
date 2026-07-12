# AMF curator and receipt applicator

PAM 0.6.2 separates memory judgment from canonical mutation. Both components
accept complete `amf-memory/v1` records only; neither accepts RAW transcripts,
message bodies, decryption keys, or arbitrary source payloads.

## Authority boundary

The curator has only `memory:curate`. It validates, deduplicates, records a
versioned review, and emits an authenticated decision receipt with exactly one
outcome:

- `review_required`;
- `rejected`;
- `approved_pending_apply`.

The curator never calls PAM proposal/apply, never reports `promoted`, and never
writes `memory/amf/records/`. `autoPromote` is retained as the compatibility
name for policy-based automatic approval, but it only emits
`approved_pending_apply`. Confidence selects a policy route; it grants no
capability and cannot expand scope or visibility.

The applicator has a distinct `memory:apply-receipt` credential. It accepts only
the latest authenticated `approved_pending_apply` receipt, verifies its
candidate, revision, decision digest, policy digest, and lifecycle-at-decision,
then uses the existing `memory_propose_record`/`memory_propose_edit` and
`memory_apply_proposal` implementation. Auto-approval cannot bypass it.

## Durable artifacts

Curator artifacts are HMAC-authenticated and mode `0600`:

```text
memory/amf/curator/
├── queue/<candidate-id>.json
├── reviews/<decision-id>.json
├── decision-receipts/<decision-id>.json
└── decisions.jsonl
memory/amf/curator.initialized.json
```

The append-only decision ledger is typed, sequence-numbered, HMAC-chained, and
anchored in a pre-provisioned external `0700` state directory. IDs are derived
from stable idempotency keys. An exact retry returns the existing artifact;
altered content, decision, policy, or authenticated artifact fails closed.

Applicator state and its transport outbox are independently authenticated:

```text
memory/amf/applicator/
├── state/<apply-id>.json
└── outbox/<apply-id>.json
```

The recoverable state machine is:

```text
prepared -> pam_applied -> receipt_queued -> fabric_acked
```

The apply receipt is discriminated as `memory_apply_receipt` and binds
`proposalId`, `decisionId`, `decisionDigest`, `policyDigestAtApply`,
`canonicalRecordId`, `revision`, `canonicalLifecycleAtDecision`, and SHA-256
digests of the proposal, applied archive, and canonical target. PAM verifies the
archive and target before queuing the receipt.

The `prepared` state stores the canonical proposal digest. `applyProposal`
re-reads the proposal after acquiring both its proposal lock and the canonical
target lock, then compares that digest before reservation or persistence. A
valid proposal altered after `prepared`, or swapped while the target lock is
being acquired, fails closed without changing the target or archive.

Crashes after every state boundary converge under the exact idempotency key.
A crash after PAM apply is recovered through PAM's applied archive; a crash
after Fabric ACK relies on the sink treating `applyId` as its idempotency key.
Outbox or state alteration fails authentication.

## Transport

The default transport is disabled, leaving a durable `receipt_queued` outbox.
Tests may inject a synchronous idempotent sink. HTTP configuration requires an
HTTPS endpoint from the configured environment variable, but this release does
not perform live HTTP: dispatch fails closed and leaves the receipt queued until
an audited Fabric transport is integrated.

## Configuration

```json
{
  "amfCurator": {
    "version": "amf-curator-policy/v1",
    "autoPromote": false,
    "ledgerKeyEnv": "PAM_CURATOR_LEDGER_KEY",
    "stateDirEnv": "PAM_CURATOR_STATE_DIR",
    "reviewerTokenEnv": "PAM_CURATOR_REVIEWER_TOKEN",
    "reviewers": [{
      "tokenSha256": "<sha256>",
      "actorId": "service:memory-curator",
      "capabilities": ["memory:curate"]
    }],
    "gitWriter": { "enabled": false, "dryRunOnly": true }
  },
  "amfApplicator": {
    "version": "amf-receipt-applicator/v1",
    "tokenEnv": "PAM_APPLICATOR_TOKEN",
    "applicators": [{
      "tokenSha256": "<sha256>",
      "actorId": "service:memory-applicator",
      "capabilities": ["memory:apply-receipt"]
    }],
    "transport": {
      "kind": "disabled",
      "endpointEnv": "PAM_FABRIC_RECEIPT_ENDPOINT"
    }
  }
}
```

The Git writer remains disabled and dry-run-only. It cannot push, write a
protected branch, merge, or deploy.

## CLI and MCP

```bash
npm run memory:curator -- submit --input candidate.json
npm run memory:curator -- review --input review.json
npm run memory:curator -- apply --input application.json
npm run memory:curator -- status
npm run memory:curator -- recover --input recovery.json
npm run memory:curator -- git-plan --input git-plan.json
```

MCP adds `memory_receipt_apply` alongside `memory_curator_submit`,
`memory_curator_review`, `memory_curator_status`, `memory_curator_recover`, and
`memory_curator_git_plan`. Curator recovery supports only `advance-anchor` and
`recover-review`; apply recovery is the applicator's exact retry path.

## Recovery checks

1. Stop on an invalid candidate/review/receipt MAC, ledger chain, anchor, state,
   or outbox.
2. Retry candidate or review writes with the exact original input.
3. Use `advance-anchor` only for a verified strict-prefix anchor.
4. Retry application with the exact `decisionId` and idempotency key. PAM's
   proposal/archive checks determine whether to apply or recover.
5. Never delete ledgers, sentinels, state, or outbox files to clear an error.
6. Treat commit, push, PR, deploy, restart, and live transport as separate
   approval gates.

Validation:

```bash
node --test tools/test-memory-curator.mjs
npm test
npm run migrations:check
npm run mcp:smoke
git diff --check
```
