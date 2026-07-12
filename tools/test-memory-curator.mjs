import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  appendDecisionEvent,
  curatorStatus,
  planCuratorGitWrite,
  readDecisionLedger,
  recoverCuratorLedger,
  reviewCuratorCandidate,
  submitCuratorCandidate
} from "./lib/memory-curator.mjs";
import { applyDecisionReceipt } from "./lib/memory-receipt-applicator.mjs";
import { canonicalize, parseMemoryRecord } from "./lib/amf-memory-record.mjs";

const IDS = {
  first: "mem_11111111-1111-4111-8111-111111111111",
  second: "mem_99999999-9999-4999-8999-999999999999",
  agent: "agent:22222222-2222-4222-8222-222222222222"
};

const LEDGER_KEY = "synthetic-ledger-key-material-00000000000000000000000000000001";
const REVIEWER_TOKEN = "synthetic-reviewer-capability-token-0001";
const APPLICATOR_TOKEN = "synthetic-applicator-capability-token-0001";
const APPLICATOR_STATE_KEY = "synthetic-applicator-state-key-0000000000000000000001";
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pam-curator-state-"));
fs.chmodSync(STATE_DIR, 0o700);
process.env.PAM_CURATOR_LEDGER_KEY = LEDGER_KEY;
process.env.PAM_CURATOR_REVIEWER_TOKEN = REVIEWER_TOKEN;
process.env.PAM_APPLICATOR_TOKEN = APPLICATOR_TOKEN;
process.env.PAM_APPLICATOR_STATE_KEY = APPLICATOR_STATE_KEY;
process.env.PAM_CURATOR_STATE_DIR = STATE_DIR;
const reviewerTokenSha256 = crypto.createHash("sha256").update(REVIEWER_TOKEN).digest("hex");
const applicatorTokenSha256 = crypto.createHash("sha256").update(APPLICATOR_TOKEN).digest("hex");

const defaultConfig = {
  protectedPaths: ["AGENTS.md", "memory/agent-memory", "memory/sources"],
  amfCurator: {
    version: "amf-curator-policy/v1",
    autoPromote: false,
    minimumConfidence: 0.98,
    autoScopes: ["shared"],
    autoVisibilities: ["shared"],
    requireReviewForLifecycleChange: true,
    requireReviewForSupersession: true,
    rejectOnWarnings: true,
    ledgerKeyEnv: "PAM_CURATOR_LEDGER_KEY",
    stateDirEnv: "PAM_CURATOR_STATE_DIR",
    reviewerTokenEnv: "PAM_CURATOR_REVIEWER_TOKEN",
    reviewers: [{
      tokenSha256: reviewerTokenSha256,
      actorId: "service:synthetic-reviewer",
      capabilities: ["memory:curate"]
    }],
    gitWriter: { enabled: false, dryRunOnly: true, protectedBranches: ["main", "master", "main-integration"] }
  },
  amfApplicator: {
    version: "amf-receipt-applicator/v1",
    tokenEnv: "PAM_APPLICATOR_TOKEN",
    stateKeyEnv: "PAM_APPLICATOR_STATE_KEY",
    recordIndexPath: "memory/amf/record-index.json",
    applicators: [{
      tokenSha256: applicatorTokenSha256,
      actorId: "service:synthetic-applicator",
      capabilities: ["memory:apply-receipt"]
    }],
    transport: { kind: "disabled", endpointEnv: "PAM_FABRIC_RECEIPT_ENDPOINT" }
  }
};

const ledger = (root) => readDecisionLedger(root, Buffer.from(LEDGER_KEY));
function statePaths(root, stateDir = STATE_DIR) {
  const workspaceId = crypto.createHash("sha256").update(fs.realpathSync(root)).digest("hex");
  return {
    root: stateDir,
    workspaceId,
    anchorPath: path.join(stateDir, `${workspaceId}.anchor.json`),
    initializedPath: path.join(stateDir, `${workspaceId}.initialized.json`),
    workspaceSentinelPath: path.join(root, "memory/amf/curator.initialized.json")
  };
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-curator-"));
  fs.mkdirSync(path.join(root, "memory", "graph"), { recursive: true });
  for (const name of ["nodes.jsonl", "edges.jsonl", "aliases.jsonl"]) {
    fs.writeFileSync(path.join(root, "memory", "graph", name), "", "utf8");
  }
  return root;
}

function metadata(overrides = {}) {
  return {
    schema: "amf-memory/v1",
    id: IDS.first,
    revision: 1,
    claimType: "decision",
    scope: { type: "shared", id: "shared:global" },
    visibility: "shared",
    confidence: { score: 0.99, basis: "reviewed", assessedAt: "2026-07-11T10:00:00Z" },
    subjects: [{ identityId: IDS.agent, role: "owner" }],
    claim: { encoding: "plain", text: "Use deterministic, reviewable memory promotion." },
    lifecycle: {
      status: "active",
      validFrom: "2026-07-11T10:00:00Z",
      validTo: null,
      supersedes: [],
      revokedAt: null,
      revocationReason: null
    },
    provenance: [{
      sourceType: "synthetic-test",
      sourceId: "session-stable-0001",
      eventId: "event-stable-0001",
      contentSha256: "a".repeat(64),
      capturedAt: "2026-07-11T10:00:00Z"
    }],
    createdAt: "2026-07-11T10:00:00Z",
    updatedAt: "2026-07-11T10:00:00Z",
    ...overrides
  };
}

function render(record, body = "") {
  return `---\n${Object.entries(record).map(([key, value]) => {
    const rendered = value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
    return `${key}: ${rendered}`;
  }).join("\n")}\n---\n${body}`;
}

function submission(content = render(metadata()), overrides = {}) {
  return {
    content,
    rationale: "Synthetic reviewed candidate.",
    idempotencyKey: "synthetic-candidate-key-0001",
    confidence: 0.99,
    source: { type: "synthetic-test", id: "session-stable-0001" },
    ...overrides
  };
}

function applyApproved(root, decisionId, idempotencyKey = "synthetic-apply-key-0001", runtime = {}, config = defaultConfig) {
  return applyDecisionReceipt(root, config, { decisionId, idempotencyKey }, runtime);
}

