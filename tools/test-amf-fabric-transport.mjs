import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { aadSha256For, canonicalize, renderMemoryRecord } from "./lib/amf-memory-record.mjs";
import { dispatchFabricApplyReceipt, drainFabricProposals, intakeFabricProposal, replayFabricDecisionOutbox } from "./lib/amf-fabric-transport.mjs";
import { applyDecisionReceipt, buildFabricApplyReceipt, deliverAppliedMemoryToGit, verifyFabricApplyReceipt } from "./lib/memory-receipt-applicator.mjs";

const LEDGER_KEY = "fabric-transport-ledger-key-0000000000000000000000001";
const REVIEWER_TOKEN = "fabric-transport-reviewer-token-0001";
const APPLICATOR_TOKEN = "fabric-transport-applicator-token-0001";
const STATE_KEY = "fabric-transport-state-key-0000000000000000000000001";
const PROPOSAL_ID = "proposal-transport-0001";

function sha(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-fabric-transport-"));
  fs.mkdirSync(path.join(root, "memory/graph"), { recursive: true });
  for (const name of ["nodes.jsonl", "edges.jsonl", "aliases.jsonl"]) fs.writeFileSync(path.join(root, "memory/graph", name), "");
  return root;
}
function privateFile(root, name, value, mode = 0o600) { const file = path.join(root, name); fs.writeFileSync(file, `${value}\n`, { mode }); fs.chmodSync(file, mode); return file; }
function git(root, args) { const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); if (result.status !== 0) throw new Error(`git failed: ${args[0]}`); return result.stdout.trim(); }
function initializeGit(root) {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "pam-fabric-remote-")); git(remote, ["init", "--bare"]);
  git(root, ["init", "-b", "curated"]); git(root, ["config", "user.name", "PAM Test"]); git(root, ["config", "user.email", "pam@example.invalid"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "memory/amf/curator/\nmemory/amf/curator.initialized.json\nmemory/amf/applicator/\nmemory/maintenance/\n");
  git(root, ["add", ".gitignore", "memory/graph"]); git(root, ["commit", "-m", "test: baseline"]); git(root, ["remote", "add", "origin", remote]);
  return remote;
}
function record() {
  const timestamp = "2026-07-12T12:00:00Z";
  const value = {
    schema: "amf-memory/v1", id: "mem_transport_00000001", revision: 1, claimType: "fact",
    scope: { type: "room", id: "room:vitae:joseph-dm" }, visibility: "shared",
    confidence: { score: 0.995, basis: "reviewed", assessedAt: timestamp },
    subjects: [{ identityId: "agent:vitae", role: "owner" }],
    claim: { encoding: "sealed", alg: "AES-256-GCM", kekId: "kek:transport-v1", keyRef: "key:transport-v1", iv: Buffer.alloc(12, 1).toString("base64"), ciphertext: Buffer.from("A bounded synthetic transport fact.").toString("base64"), tag: Buffer.alloc(16, 2).toString("base64"), aadSha256: "" },
    lifecycle: { status: "active", validFrom: timestamp, validTo: null, supersedes: [], revokedAt: null, revocationReason: null },
    provenance: [{ sourceType: "synthetic-test", sourceId: "transport-test", eventId: "event-transport-0001", contentSha256: "a".repeat(64), capturedAt: timestamp }],
    createdAt: timestamp, updatedAt: timestamp
  };
  value.claim.aadSha256 = aadSha256For(value);
  return value;
}
function config(root) {
  const secretRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pam-fabric-secrets-"));
  const curator = privateFile(secretRoot, "curator.token", "curator-fabric-bearer-0001");
  const applicator = privateFile(secretRoot, "applicator.token", "applicator-fabric-bearer-0001");
  const stateKey = privateFile(secretRoot, "applicator-state.key", STATE_KEY);
  return {
    config: {
      managedLogs: [{ source: "memory/knowledge-log.md", archiveKey: "knowledge", activeEntryLimit: 10 }],
      protectedPaths: ["AGENTS.md", "memory/agent-memory", "memory/sources"],
      amfCurator: {
        version: "amf-curator-policy/v1", autoPromote: true, minimumConfidence: 0.98,
        autoScopes: ["room"], autoVisibilities: ["shared"], requireReviewForLifecycleChange: false,
        requireReviewForSupersession: true, rejectOnWarnings: true, ledgerKeyEnv: "PAM_CURATOR_LEDGER_KEY",
        stateDirEnv: "PAM_CURATOR_STATE_DIR", reviewerTokenEnv: "PAM_CURATOR_REVIEWER_TOKEN",
        reviewers: [{ tokenSha256: sha(REVIEWER_TOKEN), actorId: "service:transport-curator", capabilities: ["memory:curate"] }],
        gitWriter: { enabled: false, dryRunOnly: true, protectedBranches: ["main"] }
      },
      amfApplicator: {
        version: "amf-receipt-applicator/v1", tokenEnv: "PAM_APPLICATOR_TOKEN", stateKeyEnv: "PAM_APPLICATOR_STATE_KEY",
        recordIndexPath: "memory/amf/record-index.json",
        applicators: [{ tokenSha256: sha(APPLICATOR_TOKEN), actorId: "service:transport-applicator", capabilities: ["memory:apply-receipt"] }],
        transport: { kind: "disabled", endpointEnv: "PAM_FABRIC_RECEIPT_ENDPOINT" }
      },
      amfFabricTransport: {
        version: "amf-fabric-transport/v1", baseUrlEnv: "PAM_FABRIC_BASE_URL",
        curatorTokenFileEnv: "PAM_FABRIC_CURATOR_TOKEN_FILE", applicatorTokenFileEnv: "PAM_FABRIC_APPLICATOR_TOKEN_FILE",
        timeoutMs: 1000, maxResponseBytes: 65536
      }
    },
    env: { PAM_FABRIC_BASE_URL: "https://fabric.example.test", PAM_FABRIC_CURATOR_TOKEN_FILE: curator, PAM_FABRIC_APPLICATOR_TOKEN_FILE: applicator, PAM_APPLICATOR_STATE_KEY_FILE: stateKey }
  };
}

