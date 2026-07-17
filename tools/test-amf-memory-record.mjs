import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aadSha256For,
  recordSha256,
  validateMemoryRecord,
  validateMemoryRecordTransition
} from "./lib/amf-memory-record.mjs";
import { applyProposal } from "./lib/memory-apply-proposal.mjs";
import { proposeEdit, proposeMemoryRecord } from "./lib/memory-proposals.mjs";
import { atomicWriteFileSync } from "./lib/secure-fs.mjs";

const IDS = {
  memory: "mem_11111111-1111-4111-8111-111111111111",
  replacement: "mem_99999999-9999-4999-8999-999999999999",
  agent: "agent:22222222-2222-4222-8222-222222222222",
  person: "person:33333333-3333-4333-8333-333333333333",
  relationship: "relationship:44444444-4444-4444-8444-444444444444"
};

function baseRecord(overrides = {}) {
  return {
    schema: "amf-memory/v1",
    id: IDS.memory,
    revision: 1,
    claimType: "decision",
    scope: { type: "shared", id: "shared:global" },
    visibility: "shared",
    confidence: { score: 0.99, basis: "reviewed", assessedAt: "2026-07-11T10:00:00Z" },
    subjects: [{ identityId: IDS.agent, role: "owner" }],
    claim: { encoding: "plain", text: "A reusable source-backed decision." },
    lifecycle: {
      status: "active",
      validFrom: "2026-07-11T10:00:00Z",
      validTo: null,
      supersedes: [],
      revokedAt: null,
      revocationReason: null
    },
    provenance: [{
      sourceType: "test-session",
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

function sealedClaimFor(metadata, overrides = {}) {
  const claim = {
    encoding: "sealed",
    alg: "AES-256-GCM",
    kekId: "kek:version-0001",
    keyRef: "key:external-record-key-0001",
    iv: Buffer.alloc(12, 1).toString("base64"),
    ciphertext: Buffer.from("ciphertext").toString("base64"),
    tag: Buffer.alloc(16, 2).toString("base64"),
    aadSha256: "",
    ...overrides
  };
  const withClaim = { ...metadata, claim };
  claim.aadSha256 = overrides.aadSha256 ?? aadSha256For(withClaim);
  return claim;
}

function recordContent(metadata, body = "") {
  const lines = Object.entries(metadata).map(([key, value]) => {
    const rendered = value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
    return `${key}: ${rendered}`;
  });
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-amf-record-"));
  fs.mkdirSync(path.join(root, "memory", "graph"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory", "graph", "nodes.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(root, "memory", "graph", "edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(root, "memory", "graph", "aliases.jsonl"), "", "utf8");
  return root;
}

function writeStaleProjection(root) {
  fs.writeFileSync(path.join(root, "memory", "graph", "nodes.jsonl"), JSON.stringify({
    id: IDS.memory,
    k: "memory-record",
    n: "Stale derived record",
    d: "Stale projection.",
    st: "confirmed",
    c: "high",
    u: "2026-07-10",
    src: `memory/amf/records/${IDS.memory}.md`
  }) + "\n", "utf8");
}

const config = { protectedPaths: ["memory/agent-memory", "memory/sources"] };

test("validates the exact contract-v1 shape, canonical path, and graph projection", () => {
  const validation = validateMemoryRecord(recordContent(baseRecord(), "Non-claim commentary.\n"));
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(validation.expectedPath, `memory/amf/records/${IDS.memory}.md`);
  assert.equal(validation.projection.k, "memory-record");
  assert.equal(validation.projection.c, "high");
  assert.match(validation.projection.d, /source-backed decision/);
  assert.equal(JSON.stringify(validation.projection).includes(IDS.agent), false);

  const legacy = validateMemoryRecord(recordContent({ ...baseRecord(), scope_kind: "shared" }));
  assert.equal(legacy.ok, false);
  assert.match(legacy.errors.join("\n"), /unknown frontmatter key: scope_kind/);
});

test("requires exact structured confidence with finite score, known basis, and bounded UTC assessment", () => {
  const missing = { ...baseRecord() };
  delete missing.confidence;
  assert.match(validateMemoryRecord(recordContent(missing)).errors.join("\n"), /missing frontmatter key: confidence/);

  for (const confidence of [
    { score: -0.1, basis: "observed", assessedAt: "2026-07-11T10:00:00Z" },
    { score: 1.1, basis: "observed", assessedAt: "2026-07-11T10:00:00Z" },
    { score: null, basis: "observed", assessedAt: "2026-07-11T10:00:00Z" },
    { score: 0.8, basis: "unknown", assessedAt: "2026-07-11T10:00:00Z" },
    { score: 0.8, basis: "asserted", assessedAt: "2026-07-11T11:00:00Z" },
    { score: 0.8, basis: "asserted", assessedAt: "2026-07-11T10:00:00Z", extra: true }
  ]) {
    const validation = validateMemoryRecord(recordContent(baseRecord({ confidence })));
    assert.equal(validation.ok, false, JSON.stringify(confidence));
    assert.match(validation.errors.join("\n"), /confidence/);
  }
  for (const basis of ["observed", "asserted", "inferred", "reviewed"]) {
    const validation = validateMemoryRecord(recordContent(baseRecord({
      confidence: { score: 0.5, basis, assessedAt: "2026-07-11T10:00:00Z" }
    })));
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    assert.equal(validation.projection.c, "medium");
  }
});

test("seals person and relationship scopes, claim types, and related subjects", () => {
  for (const overrides of [
    { scope: { type: "person", id: IDS.person }, visibility: "private" },
    { scope: { type: "relationship", id: IDS.relationship }, visibility: "restricted" },
    { claimType: "relationship" },
    { visibility: "restricted" },
    { subjects: [{ identityId: IDS.person, role: "subject" }], visibility: "private" }
  ]) {
    const validation = validateMemoryRecord(recordContent(baseRecord(overrides)));
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join("\n"), /require a sealed claim/);
  }

  const metadata = baseRecord({
    claimType: "fact",
    scope: { type: "person", id: IDS.person },
    visibility: "confidential",
    subjects: [{ identityId: IDS.person, role: "subject" }]
  });
  metadata.claim = sealedClaimFor(metadata);
  const sealed = validateMemoryRecord(recordContent(metadata));
  assert.equal(sealed.ok, true, sealed.errors.join("\n"));
  assert.equal(sealed.projection.n, "Protected memory record");
  assert.equal(JSON.stringify(sealed.projection).includes(IDS.person), false);
  assert.equal(JSON.stringify(sealed.projection).includes(metadata.claim.ciphertext), false);

  const restricted = baseRecord({ visibility: "restricted" });
  restricted.claim = sealedClaimFor(restricted);
  const restrictedValidation = validateMemoryRecord(recordContent(restricted));
  assert.equal(restrictedValidation.ok, true, restrictedValidation.errors.join("\n"));
});

test("validates keyRef, AES-GCM sizes, non-empty ciphertext, and canonical AAD hash", () => {
  const metadata = baseRecord({
    scope: { type: "person", id: IDS.person },
    visibility: "confidential",
    subjects: [{ identityId: IDS.person, role: "subject" }]
  });
  metadata.claim = sealedClaimFor(metadata, {
    keyRef: "not-a-key-ref",
    iv: Buffer.alloc(11).toString("base64"),
    ciphertext: "=",
    tag: Buffer.alloc(15).toString("base64"),
    aadSha256: "b".repeat(64)
  });
  const validation = validateMemoryRecord(recordContent(metadata));
  assert.equal(validation.ok, false);
  const errors = validation.errors.join("\n");
  assert.match(errors, /keyRef/);
  assert.match(errors, /12 bytes/);
  assert.match(errors, /ciphertext/);
  assert.match(errors, /16 bytes/);
  assert.match(errors, /canonical AAD/);
});

test("canonical AAD binds algorithm and external key identifiers", () => {
  const metadata = baseRecord({
    scope: { type: "person", id: IDS.person },
    visibility: "confidential",
    subjects: [{ identityId: IDS.person, role: "subject" }]
  });
  metadata.claim = sealedClaimFor(metadata);
  const valid = validateMemoryRecord(recordContent(metadata));
  assert.equal(valid.ok, true, valid.errors.join("\n"));
  for (const mutation of [
    { alg: "AES-256-GCM-CHANGED" },
    { kekId: "kek:version-0002" },
    { keyRef: "key:external-record-key-0002" }
  ]) {
    const changed = { ...metadata, claim: { ...metadata.claim, ...mutation } };
    const rejected = validateMemoryRecord(recordContent(changed));
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join("\n"), /canonical AAD|alg/);
  }
  const confidenceChanged = {
    ...metadata,
    confidence: { score: 0.5, basis: "reviewed", assessedAt: metadata.confidence.assessedAt }
  };
  const rejectedConfidence = validateMemoryRecord(recordContent(confidenceChanged));
  assert.equal(rejectedConfidence.ok, false);
  assert.match(rejectedConfidence.errors.join("\n"), /canonical AAD/);
});

test("requires real RFC 3339 UTC timestamps", () => {
  for (const invalid of ["2026-07-11T10:00:00+02:00", "2026-02-30T10:00:00Z", "2026-07-11 10:00:00Z"] ) {
    const metadata = baseRecord({ updatedAt: invalid });
    const validation = validateMemoryRecord(recordContent(metadata));
    assert.equal(validation.ok, false);
    assert.match(validation.errors.join("\n"), /updatedAt must be RFC 3339 UTC/);
  }
});

test("provenance is chronological and cannot be captured after updatedAt", () => {
  const future = baseRecord({
    provenance: [{ ...baseRecord().provenance[0], capturedAt: "2026-07-11T11:00:00Z" }]
  });
  const futureValidation = validateMemoryRecord(recordContent(future));
  assert.equal(futureValidation.ok, false);
  assert.match(futureValidation.errors.join("\n"), /must not be later than updatedAt/);

  const unordered = baseRecord({
    updatedAt: "2026-07-11T12:00:00Z",
    revision: 2,
    provenance: [
      { ...baseRecord().provenance[0], capturedAt: "2026-07-11T11:00:00Z" },
      { ...baseRecord().provenance[0], eventId: "event-stable-0002", capturedAt: "2026-07-11T10:30:00Z" }
    ]
  });
  const unorderedValidation = validateMemoryRecord(recordContent(unordered));
  assert.equal(unorderedValidation.ok, false);
  assert.match(unorderedValidation.errors.join("\n"), /ordered by capturedAt ascending/);
});

test("enforces revision, base hash, immutable claim, append-only provenance, and lifecycle transitions", () => {
  const current = recordContent(baseRecord(), "Commentary.\n");
  const nextMetadata = baseRecord({
    revision: 2,
    updatedAt: "2026-07-11T11:00:00Z",
    visibility: "shared",
    provenance: [
      ...baseRecord().provenance,
      {
        sourceType: "operator-decision",
        sourceId: "decision-stable-0002",
        eventId: "event-stable-0002",
        contentSha256: "b".repeat(64),
        capturedAt: "2026-07-11T11:00:00Z"
      }
    ],
    lifecycle: { ...baseRecord().lifecycle, status: "superseded" }
  });
  const proposed = recordContent(nextMetadata, "Commentary.\n");
  const valid = validateMemoryRecordTransition(current, proposed, {
    expectedPath: `memory/amf/records/${IDS.memory}.md`,
    expectedRevision: 1,
    expectedTargetSha256: recordSha256(current)
  });
  assert.equal(valid.ok, true, valid.errors.join("\n"));

  const invalid = recordContent({
    ...nextMetadata,
    revision: 3,
    claim: { encoding: "plain", text: "Silently rewritten claim." },
    provenance: nextMetadata.provenance.slice(1),
    lifecycle: { ...nextMetadata.lifecycle, status: "active" }
  });
  const rejected = validateMemoryRecordTransition(current, invalid, {
    expectedRevision: 1,
    expectedTargetSha256: "f".repeat(64)
  });
  assert.equal(rejected.ok, false);
  const errors = rejected.errors.join("\n");
  assert.match(errors, /revision must increment exactly/);
  assert.match(errors, /claim is immutable/);
  assert.match(errors, /provenance is append-only/);
  assert.match(errors, /base hash/);
});

test("confidence changes are revision-aware and require a newer assessment", () => {
  const current = recordContent(baseRecord());
  const changed = baseRecord({
    revision: 2,
    updatedAt: "2026-07-11T11:00:00Z",
    confidence: { score: 0.75, basis: "asserted", assessedAt: "2026-07-11T11:00:00Z" },
    provenance: [
      ...baseRecord().provenance,
      {
        sourceType: "operator-decision",
        sourceId: "decision-stable-0002",
        eventId: "event-stable-0002",
        contentSha256: "b".repeat(64),
        capturedAt: "2026-07-11T11:00:00Z"
      }
    ]
  });
  const valid = validateMemoryRecordTransition(current, recordContent(changed));
  assert.equal(valid.ok, true, valid.errors.join("\n"));

  const staleAssessment = { ...changed, confidence: { ...changed.confidence, assessedAt: baseRecord().confidence.assessedAt } };
  const rejected = validateMemoryRecordTransition(current, recordContent(staleAssessment));
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join("\n"), /strictly newer/);
});

test("sealed revisions refresh canonical AAD and reject IV reuse or downgrade", () => {
  const currentMetadata = baseRecord({
    scope: { type: "person", id: IDS.person },
    visibility: "confidential",
    subjects: [{ identityId: IDS.person, role: "subject" }]
  });
  currentMetadata.claim = sealedClaimFor(currentMetadata);
  const current = recordContent(currentMetadata);

  const nextMetadata = {
    ...currentMetadata,
    revision: 2,
    updatedAt: "2026-07-11T11:00:00Z",
    confidence: { score: 0.8, basis: "reviewed", assessedAt: "2026-07-11T11:00:00Z" },
    provenance: [
      ...currentMetadata.provenance,
      {
        sourceType: "operator-decision",
        sourceId: "decision-stable-0002",
        eventId: "event-stable-0002",
        contentSha256: "b".repeat(64),
        capturedAt: "2026-07-11T11:00:00Z"
      }
    ]
  };
  nextMetadata.claim = sealedClaimFor(nextMetadata, { iv: Buffer.alloc(12, 3).toString("base64") });
  const next = recordContent(nextMetadata);
  const valid = validateMemoryRecordTransition(current, next, {
    expectedRevision: 1,
    expectedTargetSha256: recordSha256(current)
  });
  assert.equal(valid.ok, true, valid.errors.join("\n"));

  const reusedMetadata = { ...nextMetadata, claim: sealedClaimFor(nextMetadata, { iv: currentMetadata.claim.iv }) };
  const reused = validateMemoryRecordTransition(current, recordContent(reusedMetadata));
  assert.equal(reused.ok, false);
  assert.match(reused.errors.join("\n"), /new IV/);
});

test("proposes and atomically applies a canonical AMF record", () => {
  const root = makeWorkspace();
  const content = recordContent(baseRecord(), "Reviewed commentary.\n");
  const proposed = proposeMemoryRecord(root, config, { content, rationale: "Add reviewed record." });
  assert.equal(proposed.ok, true, proposed.error);
  assert.equal(proposed.targetPath, `memory/amf/records/${IDS.memory}.md`);
  assert.equal(fs.existsSync(path.join(root, proposed.targetPath)), false);
  const applied = applyProposal(root, config, { proposalId: proposed.proposalId });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(fs.readFileSync(path.join(root, proposed.targetPath), "utf8"), content);
  assert.equal(fs.statSync(path.join(root, proposed.targetPath)).mode & 0o777, 0o600);
  assert.equal(applied.validation.schema, "amf-memory/v1");
});

test("resolves every supersedes target through the workspace", () => {
  const root = makeWorkspace();
  const previous = recordContent(baseRecord());
  const previousPath = `memory/amf/records/${IDS.memory}.md`;
  fs.mkdirSync(path.dirname(path.join(root, previousPath)), { recursive: true });
  fs.writeFileSync(path.join(root, previousPath), previous, "utf8");

  const replacementMetadata = baseRecord({
    id: IDS.replacement,
    claim: { encoding: "plain", text: "Corrected source-backed decision." },
    confidence: { score: 0.99, basis: "reviewed", assessedAt: "2026-07-11T12:00:00Z" },
    lifecycle: { ...baseRecord().lifecycle, supersedes: [IDS.memory] },
    createdAt: "2026-07-11T12:00:00Z",
    updatedAt: "2026-07-11T12:00:00Z"
  });
  const valid = proposeMemoryRecord(root, config, {
    content: recordContent(replacementMetadata),
    rationale: "Superseding correction."
  });
  assert.equal(valid.ok, true, valid.error);

  const missingMetadata = {
    ...replacementMetadata,
    lifecycle: { ...replacementMetadata.lifecycle, supersedes: ["mem_88888888-8888-4888-8888-888888888888"] }
  };
  const missing = proposeMemoryRecord(root, config, {
    content: recordContent(missingMetadata),
    rationale: "Must resolve target."
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /target does not exist/);
});

test("checks projection collisions against the actual workspace graph", () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "memory", "graph", "nodes.jsonl"), JSON.stringify({
    id: IDS.memory,
    k: "person",
    n: "Colliding node",
    d: "Not an AMF projection.",
    st: "confirmed",
    c: "high",
    u: "2026-07-11",
    src: "memory/index.md"
  }) + "\n", "utf8");
  const rejected = proposeMemoryRecord(root, config, {
    content: recordContent(baseRecord()),
    rationale: "Must reject graph collision."
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /graph id collision/);

  fs.writeFileSync(path.join(root, "memory", "graph", "nodes.jsonl"), JSON.stringify({
    id: IDS.memory,
    k: "memory-record",
    n: "Stale derived record",
    d: "Stale projection.",
    st: "confirmed",
    c: "high",
    u: "2026-07-10",
    src: `memory/amf/records/${IDS.memory}.md`
  }) + "\n", "utf8");
  const bounded = validateMemoryRecord(recordContent(baseRecord()), { workspaceRoot: root });
  assert.equal(bounded.ok, true, bounded.errors.join("\n"));
  assert.match(bounded.warnings.join("\n"), /projection is stale/);

  const proposed = proposeMemoryRecord(root, config, {
    content: recordContent(baseRecord()),
    rationale: "Propagate the required graph reindex follow-up."
  });
  assert.equal(proposed.ok, true, proposed.error);
  assert.equal(proposed.graphProjectionStale, true);
  assert.equal(proposed.regenerateAfterApply, true);
  assert.equal(proposed.followup.command, "npm run memory:graph:index");
  const proposalArtifact = JSON.parse(fs.readFileSync(path.join(root, proposed.proposalPath), "utf8"));
  assert.match(proposalArtifact.validation.warnings.join("\n"), /projection is stale/);
  assert.equal(proposalArtifact.validation.amfMemory.graphProjectionStale, true);
  assert.equal(proposalArtifact.validation.regenerateAfterApply, true);

  const applied = applyProposal(root, config, { proposalId: proposed.proposalId });
  assert.equal(applied.ok, true, applied.error);
  assert.equal(applied.graphProjectionStale, true);
  assert.equal(applied.regenerateAfterApply, true);
  assert.deepEqual(applied.followup, {
    action: "graph_reindex",
    command: "npm run memory:graph:index",
    required: true
  });
  const appliedArtifact = JSON.parse(fs.readFileSync(path.join(root, applied.proposalArchivedAs), "utf8"));
  assert.match(appliedArtifact.validation.warnings.join("\n"), /projection is stale/);
  assert.equal(appliedArtifact.validation.graphProjectionStale, true);
  assert.equal(appliedArtifact.validation.regenerateAfterApply, true);
});

test("proposal and apply reject symlinks in every ancestor", () => {
  const root = makeWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pam-amf-outside-"));
  fs.mkdirSync(path.join(root, "memory", "amf"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "memory", "amf", "records"));
  const content = recordContent(baseRecord());
  const proposed = proposeMemoryRecord(root, config, { content, rationale: "Must fail closed." });
  assert.equal(proposed.ok, false);
  assert.match(proposed.error, /symlink/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test("apply rechecks ancestors and refuses a symlink introduced after proposal", () => {
  const root = makeWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pam-amf-apply-outside-"));
  const content = recordContent(baseRecord());
  const proposed = proposeMemoryRecord(root, config, { content, rationale: "Record before path substitution." });
  assert.equal(proposed.ok, true, proposed.error);
  fs.mkdirSync(path.join(root, "memory", "amf"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "memory", "amf", "records"));
  const applied = applyProposal(root, config, { proposalId: proposed.proposalId });
  assert.equal(applied.ok, false);
  assert.match(applied.error, /symlink/);
  assert.equal(fs.readdirSync(outside).length, 0);
});

test("apply validates old-to-new revision and requires a real proposal base hash", () => {
  const root = makeWorkspace();
  const target = `memory/amf/records/${IDS.memory}.md`;
  const current = recordContent(baseRecord());
  fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
  fs.writeFileSync(path.join(root, target), current, "utf8");
  const next = recordContent(baseRecord({ revision: 2, updatedAt: "2026-07-11T11:00:00Z" }));
  const proposal = proposeEdit(root, config, {
    path: target,
    rationale: "Lifecycle metadata revision.",
    diff: { kind: "replace", before: current, after: next }
  });
  assert.equal(proposal.ok, true, proposal.error);
  const artifactPath = path.join(root, proposal.proposalPath);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  assert.equal(artifact.expectedRevision, 1);
  assert.equal(artifact.expectedTargetSha256, recordSha256(current));
  artifact.expectedTargetSha256 = "f".repeat(64);
  fs.writeFileSync(artifactPath, JSON.stringify(artifact), "utf8");
  const applied = applyProposal(root, config, { proposalId: proposal.proposalId });
  assert.equal(applied.ok, false);
  assert.match(applied.error, /drifted|SHA-256/);
  assert.equal(fs.readFileSync(path.join(root, target), "utf8"), current);
});

test("apply uses an exclusive proposal lock", () => {
  const root = makeWorkspace();
  const content = recordContent(baseRecord());
  const proposed = proposeMemoryRecord(root, config, { content, rationale: "Exclusive apply." });
  assert.equal(proposed.ok, true, proposed.error);
  const lockPath = path.join(root, "memory", "maintenance", "proposals", `${proposed.proposalId}.lock`);
  fs.writeFileSync(lockPath, "held\n", { mode: 0o600 });
  const applied = applyProposal(root, config, { proposalId: proposed.proposalId });
  assert.equal(applied.ok, false);
  assert.match(applied.error, /already being applied/);
  assert.equal(fs.existsSync(path.join(root, proposed.targetPath)), false);
});

test("exclusive atomic writes never replace an existing path", () => {
  const root = makeWorkspace();
  const target = path.join(root, "memory", "reserved.json");
  fs.writeFileSync(target, "original\n", "utf8");
  assert.throws(
    () => atomicWriteFileSync(root, target, "replacement\n", { exclusive: true }),
    /already exists/
  );
  assert.equal(fs.readFileSync(target, "utf8"), "original\n");
});

test("archive collision fails before target persistence and applying reservation recovers", () => {
  const root = makeWorkspace();
  const content = recordContent(baseRecord());
  const collision = proposeMemoryRecord(root, config, { content, rationale: "Archive collision." });
  assert.equal(collision.ok, true, collision.error);
  const collisionArchive = path.join(root, "memory", "maintenance", "proposals", `${collision.proposalId}.applied.json`);
  fs.writeFileSync(collisionArchive, JSON.stringify({ status: "foreign" }), "utf8");
  const blocked = applyProposal(root, config, { proposalId: collision.proposalId });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /reserved by a different|malformed/);
  assert.equal(fs.existsSync(path.join(root, collision.targetPath)), false);

  const recoveryRoot = makeWorkspace();
  const recovery = proposeMemoryRecord(recoveryRoot, config, { content, rationale: "Crash recovery." });
  assert.equal(recovery.ok, true, recovery.error);
  const proposalArtifact = JSON.parse(fs.readFileSync(path.join(recoveryRoot, recovery.proposalPath), "utf8"));
  const recoveryArchive = path.join(recoveryRoot, "memory", "maintenance", "proposals", `${recovery.proposalId}.applied.json`);
  fs.writeFileSync(recoveryArchive, JSON.stringify({
    ...proposalArtifact,
    status: "applying",
    reservationId: crypto.randomUUID(),
    reservedAt: "2026-07-11T12:00:00Z"
  }), "utf8");
  fs.mkdirSync(path.dirname(path.join(recoveryRoot, recovery.targetPath)), { recursive: true });
  fs.writeFileSync(path.join(recoveryRoot, recovery.targetPath), content, "utf8");
  const recovered = applyProposal(recoveryRoot, config, { proposalId: recovery.proposalId });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(JSON.parse(fs.readFileSync(recoveryArchive, "utf8")).status, "applied");
  assert.equal(fs.existsSync(path.join(recoveryRoot, recovery.proposalPath)), false);
});

test("applying reservation binds the complete immutable proposal identity", () => {
  const root = makeWorkspace();
  const content = recordContent(baseRecord());
  const proposed = proposeMemoryRecord(root, config, {
    content,
    rationale: "Preserve reviewed proposal identity.",
    findingIds: ["finding-reviewed-1"],
    source: "reviewed-curator"
  });
  assert.equal(proposed.ok, true, proposed.error);
  const proposalAbsolute = path.join(root, proposed.proposalPath);
  const proposalArtifact = JSON.parse(fs.readFileSync(proposalAbsolute, "utf8"));
  const archiveAbsolute = path.join(
    root,
    "memory",
    "maintenance",
    "proposals",
    `${proposed.proposalId}.applied.json`
  );
  const forgedReservation = {
    ...proposalArtifact,
    source: "forged-curator",
    rationale: "Substitute an unreviewed rationale.",
    findingIds: ["finding-forged-1"],
    diff: {
      ...proposalArtifact.diff,
      content: proposalArtifact.diff.content.replace("event-stable-0001", "event-forged-0001")
    },
    status: "applying",
    reservationId: crypto.randomUUID(),
    reservedAt: "2026-07-11T12:00:00Z"
  };
  assert.equal(forgedReservation.proposalId, proposalArtifact.proposalId);
  assert.equal(forgedReservation.targetPath, proposalArtifact.targetPath);
  assert.equal(forgedReservation.proposedContentSha256, proposalArtifact.proposedContentSha256);
  fs.writeFileSync(archiveAbsolute, JSON.stringify(forgedReservation), "utf8");
  const archiveBeforeApply = fs.readFileSync(archiveAbsolute, "utf8");

  const rejected = applyProposal(root, config, { proposalId: proposed.proposalId });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /reserved by a different|malformed/);
  assert.equal(fs.existsSync(proposalAbsolute), true);
  assert.equal(fs.existsSync(path.join(root, proposed.targetPath)), false);
  assert.equal(fs.readFileSync(archiveAbsolute, "utf8"), archiveBeforeApply);
});

test("applied recovery rejects an unrelated archive and retains the live proposal", () => {
  const root = makeWorkspace();
  const content = recordContent(baseRecord());
  const proposed = proposeMemoryRecord(root, config, { content, rationale: "Keep the real proposal." });
  assert.equal(proposed.ok, true, proposed.error);
  const proposalAbsolute = path.join(root, proposed.proposalPath);
  const proposalArtifact = JSON.parse(fs.readFileSync(proposalAbsolute, "utf8"));
  const unrelatedPath = "memory/amf/records/mem_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.md";
  const unrelatedContent = recordContent(baseRecord({ id: "mem_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
  fs.mkdirSync(path.dirname(path.join(root, unrelatedPath)), { recursive: true });
  fs.writeFileSync(path.join(root, unrelatedPath), unrelatedContent, "utf8");
  const unrelatedHash = recordSha256(unrelatedContent);
  const archiveAbsolute = path.join(root, "memory", "maintenance", "proposals", `${proposed.proposalId}.applied.json`);
  fs.writeFileSync(archiveAbsolute, JSON.stringify({
    ...proposalArtifact,
    targetPath: unrelatedPath,
    proposedContentSha256: unrelatedHash,
    persistedContentSha256: unrelatedHash,
    status: "applied",
    reservationId: crypto.randomUUID(),
    appliedAt: "2026-07-11T12:00:00Z",
    validation: null
  }), "utf8");

  const rejected = applyProposal(root, config, { proposalId: proposed.proposalId });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /identity does not match/);
  assert.equal(fs.existsSync(proposalAbsolute), true);
  assert.equal(fs.existsSync(path.join(root, proposed.targetPath)), false);
});

test("applied recovery binds and preserves the validation warning summary", () => {
  const content = recordContent(baseRecord());
  const root = makeWorkspace();
  writeStaleProjection(root);
  const proposed = proposeMemoryRecord(root, config, { content, rationale: "Recover with graph warning." });
  assert.equal(proposed.ok, true, proposed.error);
  const proposalAbsolute = path.join(root, proposed.proposalPath);
  const proposalArtifact = JSON.parse(fs.readFileSync(proposalAbsolute, "utf8"));
  assert.match(proposalArtifact.validation.warnings.join("\n"), /projection is stale/);
  fs.mkdirSync(path.dirname(path.join(root, proposed.targetPath)), { recursive: true });
  fs.writeFileSync(path.join(root, proposed.targetPath), content, "utf8");
  const archiveAbsolute = path.join(root, "memory", "maintenance", "proposals", `${proposed.proposalId}.applied.json`);
  fs.writeFileSync(archiveAbsolute, JSON.stringify({
    ...proposalArtifact,
    status: "applied",
    reservationId: crypto.randomUUID(),
    appliedAt: "2026-07-11T12:00:00Z",
    persistedContentSha256: proposalArtifact.proposedContentSha256,
    validation: proposalArtifact.validation.amfMemory
  }), "utf8");

  const recovered = applyProposal(root, config, { proposalId: proposed.proposalId });
  assert.equal(recovered.ok, true, recovered.error);
  assert.equal(recovered.recovered, true);
  assert.match(recovered.warnings.join("\n"), /projection is stale/);
  assert.equal(recovered.graphProjectionStale, true);
  assert.equal(recovered.regenerateAfterApply, true);
  assert.equal(fs.existsSync(proposalAbsolute), false);

  const forgedRoot = makeWorkspace();
  writeStaleProjection(forgedRoot);
  const forged = proposeMemoryRecord(forgedRoot, config, { content, rationale: "Reject changed warnings." });
  assert.equal(forged.ok, true, forged.error);
  const forgedProposalAbsolute = path.join(forgedRoot, forged.proposalPath);
  const forgedProposal = JSON.parse(fs.readFileSync(forgedProposalAbsolute, "utf8"));
  fs.mkdirSync(path.dirname(path.join(forgedRoot, forged.targetPath)), { recursive: true });
  fs.writeFileSync(path.join(forgedRoot, forged.targetPath), content, "utf8");
  const forgedArchiveAbsolute = path.join(forgedRoot, "memory", "maintenance", "proposals", `${forged.proposalId}.applied.json`);
  fs.writeFileSync(forgedArchiveAbsolute, JSON.stringify({
    ...forgedProposal,
    status: "applied",
    reservationId: crypto.randomUUID(),
    appliedAt: "2026-07-11T12:00:00Z",
    persistedContentSha256: forgedProposal.proposedContentSha256,
    validation: { ...forgedProposal.validation.amfMemory, warnings: ["forged warning summary"] }
  }), "utf8");

  const warningMismatch = applyProposal(forgedRoot, config, { proposalId: forged.proposalId });
  assert.equal(warningMismatch.ok, false);
  assert.match(warningMismatch.error, /validation warnings do not match/);
  assert.equal(fs.existsSync(forgedProposalAbsolute), true);
});

test("plain sensitive claims validate only with the explicit opt-out", () => {
  const sensitive = [
    { scope: { type: "person", id: IDS.person }, visibility: "private" },
    { scope: { type: "relationship", id: IDS.relationship }, visibility: "restricted" },
    { claimType: "relationship" },
    { subjects: [{ identityId: IDS.person, role: "subject" }], visibility: "private" }
  ];
  for (const overrides of sensitive) {
    const strict = validateMemoryRecord(recordContent(baseRecord(overrides)));
    assert.equal(strict.ok, false);
    const relaxed = validateMemoryRecord(recordContent(baseRecord(overrides)), { allowPlainSensitiveClaims: true });
    assert.equal(relaxed.ok, true, relaxed.errors.join("; "));
  }
  const relaxedEmpty = validateMemoryRecord(
    recordContent(baseRecord({ scope: { type: "person", id: IDS.person }, visibility: "private" })).replace(/claim:.*\n/, 'claim: {"encoding":"plain","text":"  "}\n'),
    { allowPlainSensitiveClaims: true }
  );
  assert.equal(relaxedEmpty.ok, false);
});