test("default policy queues deterministically, redacts status, and makes retry idempotent", () => {
  const root = workspace();
  const first = submitCuratorCandidate(root, defaultConfig, submission());
  assert.equal(first.ok, true, first.error);
  assert.equal(first.status, "review_required");
  assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${IDS.first}.md`)), false);

  const again = submitCuratorCandidate(root, defaultConfig, submission());
  assert.equal(again.ok, true, again.error);
  assert.equal(again.candidateId, first.candidateId);
  assert.equal(again.decisionId, first.decisionId);
  assert.equal(again.duplicateSubmission, true);
  const ledgerState = ledger(root);
  assert.equal(ledgerState.ok, true, ledgerState.error);
  assert.equal(ledgerState.events.length, 2);
  const ledgerText = fs.readFileSync(path.join(root, "memory/amf/curator/decisions.jsonl"), "utf8");
  assert.equal(ledgerText.includes("deterministic, reviewable"), false);

  const status = curatorStatus(root, defaultConfig);
  assert.equal(status.ok, true, status.error);
  assert.equal(status.candidates.length, 1);
  assert.deepEqual(status.candidates[0].record.confidence, metadata().confidence);
  assert.equal(JSON.stringify(status).includes("deterministic, reviewable"), false);

  const conflict = submitCuratorCandidate(root, defaultConfig, submission(render(metadata({
    claim: { encoding: "plain", text: "Different payload under the same key." }
  }))));
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /idempotency conflict/);
});

test("curator derives candidate confidence from the record without granting scope or authority", () => {
  const mismatchRoot = workspace();
  const lowRecord = metadata({
    confidence: { score: 0.4, basis: "inferred", assessedAt: "2026-07-11T10:00:00Z" }
  });
  const mismatch = submitCuratorCandidate(mismatchRoot, defaultConfig, submission(render(lowRecord), {
    confidence: 0.99,
    idempotencyKey: "confidence-mismatch-0001"
  }));
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /exactly match record\.confidence\.score/);

  const scopedRoot = workspace();
  const scopedConfig = structuredClone(defaultConfig);
  scopedConfig.amfCurator.autoPromote = true;
  scopedConfig.amfCurator.autoScopes = ["domain"];
  const scoped = submitCuratorCandidate(scopedRoot, scopedConfig, submission(undefined, {
    idempotencyKey: "confidence-cannot-widen-scope-0001"
  }));
  assert.equal(scoped.ok, true, scoped.error);
  assert.equal(scoped.status, "review_required");
  assert.ok(scoped.policy.reasons.includes("scope-requires-review"));
  assert.equal(fs.existsSync(path.join(scopedRoot, `memory/amf/records/${IDS.first}.md`)), false);
});

test("explicit high-confidence policy approves but cannot bypass the applicator", () => {
  const root = workspace();
  const config = structuredClone(defaultConfig);
  config.amfCurator.autoPromote = true;
  const result = submitCuratorCandidate(root, config, submission());
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, "approved_pending_apply");
  const canonical = path.join(root, `memory/amf/records/${IDS.first}.md`);
  assert.equal(fs.existsSync(canonical), false);
  const appliedResult = applyApproved(root, result.decisionId, "synthetic-apply-key-0001", {}, config);
  assert.equal(appliedResult.ok, true, appliedResult.error);
  assert.equal(appliedResult.status, "receipt_queued");
  assert.equal(fs.existsSync(canonical), true);
  assert.equal(fs.readFileSync(canonical, "utf8"), submission().content);
  const proposalDir = path.join(root, "memory", "maintenance", "proposals");
  const applied = fs.readdirSync(proposalDir).filter((name) => name.endsWith(".applied.json"));
  assert.equal(applied.length, 1);
  const archive = JSON.parse(fs.readFileSync(path.join(proposalDir, applied[0]), "utf8"));
  assert.equal(archive.status, "applied");
  assert.match(archive.source, /^pam-amf-applicator:candidate-/);
  const ledgerState = ledger(root);
  assert.deepEqual(ledgerState.events.map((event) => event.type), ["candidate-received", "decision-recorded"]);

  const retry = submitCuratorCandidate(root, config, submission());
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.status, "approved_pending_apply");
  assert.equal(fs.readdirSync(proposalDir).filter((name) => name.endsWith(".applied.json")).length, 1);
  assert.equal(ledger(root).events.length, 2);
});

test("manual rejection is reversible by a later versioned approval", () => {
  const root = workspace();
  const queued = submitCuratorCandidate(root, defaultConfig, submission());
  const rejected = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: queued.candidateId,
    action: "reject",
    rationale: "Evidence needs a human check.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "manual-reject-0001",
    confidence: 0.7
  });
  assert.equal(rejected.ok, true, rejected.error);
  assert.equal(rejected.status, "rejected");
  assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${IDS.first}.md`)), false);

  const approved = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: queued.candidateId,
    action: "approve",
    rationale: "Independent evidence was verified.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "manual-approve-0001",
    confidence: 0.99
  });
  assert.equal(approved.ok, true, approved.error);
  assert.equal(approved.status, "approved_pending_apply");
  const applied = applyApproved(root, approved.decisionId, "manual-approved-apply-0001");
  assert.equal(applied.ok, true, applied.error);
  assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${IDS.first}.md`)), true);
  const reviews = fs.readdirSync(path.join(root, "memory/amf/curator/reviews"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(root, "memory/amf/curator/reviews", name), "utf8")));
  const approveReview = reviews.find((review) => review.decisionId === approved.decisionId);
  assert.equal(approveReview.supersedesDecisionId, rejected.decisionId);

  const retry = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: queued.candidateId,
    action: "approve",
    rationale: "Independent evidence was verified.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "manual-approve-0001",
    confidence: 0.99
  });
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.decisionId, approved.decisionId);
});

test("revoke and superseding correction are proposal-driven and preserve history", () => {
  const root = workspace();
  const autoConfig = { ...defaultConfig, amfCurator: { ...defaultConfig.amfCurator, autoPromote: true } };
  const created = submitCuratorCandidate(root, autoConfig, submission());
  assert.equal(created.ok, true, created.error);
  assert.equal(applyApproved(root, created.decisionId, "initial-record-apply-0001", {}, autoConfig).ok, true);

  const revokedMetadata = metadata({
    revision: 2,
    updatedAt: "2026-07-11T11:00:00Z",
    lifecycle: {
      ...metadata().lifecycle,
      status: "revoked",
      revokedAt: "2026-07-11T11:00:00Z",
      revocationReason: "The source was corrected."
    },
    provenance: [
      ...metadata().provenance,
      {
        sourceType: "synthetic-review",
        sourceId: "review-stable-0002",
        eventId: "event-stable-0002",
        contentSha256: "b".repeat(64),
        capturedAt: "2026-07-11T11:00:00Z"
      }
    ]
  });
  const revokeCandidate = submitCuratorCandidate(root, defaultConfig, submission(render(revokedMetadata), {
    idempotencyKey: "synthetic-revoke-key-0001",
    source: { type: "synthetic-review", id: "review-stable-0002" }
  }));
  assert.equal(revokeCandidate.ok, true, revokeCandidate.error);
  assert.equal(revokeCandidate.status, "review_required");
  const revoked = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: revokeCandidate.candidateId,
    action: "approve",
    rationale: "Verified correction revokes the old record.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "approve-revoke-0001"
  });
  assert.equal(revoked.ok, true, revoked.error);
  assert.equal(applyApproved(root, revoked.decisionId, "revoke-record-apply-0001").ok, true);
  const current = fs.readFileSync(path.join(root, `memory/amf/records/${IDS.first}.md`), "utf8");
  assert.match(current, /"status":"revoked"/);

  const corrected = metadata({
    id: IDS.second,
    claim: { encoding: "plain", text: "Use reviewed, deterministic memory promotion." },
    confidence: { score: 0.99, basis: "reviewed", assessedAt: "2026-07-11T12:00:00Z" },
    lifecycle: { ...metadata().lifecycle, supersedes: [IDS.first] },
    provenance: [{
      sourceType: "synthetic-review",
      sourceId: "review-stable-0003",
      eventId: "event-stable-0003",
      contentSha256: "c".repeat(64),
      capturedAt: "2026-07-11T12:00:00Z"
    }],
    createdAt: "2026-07-11T12:00:00Z",
    updatedAt: "2026-07-11T12:00:00Z"
  });
  const correction = submitCuratorCandidate(root, defaultConfig, submission(render(corrected), {
    idempotencyKey: "synthetic-correction-key-0001",
    source: { type: "synthetic-review", id: "review-stable-0003" }
  }));
  assert.equal(correction.ok, true, correction.error);
  assert.equal(correction.status, "review_required");
  const appliedCorrection = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: correction.candidateId,
    action: "approve",
    rationale: "The correction is source-backed and keeps the revoked record for audit.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "approve-correction-0001"
  });
  assert.equal(appliedCorrection.ok, true, appliedCorrection.error);
  assert.equal(applyApproved(root, appliedCorrection.decisionId, "correction-record-apply-0001").ok, true);
  assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${IDS.first}.md`)), true);
  assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${IDS.second}.md`)), true);
});

test("semantic/provenance duplicates are routed without canonical writes", () => {
  const root = workspace();
  const config = structuredClone(defaultConfig);
  config.amfCurator.autoPromote = true;
  const first = submitCuratorCandidate(root, config, submission());
  assert.equal(first.status, "approved_pending_apply");
  assert.equal(applyApproved(root, first.decisionId, "duplicate-seed-apply-0001", {}, config).ok, true);
  const sameFact = metadata({ id: IDS.second });
  const duplicate = submitCuratorCandidate(root, config, submission(render(sameFact), {
    idempotencyKey: "synthetic-duplicate-key-0001"
  }));
  assert.equal(duplicate.ok, true, duplicate.error);
  assert.equal(duplicate.status, "review_required");
  assert.match(duplicate.duplicateOf.kind, /^canonical-/);
  assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${IDS.second}.md`)), false);
});