test("bounded curator drain, separate applicator, atomic index and Fabric receipts converge", async () => {
  const root = workspace(); const state = fs.mkdtempSync(path.join(os.tmpdir(), "pam-fabric-state-")); fs.chmodSync(state, 0o700);
  const remote = initializeGit(root); const fixture = config(root);
  fixture.config.amfApplicator.gitWriter = { enabled: true, repoRootEnv: "PAM_GIT_WRITER_REPO_ROOT", allowedBranches: ["curated"], push: { enabled: true, remote: "origin", allowedRemotes: ["origin"] } };
  fixture.env.PAM_GIT_WRITER_REPO_ROOT = root;
  const payload = { type: "canonical-memory-proposal", actor: "agent:vitae", scope: record().scope.id, record: record(), rationale: "synthetic evidence", expectedRevision: 0 };
  const proposalDigest = sha(canonicalize(payload)); const roles = [];
  const runtime = {
    env: fixture.env, ledgerKey: LEDGER_KEY, reviewerToken: REVIEWER_TOKEN, stateDir: state,
    requestJson: async request => {
      roles.push(request.token);
      if (request.method === "GET" && request.pathname.startsWith("/v2/internal/curation/proposals?")) return { ok: true, data: { items: [{ proposalId: PROPOSAL_ID, status: "queued", createdAt: "2026-07-12T12:00:00Z" }], nextCursor: null }, meta: { requestId: "ack-list" } };
      if (request.method === "GET") return { ok: true, data: { proposalId: PROPOSAL_ID, status: "queued", payload, proposalDigest }, meta: { requestId: "ack-read" } };
      const expectedStatus = request.body.kind === "decision" ? request.body.status : "promoted";
      return { ok: true, data: { proposalId: PROPOSAL_ID, status: expectedStatus }, meta: { requestId: `ack-${request.body.kind}` } };
    }
  };
  const drained = await drainFabricProposals(root, fixture.config, { limit: 1, dispatch: true }, runtime);
  assert.equal(drained.ok, true, JSON.stringify(drained)); assert.equal(drained.processed, 1);
  const decisionId = drained.results[0].decisionId;
  assert.equal(drained.results[0].status, "approved_pending_apply");
  assert.equal(fs.existsSync(path.join(root, `memory/amf/records/${record().id}.md`)), false);
  const prematureDelivery = deliverAppliedMemoryToGit(root, fixture.config, { decisionId, push: false }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY });
  assert.equal(prematureDelivery.ok, false);
  assert.match(prematureDelivery.error, /receipt-ready/);

  const applied = applyDecisionReceipt(root, fixture.config, { decisionId, idempotencyKey: "fabric-apply-transport-0001" }, { ...runtime, applicatorToken: APPLICATOR_TOKEN });
  assert.equal(applied.ok, true, applied.error); assert.equal(applied.status, "receipt_queued");
  const index = JSON.parse(fs.readFileSync(path.join(root, "memory/amf/record-index.json"), "utf8"));
  assert.deepEqual(index.records[record().id].contextRefs, { conversation: ["room:vitae:joseph-dm"], room: ["room:vitae:joseph-dm"] });
  const fabricApply = buildFabricApplyReceipt(applied.receipt);
  assert.equal(fabricApply.ok, true);
  assert.equal(verifyFabricApplyReceipt(root, fixture.config, fabricApply.receipt, { stateKey: STATE_KEY }).verified, true);
  fs.writeFileSync(path.join(root, "unrelated.txt"), "unrelated\n");
  const unrelated = deliverAppliedMemoryToGit(root, fixture.config, { decisionId, push: false }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY });
  assert.equal(unrelated.ok, false); assert.match(unrelated.error, /unrelated/); fs.unlinkSync(path.join(root, "unrelated.txt"));
  const hook = path.join(root, ".git/hooks/pre-commit"); fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const failedCommit = deliverAppliedMemoryToGit(root, fixture.config, { decisionId, push: false }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY });
  assert.equal(failedCommit.ok, false); assert.match(failedCommit.error, /staging rolled back/); assert.equal(spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root }).status, 0);
  fs.unlinkSync(hook);
  const committed = deliverAppliedMemoryToGit(root, fixture.config, { decisionId, push: false }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY });
  assert.equal(committed.ok, true, committed.error); assert.equal(committed.status, "committed");
  git(root, ["checkout", "-b", "curated-alt"]);
  const branchRetryConfig = structuredClone(fixture.config); branchRetryConfig.amfApplicator.gitWriter.allowedBranches.push("curated-alt");
  const wrongAllowlistedBranch = deliverAppliedMemoryToGit(root, branchRetryConfig, { decisionId, push: false }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY });
  assert.equal(wrongAllowlistedBranch.ok, false); assert.match(wrongAllowlistedBranch.error, /delivery state/);
  git(root, ["checkout", "curated"]);
  assert.equal(git(root, ["ls-remote", "--heads", remote, "refs/heads/curated"]), "", "push must never be implicit");
  const competing = fs.mkdtempSync(path.join(os.tmpdir(), "pam-fabric-competing-")); git(competing, ["init", "-b", "curated"]); git(competing, ["config", "user.name", "Other"]); git(competing, ["config", "user.email", "other@example.invalid"]); fs.writeFileSync(path.join(competing, "other.txt"), "other\n"); git(competing, ["add", "other.txt"]); git(competing, ["commit", "-m", "other root"]); git(competing, ["remote", "add", "origin", remote]); git(competing, ["push", "origin", "curated"]);
  const nonFastForward = deliverAppliedMemoryToGit(root, fixture.config, { decisionId, push: true }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY });
  assert.equal(nonFastForward.ok, false); assert.match(nonFastForward.error, /not fast-forward/);
  git(competing, ["push", "origin", "--delete", "curated"]);
  const pushed = deliverAppliedMemoryToGit(root, fixture.config, { decisionId, push: true }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY });
  assert.equal(pushed.ok, true, pushed.error); assert.equal(pushed.status, "pushed"); assert.equal(git(remote, ["rev-parse", "refs/heads/curated"]), pushed.commit);
  const deliveryRetry = deliverAppliedMemoryToGit(root, fixture.config, { decisionId, push: true }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY });
  assert.equal(deliveryRetry.ok, true); assert.equal(deliveryRetry.duplicate, true); assert.equal(deliveryRetry.commit, pushed.commit);
  const wrongBranchConfig = structuredClone(fixture.config); wrongBranchConfig.amfApplicator.gitWriter.allowedBranches = ["other"];
  assert.match(deliverAppliedMemoryToGit(root, wrongBranchConfig, { decisionId, push: false }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY }).error, /branch/);
  await assert.rejects(() => dispatchFabricApplyReceipt(root, fixture.config, { decisionId }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY, faultAt: "after-apply-ack" }), /after apply ACK/);
  const acked = await dispatchFabricApplyReceipt(root, fixture.config, { decisionId }, { ...runtime, applicatorToken: APPLICATOR_TOKEN, stateKey: STATE_KEY });
  assert.equal(acked.ok, true, acked.error); assert.equal(acked.status, "fabric_acked");
  assert.ok(roles.includes("curator-fabric-bearer-0001")); assert.ok(roles.includes("applicator-fabric-bearer-0001"));
});

test("multi-page drain is bounded, redacted, and replays a crash after decision ACK", async () => {
  const root = workspace(); const state = fs.mkdtempSync(path.join(os.tmpdir(), "pam-fabric-state-")); fs.chmodSync(state, 0o700);
  const fixture = config(root); const payload = { type: "canonical-memory-proposal", actor: "agent:vitae", scope: record().scope.id, record: record(), rationale: "synthetic evidence", expectedRevision: 0 };
  const digest = sha(canonicalize(payload)); let decisionPosts = 0;
  const requestJson = async request => {
    if (request.method === "GET" && request.pathname.startsWith("/v2/internal/curation/proposals?")) {
      const second = request.pathname.includes("cursor=page-two");
      return { ok: true, data: { items: [{ proposalId: second ? "proposal-page-0002" : "proposal-page-0001", status: "queued", createdAt: "2026-07-12T12:00:00Z" }], nextCursor: second ? null : "page-two" }, meta: { requestId: "ack-list" } };
    }
    if (request.method === "GET") {
      const proposalId = request.pathname.endsWith("0002") ? "proposal-page-0002" : "proposal-page-0001";
      return { ok: true, data: { proposalId, status: "queued", payload, proposalDigest: digest }, meta: { requestId: "ack-read" } };
    }
    decisionPosts += 1;
    return { ok: true, data: { proposalId: request.body.proposalId, status: request.body.status, decision: request.body }, meta: { requestId: `ack-decision-${decisionPosts}` } };
  };
  const runtime = { env: fixture.env, ledgerKey: LEDGER_KEY, reviewerToken: REVIEWER_TOKEN, stateDir: state, requestJson };
  const drained = await drainFabricProposals(root, fixture.config, { limit: 1, maxPages: 2, dispatch: false }, runtime);
  assert.equal(drained.processed, 2); assert.equal(drained.pages, 2); assert.equal(drained.nextCursor, null);
  assert.equal(JSON.stringify(drained).includes("ciphertext"), false); assert.equal(JSON.stringify(drained).includes("claim"), false);
  await assert.rejects(() => intakeFabricProposal(root, fixture.config, { proposalId: "proposal-page-0001", dispatch: true }, { ...runtime, faultAt: "after-decision-ack" }), /after decision ACK/);
  const replayed = await replayFabricDecisionOutbox(root, fixture.config, { limit: 10 }, runtime);
  assert.equal(replayed.ok, true); assert.ok(replayed.results.some(item => item.duplicate === false));
});