test("ledger detects tampering", () => {
  const root = workspace();
  submitCuratorCandidate(root, defaultConfig, submission());
  const ledgerPath = path.join(root, "memory/amf/curator/decisions.jsonl");
  const rows = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").map(JSON.parse);
  rows[0].details.recordId = IDS.second;
  fs.writeFileSync(ledgerPath, `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");
  const ledgerState = ledger(root);
  assert.equal(ledgerState.ok, false);
  assert.match(ledgerState.error, /schema|authentication/);
  const status = curatorStatus(root, defaultConfig);
  assert.equal(status.ok, false);
});

test("Git writer is disabled by default and refuses protected branches or push", () => {
  assert.equal(planCuratorGitWrite(defaultConfig, { branch: "amf/curated" }).status, "disabled");
  const enabled = structuredClone(defaultConfig);
  enabled.amfCurator.gitWriter.enabled = true;
  assert.match(planCuratorGitWrite(enabled, { branch: "main" }).error, /protected branch/);
  assert.match(planCuratorGitWrite(enabled, { branch: "amf/curated", push: true }).error, /refuses direct push/);
  assert.match(planCuratorGitWrite(enabled, { branch: "amf/curated", dryRun: false }).error, /dry-run/);
  const plan = planCuratorGitWrite(enabled, { branch: "amf/curated" });
  assert.equal(plan.ok, true);
  assert.equal(plan.status, "dry-run");
  assert.ok(plan.excludedOperations.includes("direct-main-write"));
});

test("curator rejects RAW-shaped source input and symlinked artifact paths", () => {
  const root = workspace();
  const raw = submitCuratorCandidate(root, defaultConfig, submission(undefined, {
    source: { type: "synthetic-test", id: "session-stable-0001", transcript: "RAW secret" }
  }));
  assert.equal(raw.ok, false);
  assert.match(raw.error, /RAW payloads/);

  const symlinkRoot = workspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pam-curator-outside-"));
  fs.mkdirSync(path.join(symlinkRoot, "memory", "amf"), { recursive: true });
  fs.symlinkSync(outside, path.join(symlinkRoot, "memory", "amf", "curator"));
  assert.throws(() => submitCuratorCandidate(symlinkRoot, defaultConfig, submission()), /symlink/);
});

test("authoritative operations fail closed without the external ledger key", (t) => {
  const root = workspace();
  const previous = process.env.PAM_CURATOR_LEDGER_KEY;
  delete process.env.PAM_CURATOR_LEDGER_KEY;
  t.after(() => { process.env.PAM_CURATOR_LEDGER_KEY = previous; });
  const submitted = submitCuratorCandidate(root, defaultConfig, submission());
  assert.equal(submitted.ok, false);
  assert.match(submitted.error, /authoritative curator operation requires/);
  assert.equal(fs.existsSync(path.join(root, "memory/amf/curator")), false);
  const status = curatorStatus(root, defaultConfig);
  assert.equal(status.ok, false);
  assert.equal(status.status, "unhealthy");
  assert.deepEqual(status.candidates, []);
});

test("ledger HMAC and external anchor detect forgery and suffix truncation", () => {
  const forgedRoot = workspace();
  submitCuratorCandidate(forgedRoot, defaultConfig, submission());
  const forgedPath = path.join(forgedRoot, "memory/amf/curator/decisions.jsonl");
  const forgedRows = fs.readFileSync(forgedPath, "utf8").trim().split("\n").map(JSON.parse);
  forgedRows[0].details.sourceIdSha256 = "f".repeat(64);
  forgedRows[0].eventMac = crypto.createHash("sha256").update(JSON.stringify(forgedRows[0])).digest("hex");
  fs.writeFileSync(forgedPath, `${forgedRows.map(JSON.stringify).join("\n")}\n`, "utf8");
  const forged = ledger(forgedRoot);
  assert.equal(forged.ok, false);
  assert.match(forged.error, /authentication|schema/);

  const truncatedRoot = workspace();
  submitCuratorCandidate(truncatedRoot, defaultConfig, submission());
  const truncatedPath = path.join(truncatedRoot, "memory/amf/curator/decisions.jsonl");
  const lines = fs.readFileSync(truncatedPath, "utf8").trim().split("\n");
  fs.writeFileSync(truncatedPath, `${lines[0]}\n`, "utf8");
  const truncated = ledger(truncatedRoot);
  assert.equal(truncated.ok, false);
  assert.match(truncated.error, /truncation|anchor/);
});

test("a missing anchor on a non-empty ledger fails closed and is never auto-reanchored", () => {
  const root = workspace();
  submitCuratorCandidate(root, defaultConfig, submission());
  const anchorPath = statePaths(root).anchorPath;
  fs.rmSync(anchorPath);
  assert.equal(curatorStatus(root, defaultConfig).status, "unhealthy");
  const retry = submitCuratorCandidate(root, defaultConfig, submission());
  assert.equal(retry.ok, false);
  assert.match(retry.error, /partial|anchor|manual recovery/);
  assert.equal(fs.existsSync(anchorPath), false);
});

test("status rejects mutated candidate artifacts and returns no candidate data", () => {
  const root = workspace();
  const submitted = submitCuratorCandidate(root, defaultConfig, submission());
  const artifactPath = path.join(root, submitted.candidatePath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  artifact.record.claimType = "RAW-MARKER-FORGED";
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const status = curatorStatus(root, defaultConfig);
  assert.equal(status.ok, false);
  assert.equal(status.status, "unhealthy");
  assert.deepEqual(status.candidates, []);
  assert.equal(JSON.stringify(status).includes("RAW-MARKER-FORGED"), false);
});

test("applicator receipt binds the exact archive and canonical target", () => {
  const root = workspace();
  const queued = submitCuratorCandidate(root, defaultConfig, submission());
  const approved = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: queued.candidateId,
    action: "approve",
    rationale: "The exact record was reviewed.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "receipt-binding-review-0001"
  });
  const applied = applyApproved(root, approved.decisionId, "receipt-binding-apply-0001");
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.receipt.archiveDigest.length, 64);
  assert.equal(applied.receipt.targetDigest, crypto.createHash("sha256").update(canonicalize(parseMemoryRecord(submission().content).metadata)).digest("hex"));
  assert.equal(applied.receipt.decisionDigest, approved.decisionDigest);
  assert.equal(applied.receipt.canonicalLifecycleAtDecision, "active");
});

test("manual decisions require a server-side allowlisted reviewer capability", (t) => {
  const root = workspace();
  const submitted = submitCuratorCandidate(root, defaultConfig, submission());
  const previous = process.env.PAM_CURATOR_REVIEWER_TOKEN;
  delete process.env.PAM_CURATOR_REVIEWER_TOKEN;
  t.after(() => { process.env.PAM_CURATOR_REVIEWER_TOKEN = previous; });
  const rejected = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: submitted.candidateId,
    action: "reject",
    rationale: "Declarative reviewer text is not authority.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "unauthorized-review-0001"
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /capability/);
  assert.equal(curatorStatus(root, defaultConfig, {}, { reviewerToken: previous }).candidates[0].decisions, 1);
});

test("curator and applicator credentials cannot substitute for one another", () => {
  const root = workspace();
  const submitted = submitCuratorCandidate(root, defaultConfig, submission());
  const wrongCurator = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: submitted.candidateId,
    action: "approve",
    rationale: "Wrong credential must fail.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "wrong-curator-token-0001"
  }, { reviewerToken: APPLICATOR_TOKEN });
  assert.equal(wrongCurator.ok, false);
  assert.match(wrongCurator.error, /unauthorized/);

  const approved = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: submitted.candidateId,
    action: "approve",
    rationale: "Correct curator credential approves only.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "separate-capability-review-0001"
  });
  const wrongApplicator = applyDecisionReceipt(root, defaultConfig, {
    decisionId: approved.decisionId,
    idempotencyKey: "wrong-applicator-token-0001"
  }, { applicatorToken: REVIEWER_TOKEN });
  assert.equal(wrongApplicator.ok, false);
  assert.match(wrongApplicator.error, /memory:apply-receipt/);
});

test("HTTP transport fails closed and preserves the queued receipt", (t) => {
  const root = workspace();
  const submitted = submitCuratorCandidate(root, defaultConfig, submission());
  const approved = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: submitted.candidateId,
    action: "approve",
    rationale: "Queue until Fabric transport is audited.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "http-fail-closed-review-0001"
  });
  const config = structuredClone(defaultConfig);
  config.amfApplicator.transport.kind = "http";
  const previous = process.env.PAM_FABRIC_RECEIPT_ENDPOINT;
  delete process.env.PAM_FABRIC_RECEIPT_ENDPOINT;
  t.after(() => {
    if (previous === undefined) delete process.env.PAM_FABRIC_RECEIPT_ENDPOINT;
    else process.env.PAM_FABRIC_RECEIPT_ENDPOINT = previous;
  });
  const input = { decisionId: approved.decisionId, idempotencyKey: "http-fail-closed-apply-0001", dispatch: true };
  const refused = applyDecisionReceipt(root, config, input);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "receipt_queued");
  assert.match(refused.error, /missing or not HTTPS/);
  const queued = applyDecisionReceipt(root, config, { ...input, dispatch: false });
  assert.equal(queued.ok, true, queued.error);
  assert.equal(queued.status, "receipt_queued");
});

test("CLI apply routes an approved decision through the receipt applicator", () => {
  const root = workspace();
  const submitted = submitCuratorCandidate(root, defaultConfig, submission(undefined, {
    idempotencyKey: "cli-route-candidate-0001"
  }));
  const approved = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: submitted.candidateId,
    action: "approve",
    rationale: "Exercise CLI applicator routing.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "cli-route-decision-0001"
  });
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  const cliConfig = JSON.parse(fs.readFileSync(
    fileURLToPath(new URL("./memory-maintenance.config.json", import.meta.url)),
    "utf8"
  ));
  cliConfig.protectedPaths = defaultConfig.protectedPaths;
  cliConfig.amfCurator = defaultConfig.amfCurator;
  cliConfig.amfApplicator = defaultConfig.amfApplicator;
  fs.writeFileSync(
    path.join(root, "tools", "memory-maintenance.config.json"),
    `${JSON.stringify(cliConfig, null, 2)}\n`,
    "utf8"
  );
  const inputPath = path.join(root, "application.json");
  fs.writeFileSync(inputPath, `${JSON.stringify({
    decisionId: approved.decisionId,
    idempotencyKey: "cli-route-apply-0001"
  })}\n`, "utf8");
  const cli = spawnSync(process.execPath, [
    fileURLToPath(new URL("./memory-curator.mjs", import.meta.url)),
    "apply",
    "--input",
    inputPath,
    "--workspace",
    root
  ], { encoding: "utf8", env: process.env });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, "receipt_queued");
  assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${IDS.first}.md`)), true);
});

test("ledger and status never expose RAW markers or reviewer/source identifiers", () => {
  const marker = "RAW-MARKER-SHOULD-NOT-LEAK";
  const root = workspace();
  const record = metadata({ claim: { encoding: "plain", text: `Shared fact ${marker}.` } });
  const submitted = submitCuratorCandidate(root, defaultConfig, submission(render(record), {
    rationale: `Evidence rationale ${marker}`,
    source: { type: "synthetic-test", id: `source-${marker}` }
  }));
  const reviewed = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: submitted.candidateId,
    action: "reject",
    rationale: `Review rationale ${marker}`,
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "raw-marker-review-0001"
  });
  assert.equal(reviewed.ok, true, reviewed.error);
  const ledgerText = fs.readFileSync(path.join(root, "memory/amf/curator/decisions.jsonl"), "utf8");
  const statusText = JSON.stringify(curatorStatus(root, defaultConfig));
  assert.equal(ledgerText.includes(marker), false);
  assert.equal(statusText.includes(marker), false);
  assert.equal(ledgerText.includes("person:synthetic-reviewer"), false);
  assert.equal(ledgerText.includes(`source-${marker}`), false);
});

test("curator APIs enforce exact internal argument schemas", () => {
  const root = workspace();
  const extraSubmit = submitCuratorCandidate(root, defaultConfig, { ...submission(), rawPayload: "RAW" });
  assert.equal(extraSubmit.ok, false);
  assert.match(extraSubmit.error, /unknown fields/);
  const submitted = submitCuratorCandidate(root, defaultConfig, submission());
  const extraReview = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: submitted.candidateId,
    action: "reject",
    rationale: "Reject.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "strict-review-0001",
    capabilityToken: REVIEWER_TOKEN
  });
  assert.equal(extraReview.ok, false);
  assert.match(extraReview.error, /unknown fields/);
  assert.equal(curatorStatus(root, defaultConfig, { raw: true }).ok, false);
  assert.match(planCuratorGitWrite(defaultConfig, { branch: "amf/test", extra: true }).error, /unknown fields/);

  const state = ledger(root);
  const received = state.events.find((event) => event.type === "candidate-received");
  const forgedEvent = appendDecisionEvent(root, Buffer.from(LEDGER_KEY), statePaths(root), {
    eventId: "event-forged-extra-0001",
    occurredAt: new Date().toISOString(),
    type: "candidate-received",
    candidateId: submitted.candidateId,
    details: { ...received.details, arbitraryText: "RAW" }
  });
  assert.equal(forgedEvent.ok, false);
  assert.match(forgedEvent.error, /strict schema/);
});