test("Fabric binding retry, token file modes and response digests fail closed", async () => {
  const root = workspace(); const state = fs.mkdtempSync(path.join(os.tmpdir(), "pam-fabric-state-")); fs.chmodSync(state, 0o700);
  const fixture = config(root); const payload = { type: "canonical-memory-proposal", actor: "agent:vitae", scope: record().scope.id, record: record(), rationale: "synthetic evidence", expectedRevision: 0 };
  const runtime = { env: fixture.env, ledgerKey: LEDGER_KEY, reviewerToken: REVIEWER_TOKEN, stateDir: state, requestJson: async request => ({ ok: true, data: request.method === "GET" ? { proposalId: PROPOSAL_ID, status: "queued", payload, proposalDigest: "b".repeat(64) } : {}, meta: { requestId: "ack" } }) };
  await assert.rejects(() => intakeFabricProposal(root, fixture.config, { proposalId: PROPOSAL_ID, dispatch: false }, runtime), /binding/);
  fs.chmodSync(fixture.env.PAM_FABRIC_CURATOR_TOKEN_FILE, 0o644);
  await assert.rejects(() => intakeFabricProposal(root, fixture.config, { proposalId: PROPOSAL_ID, dispatch: false }, runtime), /0600/);
  fs.chmodSync(fixture.env.PAM_FABRIC_CURATOR_TOKEN_FILE, 0o600);
  const secretParent = path.dirname(fixture.env.PAM_FABRIC_CURATOR_TOKEN_FILE);
  fs.chmodSync(secretParent, 0o777);
  await assert.rejects(() => intakeFabricProposal(root, fixture.config, { proposalId: PROPOSAL_ID, dispatch: false }, runtime), /non-writable parent/);
  fs.chmodSync(secretParent, 0o700);
  const linkedParent = path.join(os.tmpdir(), `pam-secret-link-${crypto.randomBytes(6).toString("hex")}`);
  fs.symlinkSync(secretParent, linkedParent);
  const linkedFixture = structuredClone(fixture); linkedFixture.env.PAM_FABRIC_CURATOR_TOKEN_FILE = path.join(linkedParent, path.basename(fixture.env.PAM_FABRIC_CURATOR_TOKEN_FILE));
  await assert.rejects(() => intakeFabricProposal(root, linkedFixture.config, { proposalId: PROPOSAL_ID, dispatch: false }, { ...runtime, env: linkedFixture.env }), /non-writable parent/);
  fs.unlinkSync(linkedParent);
  assert.equal(renderMemoryRecord(record()).includes("A bounded synthetic transport fact"), false);
});