test("deleting curator history cannot silently reset decision or applied state", () => {
  const config = structuredClone(defaultConfig);
  config.amfCurator.autoPromote = true;

  const anchoredRoot = workspace();
  submitCuratorCandidate(anchoredRoot, config, submission());
  fs.rmSync(path.join(anchoredRoot, "memory/amf/curator"), { recursive: true });
  const anchored = curatorStatus(anchoredRoot, config);
  assert.equal(anchored.ok, false);
  assert.equal(anchored.status, "unhealthy");
  assert.deepEqual(anchored.candidates, []);
  assert.match(anchored.error, /truncation|anchor/);

  const archiveRoot = workspace();
  const approved = submitCuratorCandidate(archiveRoot, config, submission());
  assert.equal(applyApproved(archiveRoot, approved.decisionId, "deleted-history-apply-0001", {}, config).ok, true);
  fs.rmSync(path.join(archiveRoot, "memory/amf/curator"), { recursive: true });
  const external = statePaths(archiveRoot);
  fs.rmSync(external.anchorPath);
  fs.rmSync(external.initializedPath);
  fs.rmSync(external.workspaceSentinelPath);
  const archiveCrossCheck = curatorStatus(archiveRoot, config);
  assert.equal(archiveCrossCheck.ok, false);
  assert.equal(archiveCrossCheck.status, "unhealthy");
  assert.deepEqual(archiveCrossCheck.candidates, []);
  assert.match(archiveCrossCheck.error, /initialized|history|sentinel|anchor|truncation/);
  assert.equal(fs.existsSync(path.join(archiveRoot, `memory/amf/records/${IDS.first}.md`)), true);
});

test("dedup and status fail closed on unverified queue or review artifacts", () => {
  const queueRoot = workspace();
  submitCuratorCandidate(queueRoot, defaultConfig, submission());
  const queuePath = path.join(queueRoot, "memory/amf/curator/queue/candidate-0000000000000000000000000000000000000000.json");
  fs.writeFileSync(queuePath, `${JSON.stringify({
    schema: "amf-curator/v1/candidate",
    candidateId: "candidate-0000000000000000000000000000000000000000",
    semanticFingerprint: "0".repeat(64),
    record: { id: IDS.second }
  })}\n`, "utf8");
  const second = metadata({
    id: IDS.second,
    claim: { encoding: "plain", text: "A second independently reviewed memory." },
    provenance: [{
      sourceType: "synthetic-test",
      sourceId: "session-stable-0002",
      eventId: "event-stable-0002",
      contentSha256: "b".repeat(64),
      capturedAt: "2026-07-11T10:00:00Z"
    }]
  });
  const dedup = submitCuratorCandidate(queueRoot, defaultConfig, submission(render(second), {
    idempotencyKey: "bogus-queue-probe-0001",
    source: { type: "synthetic-test", id: "session-stable-0002" }
  }));
  assert.equal(dedup.ok, false);
  assert.equal(dedup.status, "unhealthy");
  assert.match(dedup.error, /artifact|hash|candidateId/);

  const reviewRoot = workspace();
  const submitted = submitCuratorCandidate(reviewRoot, defaultConfig, submission());
  fs.writeFileSync(path.join(reviewRoot, "memory/amf/curator/reviews/decision-0000000000000000000000000000000000000000.json"), `${JSON.stringify({
    schema: "amf-curator/v1/review",
    decisionId: "decision-0000000000000000000000000000000000000000",
    candidateId: submitted.candidateId,
    action: "duplicate"
  })}\n`, "utf8");
  const indexed = curatorStatus(reviewRoot, defaultConfig);
  assert.equal(indexed.ok, false);
  assert.equal(indexed.status, "unhealthy");
  assert.deepEqual(indexed.candidates, []);
  assert.match(indexed.error, /review artifact/);
  const reviewDedup = submitCuratorCandidate(reviewRoot, defaultConfig, submission(render(second), {
    idempotencyKey: "bogus-review-probe-0001",
    source: { type: "synthetic-test", id: "session-stable-0002" }
  }));
  assert.equal(reviewDedup.ok, false);
  assert.equal(reviewDedup.status, "unhealthy");
  assert.match(reviewDedup.error, /review artifact/);
});

test("all ledger events HMAC record/source refs and enum-classify caller source types", () => {
  const marker = "RAWMARKER";
  const recordId = `mem_${marker}_1111111111111111`;
  const sourceType = "raw-marker-smuggle";
  const sourceId = `source-${marker}-private-ref`;
  const root = workspace();
  const config = structuredClone(defaultConfig);
  config.amfCurator.autoPromote = true;
  const record = metadata({
    id: recordId,
    claim: { encoding: "plain", text: `Shared ${marker} fact.` },
    provenance: [{
      sourceType,
      sourceId,
      eventId: "event-smuggle-0001",
      contentSha256: "d".repeat(64),
      capturedAt: "2026-07-11T10:00:00Z"
    }]
  });
  const promoted = submitCuratorCandidate(root, config, submission(render(record), {
    idempotencyKey: "smuggled-ledger-refs-0001",
    source: { type: sourceType, id: sourceId }
  }));
  assert.equal(promoted.ok, true, promoted.error);
  assert.equal(promoted.status, "approved_pending_apply");
  const ledgerText = fs.readFileSync(path.join(root, "memory/amf/curator/decisions.jsonl"), "utf8");
  for (const forbidden of [marker, recordId, sourceType, sourceId, "recordId", "sourceType", "targetPath"]) {
    assert.equal(ledgerText.includes(forbidden), false, `ledger leaked ${forbidden}`);
  }
  const events = ledger(root).events;
  assert.equal(events[0].details.sourceClass, "other");
  assert.match(events[0].details.recordRefHmac, /^[0-9a-f]{64}$/);
  assert.match(events[0].details.sourceRefHmac, /^[0-9a-f]{64}$/);
  assert.ok(events.every((event) => !JSON.stringify(event).includes(marker)));
});

test("boundary A crash recovers only from the exact MAC-authenticated submitted candidate", () => {
  const root = workspace();
  assert.throws(
    () => submitCuratorCandidate(root, defaultConfig, submission(), { faultAt: "after-candidate-write" }),
    /after candidate artifact fsync/
  );
  assert.equal(curatorStatus(root, defaultConfig).status, "unhealthy");
  const conflict = submitCuratorCandidate(root, defaultConfig, submission(render(metadata({
    claim: { encoding: "plain", text: "Different content under the crashed idempotency key." }
  }))));
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /idempotency conflict/);
  const recovered = submitCuratorCandidate(root, defaultConfig, submission());
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.status, "review_required");
  assert.equal(ledger(root).events.filter((event) => event.type === "candidate-received").length, 1);
});

test("boundary B crash requires admin forward recovery of an existing strict-prefix anchor", () => {
  const root = workspace();
  assert.throws(
    () => submitCuratorCandidate(root, defaultConfig, submission(), { faultAt: "after-ledger-append" }),
    /after ledger append before anchor replace/
  );
  const unhealthy = curatorStatus(root, defaultConfig);
  assert.equal(unhealthy.status, "unhealthy");
  assert.match(unhealthy.error, /anchor.*behind/);
  const ordinaryRetry = submitCuratorCandidate(root, defaultConfig, submission());
  assert.equal(ordinaryRetry.ok, false);
  assert.match(ordinaryRetry.error, /anchor.*behind/);
  const recovery = recoverCuratorLedger(root, defaultConfig, { action: "advance-anchor" });
  assert.equal(recovery.ok, true, recovery.error);
  assert.equal(recovery.status, "recovered");
  assert.equal(recovery.advancedBy, 1);
  const completed = submitCuratorCandidate(root, defaultConfig, submission());
  assert.equal(completed.ok, true, completed.error);
  assert.equal(completed.status, "review_required");
  assert.equal(recoverCuratorLedger(root, defaultConfig, { action: "advance-anchor" }).ok, false);
});

test("default policy review-fsync boundary converges only under the exact policy snapshot", () => {
  const root = workspace();
  assert.throws(
    () => submitCuratorCandidate(root, defaultConfig, submission(), { faultAt: "after-review-write" }),
    /after review artifact fsync before decision ledger event/
  );
  assert.equal(curatorStatus(root, defaultConfig).status, "unhealthy");

  const changedPolicy = structuredClone(defaultConfig);
  changedPolicy.amfCurator.minimumConfidence = 0.97;
  const changedRetry = submitCuratorCandidate(root, changedPolicy, submission());
  assert.equal(changedRetry.ok, false);
  assert.equal(changedRetry.status, "unhealthy");
  assert.match(changedRetry.error, /review|policy/);

  const recovered = submitCuratorCandidate(root, defaultConfig, submission());
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.status, "review_required");
  assert.equal(recovered.duplicateSubmission, true);
  const events = ledger(root).events.filter((event) => event.type === "decision-recorded");
  assert.equal(events.length, 1);
  assert.equal(events[0].details.action, "review");
  assert.equal(curatorStatus(root, defaultConfig).status, "healthy");
});