test("decision replay scans past an ACK prefix and persists an authenticated bounded cursor", async () => {
  const root = workspace(); const state = fs.mkdtempSync(path.join(os.tmpdir(), "pam-fabric-state-")); fs.chmodSync(state, 0o700);
  const fixture = config(root); const proposals = new Map(); let posts = 0;
  for (let index = 1; index <= 4; index += 1) {
    const proposalId = `proposal-starvation-000${index}`;
    const candidate = record(); candidate.id = `mem_transport_0000000${index}`;
    candidate.claim.ciphertext = Buffer.from(`bounded-${index}`).toString("base64");
    candidate.provenance[0].eventId = `event-transport-000${index}`;
    candidate.provenance[0].contentSha256 = String(index).repeat(64);
    candidate.claim.aadSha256 = aadSha256For(candidate);
    const payload = { type: "canonical-memory-proposal", actor: "agent:vitae", scope: candidate.scope.id, record: candidate, rationale: `synthetic evidence ${index}`, expectedRevision: 0 };
    proposals.set(proposalId, { proposalId, status: "queued", payload, proposalDigest: sha(canonicalize(payload)) });
  }
  const runtime = {
    env: fixture.env, ledgerKey: LEDGER_KEY, reviewerToken: REVIEWER_TOKEN, stateDir: state,
    requestJson: async request => {
      if (request.method === "GET") return { ok: true, data: proposals.get(decodeURIComponent(request.pathname.split("/").at(-1))), meta: { requestId: "ack-read" } };
      posts += 1; return { ok: true, data: { proposalId: request.body.proposalId, status: request.body.status }, meta: { requestId: `ack-${posts}` } };
    }
  };
  for (const proposalId of proposals.keys()) assert.equal((await intakeFabricProposal(root, fixture.config, { proposalId, dispatch: false }, runtime)).ok, true);
  const first = await replayFabricDecisionOutbox(root, fixture.config, { limit: 3, maxPages: 1 }, runtime);
  assert.equal(first.processed, 3); assert.equal(first.scanned, 3);
  const cursorPath = path.join(root, "memory/amf/curator/fabric-replay-cursor.json");
  assert.equal(fs.existsSync(cursorPath), true);
  fs.unlinkSync(cursorPath); // Force the repro shape: ACK prefix larger than the next action limit.
  const second = await replayFabricDecisionOutbox(root, fixture.config, { limit: 1, maxPages: 4 }, runtime);
  assert.equal(second.processed, 1); assert.equal(second.scanned, 4); assert.equal(second.results[0].duplicate, false);
  assert.equal(posts, 4);
});