test("automatic policy review recovery rejects forged actor, action, and idempotency", () => {
  for (const [field, value] of [
    ["actorId", "service:forged-policy-actor"],
    ["action", "approve"],
    ["decisionKeySha256", "f".repeat(64)]
  ]) {
    const root = workspace();
    assert.throws(
      () => submitCuratorCandidate(root, defaultConfig, submission(), { faultAt: "after-review-write" }),
      /after review artifact fsync/
    );
    const reviewFile = path.join(
      root,
      "memory/amf/curator/reviews",
      fs.readdirSync(path.join(root, "memory/amf/curator/reviews"))[0]
    );
    const artifact = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
    artifact[field] = value;
    fs.writeFileSync(reviewFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const refused = submitCuratorCandidate(root, defaultConfig, submission());
    assert.equal(refused.ok, false, field);
    assert.equal(refused.status, "unhealthy", field);
    assert.match(refused.error, /invalid|unlogged|conflict|policy|authentication/, field);
    assert.equal(curatorStatus(root, defaultConfig).status, "unhealthy", field);
  }
});

test("auto-approval review-fsync converges without invoking the applicator", () => {
  const config = structuredClone(defaultConfig);
  config.amfCurator.autoPromote = true;

  const reviewRoot = workspace();
  assert.throws(
    () => submitCuratorCandidate(reviewRoot, config, submission(), { faultAt: "after-review-write" }),
    /after review artifact fsync/
  );
  assert.equal(curatorStatus(reviewRoot, config).status, "unhealthy");
  const reviewRecovered = submitCuratorCandidate(reviewRoot, config, submission());
  assert.equal(reviewRecovered.ok, true, reviewRecovered.error);
  assert.equal(reviewRecovered.status, "approved_pending_apply");
  assert.equal(reviewRecovered.status, "approved_pending_apply");
  assert.equal(curatorStatus(reviewRoot, config).status, "healthy");

  assert.equal(fs.existsSync(path.join(reviewRoot, `memory/amf/records/${IDS.first}.md`)), false);
});

test("applicator recovers every durable boundary with exact idempotency", () => {
  for (const faultAt of ["after-prepared", "after-pam-apply", "after-pam-applied-state", "after-receipt-queued"]) {
    const root = workspace();
    const queued = submitCuratorCandidate(root, defaultConfig, submission(undefined, {
      idempotencyKey: `candidate-${faultAt}-0001`
    }));
    const approved = reviewCuratorCandidate(root, defaultConfig, {
      candidateId: queued.candidateId,
      action: "approve",
      rationale: `Approved for ${faultAt}.`,
      reviewer: "person:synthetic-reviewer",
      idempotencyKey: `decision-${faultAt}-0001`
    });
    const applyInput = { decisionId: approved.decisionId, idempotencyKey: `apply-${faultAt}-0001` };
    assert.throws(
      () => applyDecisionReceipt(root, defaultConfig, applyInput, { faultAt }),
      /injected applicator fault/
    );
    const recovered = applyDecisionReceipt(root, defaultConfig, applyInput);
    assert.equal(recovered.ok, true, `${faultAt}: ${recovered.error}`);
    assert.equal(recovered.status, "receipt_queued", faultAt);
    assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${IDS.first}.md`)), true, faultAt);
    assert.equal(fs.readdirSync(path.join(root, "memory/amf/applicator/outbox")).length, 1, faultAt);
  }
});

test("applicator refuses a valid proposal altered after prepared state", () => {
  const root = workspace();
  const queued = submitCuratorCandidate(root, defaultConfig, submission(undefined, {
    idempotencyKey: "altered-after-prepared-candidate-0001"
  }));
  const approved = reviewCuratorCandidate(root, defaultConfig, {
    candidateId: queued.candidateId,
    action: "approve",
    rationale: "Prepared proposal must remain immutable.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "altered-after-prepared-decision-0001"
  });
  const input = { decisionId: approved.decisionId, idempotencyKey: "altered-after-prepared-apply-0001" };
  assert.throws(
    () => applyDecisionReceipt(root, defaultConfig, input, { faultAt: "after-prepared" }),
    /after prepared state/
  );
  const proposalDir = path.join(root, "memory", "maintenance", "proposals");
  const proposalName = fs.readdirSync(proposalDir).find((name) => /^proposal-.*\.json$/.test(name));
  const proposalPath = path.join(proposalDir, proposalName);
  const proposal = JSON.parse(fs.readFileSync(proposalPath, "utf8"));
  proposal.rationale = "Valid proposal, altered after the prepared digest.";
  fs.writeFileSync(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");

  const refused = applyDecisionReceipt(root, defaultConfig, input);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /immutable proposal digest conflict/);
  assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${IDS.first}.md`)), false);
  assert.equal(fs.readdirSync(proposalDir).some((name) => name.endsWith(".applied.json")), false);
});

test("review fsync boundary recovers only the exact authenticated candidate-version decision", () => {
  const root = workspace();
  const queued = submitCuratorCandidate(root, defaultConfig, submission());
  const review = {
    candidateId: queued.candidateId,
    action: "reject",
    rationale: "Boundary review was checked independently.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "review-boundary-reject-0001",
    confidence: 0.81
  };
  assert.throws(
    () => reviewCuratorCandidate(root, defaultConfig, review, { faultAt: "after-review-write" }),
    /after review artifact fsync before decision ledger event/
  );
  const unhealthy = curatorStatus(root, defaultConfig);
  assert.equal(unhealthy.ok, false);
  assert.equal(unhealthy.status, "unhealthy");
  assert.deepEqual(unhealthy.candidates, []);
  assert.match(unhealthy.error, /review/);

  const unrelated = reviewCuratorCandidate(root, defaultConfig, {
    ...review,
    rationale: "A different decision must not claim the crashed artifact."
  });
  assert.equal(unrelated.ok, false);
  assert.equal(unrelated.status, "unhealthy");
  assert.match(unrelated.error, /idempotency|candidate-version/);

  const recovered = reviewCuratorCandidate(root, defaultConfig, review);
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.status, "rejected");
  assert.equal(ledger(root).events.filter((event) => event.decisionId === recovered.decisionId).length, 1);
  const healthy = curatorStatus(root, defaultConfig);
  assert.equal(healthy.ok, true, healthy.error);
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.candidates[0].latestDecision.outcome, "rejected");
});

test("Fabric ack boundary retries through an idempotent injected sink", () => {
  const root = workspace();
  const queued = submitCuratorCandidate(root, defaultConfig, submission());
  const review = {
    candidateId: queued.candidateId,
    action: "approve",
    rationale: "The exact candidate and source evidence were verified.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "apply-boundary-approve-0001",
    confidence: 0.99
  };
  const approved = reviewCuratorCandidate(root, defaultConfig, review);
  const seen = new Set();
  const sink = (receipt) => {
    seen.add(receipt.applyId);
    return { ok: true, ackId: `ack-${receipt.applyId}`, acknowledgedAt: "2026-07-12T10:00:00Z" };
  };
  const input = { decisionId: approved.decisionId, idempotencyKey: "fabric-ack-apply-0001", dispatch: true };
  assert.throws(
    () => applyDecisionReceipt(root, defaultConfig, input, { transportSink: sink, faultAt: "after-fabric-ack" }),
    /after Fabric ack/
  );
  const recovered = applyDecisionReceipt(root, defaultConfig, input, { transportSink: sink });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.status, "fabric_acked");
  assert.equal(seen.size, 1);
});

test("admin review recovery and applicator outbox reject altered artifacts", () => {
  const reviewRoot = workspace();
  const queued = submitCuratorCandidate(reviewRoot, defaultConfig, submission());
  const review = {
    candidateId: queued.candidateId,
    action: "reject",
    rationale: "Admin boundary review is exact.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "admin-review-boundary-0001",
    confidence: 0.76
  };
  assert.throws(
    () => reviewCuratorCandidate(reviewRoot, defaultConfig, review, { faultAt: "after-review-write" }),
    /after review artifact fsync/
  );
  const repairedReview = recoverCuratorLedger(reviewRoot, defaultConfig, {
    action: "recover-review",
    candidateId: review.candidateId,
    decisionAction: review.action,
    rationale: review.rationale,
    reviewer: review.reviewer,
    idempotencyKey: review.idempotencyKey,
    confidence: review.confidence
  });
  assert.equal(repairedReview.ok, true, repairedReview.error);
  assert.equal(repairedReview.status, "recovered");
  assert.equal(curatorStatus(reviewRoot, defaultConfig).status, "healthy");

  const forgedReviewRoot = workspace();
  const forgedQueued = submitCuratorCandidate(forgedReviewRoot, defaultConfig, submission());
  const forgedInput = { ...review, candidateId: forgedQueued.candidateId, idempotencyKey: "forged-review-boundary-0001" };
  assert.throws(
    () => reviewCuratorCandidate(forgedReviewRoot, defaultConfig, forgedInput, { faultAt: "after-review-write" }),
    /after review artifact fsync/
  );
  const reviewFile = fs.readdirSync(path.join(forgedReviewRoot, "memory/amf/curator/reviews"))
    .map((name) => path.join(forgedReviewRoot, "memory/amf/curator/reviews", name))
    .find((filename) => JSON.parse(fs.readFileSync(filename, "utf8")).decisionKeySha256
      === crypto.createHash("sha256").update(forgedInput.idempotencyKey).digest("hex"));
  const forgedArtifact = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
  forgedArtifact.candidateRevision = 999;
  fs.writeFileSync(reviewFile, `${JSON.stringify(forgedArtifact, null, 2)}\n`, "utf8");
  const refusedReview = recoverCuratorLedger(forgedReviewRoot, defaultConfig, {
    action: "recover-review",
    candidateId: forgedInput.candidateId,
    decisionAction: forgedInput.action,
    rationale: forgedInput.rationale,
    reviewer: forgedInput.reviewer,
    idempotencyKey: forgedInput.idempotencyKey,
    confidence: forgedInput.confidence
  });
  assert.equal(refusedReview.ok, false);
  assert.match(refusedReview.error, /candidate-version|authentication|conflict/);
  assert.equal(curatorStatus(forgedReviewRoot, defaultConfig).status, "unhealthy");

  const applyRoot = workspace();
  const applyQueued = submitCuratorCandidate(applyRoot, defaultConfig, submission());
  const approved = reviewCuratorCandidate(applyRoot, defaultConfig, {
    candidateId: applyQueued.candidateId,
    action: "approve",
    rationale: "Applicator outbox binding is exact.",
    reviewer: "person:synthetic-reviewer",
    idempotencyKey: "admin-apply-boundary-0001"
  });
  const input = { decisionId: approved.decisionId, idempotencyKey: "admin-apply-run-0001" };
  const applied = applyDecisionReceipt(applyRoot, defaultConfig, input);
  assert.equal(applied.ok, true, applied.error);
  const outbox = path.join(applyRoot, applied.outboxPath);
  const forged = JSON.parse(fs.readFileSync(outbox, "utf8"));
  forged.targetDigest = "f".repeat(64);
  fs.writeFileSync(outbox, `${JSON.stringify(forged, null, 2)}\n`, "utf8");
  const refused = applyDecisionReceipt(applyRoot, defaultConfig, input);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /outbox conflict/);
});

test("deleting a non-promoted curator tree and its provisioned external state never reboots history", () => {
  const root = workspace();
  const isolatedState = fs.mkdtempSync(path.join(os.tmpdir(), "pam-curator-deleted-state-"));
  fs.chmodSync(isolatedState, 0o700);
  const runtime = { stateDir: isolatedState };
  const submitted = submitCuratorCandidate(root, defaultConfig, submission(), runtime);
  assert.equal(submitted.ok, true, submitted.error);
  assert.equal(submitted.status, "review_required");
  fs.rmSync(path.join(root, "memory/amf/curator"), { recursive: true });
  fs.rmSync(isolatedState, { recursive: true });
  const status = curatorStatus(root, defaultConfig, {}, runtime);
  assert.equal(status.ok, false);
  assert.equal(status.status, "unhealthy");
  assert.match(status.error, /not provisioned/);
  const retry = submitCuratorCandidate(root, defaultConfig, submission(), runtime);
  assert.equal(retry.ok, false);
  assert.match(retry.error, /not provisioned/);
  assert.equal(fs.existsSync(path.join(root, "memory/amf/curator")), false);
});

test("state root must be absolute, external, real, pre-provisioned, and 0700", () => {
  const root = workspace();
  const relative = submitCuratorCandidate(root, defaultConfig, submission(), { stateDir: "relative-state" });
  assert.equal(relative.ok, false);
  assert.match(relative.error, /absolute provisioned/);

  const inside = path.join(root, "private-state");
  fs.mkdirSync(inside, { mode: 0o700 });
  const inRepo = submitCuratorCandidate(root, defaultConfig, submission(), { stateDir: inside });
  assert.equal(inRepo.ok, false);
  assert.match(inRepo.error, /outside the workspace/);

  const permissive = fs.mkdtempSync(path.join(os.tmpdir(), "pam-curator-mode-"));
  fs.chmodSync(permissive, 0o755);
  const badMode = submitCuratorCandidate(root, defaultConfig, submission(), { stateDir: permissive });
  assert.equal(badMode.ok, false);
  assert.match(badMode.error, /0700/);

  const real = fs.mkdtempSync(path.join(os.tmpdir(), "pam-curator-real-state-"));
  fs.chmodSync(real, 0o700);
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  const symlinked = submitCuratorCandidate(root, defaultConfig, submission(), { stateDir: link });
  assert.equal(symlinked.ok, false);
  assert.match(symlinked.error, /real 0700|symlink/);
});
