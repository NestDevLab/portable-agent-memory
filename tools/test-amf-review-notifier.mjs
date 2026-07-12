import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalize } from "./lib/amf-memory-record.mjs";
import { relayReviewNotifications, scanReviewNotifications, SCAN_SCHEMA } from "./lib/amf-review-notifier.mjs";
import { submitCuratorCandidate } from "./lib/memory-curator.mjs";

const LEDGER_KEY = "review-notifier-ledger-key-0000000000000000000000001";
const REVIEWER_TOKEN = "review-notifier-reviewer-token-0001";
const SCOPE = "room:synthetic:review";
function sha(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function mac(value) { const copy = { ...value }; delete copy.artifactMac; return crypto.createHmac("sha256", LEDGER_KEY).update(canonicalize(copy)).digest("hex"); }
function workspace() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-review-notifier-")); fs.mkdirSync(path.join(root, "memory/graph"), { recursive: true }); for (const name of ["nodes.jsonl", "edges.jsonl", "aliases.jsonl"]) fs.writeFileSync(path.join(root, "memory/graph", name), ""); return root; }
function config() { return { protectedPaths: ["AGENTS.md", "memory/agent-memory", "memory/sources"], amfCurator: { version: "amf-curator-policy/v1", autoPromote: false, minimumConfidence: 0.98, autoScopes: ["room"], autoVisibilities: ["shared"], requireReviewForLifecycleChange: true, requireReviewForSupersession: true, rejectOnWarnings: true, ledgerKeyEnv: "PAM_CURATOR_LEDGER_KEY", stateDirEnv: "PAM_CURATOR_STATE_DIR", reviewerTokenEnv: "PAM_CURATOR_REVIEWER_TOKEN", reviewers: [{ tokenSha256: sha(REVIEWER_TOKEN), actorId: "service:synthetic-reviewer", capabilities: ["memory:curate"] }], gitWriter: { enabled: false, dryRunOnly: true, protectedBranches: ["main"] } } }; }
function record() { const timestamp = "2026-07-12T20:00:00Z"; return { schema: "amf-memory/v1", id: "mem_12345678-1234-4234-8234-123456789abc", revision: 1, claimType: "fact", scope: { type: "room", id: SCOPE }, visibility: "shared", confidence: { score: 0.81, basis: "inferred", assessedAt: timestamp }, subjects: [{ identityId: "agent:12345678-1234-4234-8234-123456789abc", role: "owner" }], claim: { encoding: "plain", text: "Private candidate text must never enter a notification." }, lifecycle: { status: "active", validFrom: timestamp, validTo: null, supersedes: [], revokedAt: null, revocationReason: null }, provenance: [{ sourceType: "synthetic-test", sourceId: "source-private", eventId: "event-review-0001", contentSha256: "a".repeat(64), capturedAt: timestamp }], createdAt: timestamp, updatedAt: timestamp }; }
function render(value) { return `---\n${Object.entries(value).map(([key, item]) => `${key}: ${item !== null && typeof item === "object" ? JSON.stringify(item) : String(item)}`).join("\n")}\n---\n`; }

test("scanner emits only authenticated metadata after Fabric ACK", () => {
  const root = workspace(); const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pam-review-state-")); fs.chmodSync(stateDir, 0o700);
  const proposalId = "proposal-review-0001"; const proposalDigest = "b".repeat(64);
  const result = submitCuratorCandidate(root, config(), { content: render(record()), rationale: "synthetic", idempotencyKey: "review-notifier-0001", confidence: 0.81, source: { type: "fabric", id: proposalId }, fabricProposal: { proposalId, proposalDigest } }, { ledgerKey: LEDGER_KEY, reviewerToken: REVIEWER_TOKEN, stateDir });
  assert.equal(result.ok, true, result.error); assert.equal(result.status, "review_required");
  const outbox = { schema: "amf-fabric-transport/v1/decision-outbox", phase: "fabric_acked", receipt: result.fabricReceipt, ack: { ackId: "ack-review-0001", acknowledgedAt: "2026-07-12T20:01:00Z" } }; outbox.artifactMac = mac(outbox);
  const outboxDir = path.join(root, "memory/amf/curator/fabric-outbox"); fs.mkdirSync(outboxDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(outboxDir, `${result.decisionId}.json`), `${JSON.stringify(outbox)}\n`, { mode: 0o600 });
  const scan = scanReviewNotifications(root, config(), { scope: SCOPE }, { ledgerKey: LEDGER_KEY, reviewerToken: REVIEWER_TOKEN, stateDir });
  assert.equal(scan.events.length, 1); assert.equal(scan.events[0].proposalId, proposalId); assert.equal(scan.events[0].confidence, 0.81); assert.ok(scan.events[0].reasonCodes.includes("auto-promotion-disabled"));
  const text = JSON.stringify(scan); assert.equal(text.includes("Private candidate"), false); assert.equal(text.includes("source-private"), false);
  const tampered = { ...outbox, phase: "queued" }; fs.writeFileSync(path.join(outboxDir, `${result.decisionId}.json`), JSON.stringify(tampered)); assert.throws(() => scanReviewNotifications(root, config(), { scope: SCOPE }, { ledgerKey: LEDGER_KEY, reviewerToken: REVIEWER_TOKEN, stateDir }), /authentication failed/);
});

function event() { return { decisionId: `decision-${"c".repeat(40)}`, decisionDigest: "d".repeat(64), proposalId: "proposal-review-0002", scope: SCOPE, confidence: 0.72, reasonCodes: ["below-confidence-threshold"], createdAt: "2026-07-12T20:00:00Z" }; }
function relayFixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-review-relay-")); fs.chmodSync(root, 0o700); const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "pam-review-target-")); fs.chmodSync(secrets, 0o700); const targetFile = path.join(secrets, "discord.target"); fs.writeFileSync(targetFile, "123456789012345678\n", { mode: 0o600 }); return { root, targetFile }; }

test("relay is metadata-only, durable and idempotent", () => {
  const fixture = relayFixture(); const calls = []; const exec = (_file, args) => { calls.push(args); return args[1] === "read" ? JSON.stringify({ messages: [] }) : JSON.stringify({ ok: true }); }; const scan = { schema: SCAN_SCHEMA, events: [event()] };
  const first = relayReviewNotifications(scan, { stateDir: fixture.root, targetFile: fixture.targetFile }, { execFileSync: exec }); assert.equal(first.sent, 1); assert.equal(first.pending, 0);
  const sent = calls.find(args => args[1] === "send").join("\n"); assert.match(sent, /AMF-REVIEW:/); assert.match(sent, /below-confidence-threshold/); assert.doesNotMatch(sent, /claim|ciphertext|source-private/);
  calls.length = 0; const retry = relayReviewNotifications(scan, { stateDir: fixture.root, targetFile: fixture.targetFile }, { execFileSync: exec }); assert.equal(retry.sent, 0); assert.equal(calls.some(args => args[1] === "send"), false);
  assert.throws(() => relayReviewNotifications({ schema: SCAN_SCHEMA, events: [{ ...event(), payload: "private" }] }, { dryRun: true }, {}), /invalid/);
});

test("relay reconciles uncertain delivery through the stable marker", () => {
  const fixture = relayFixture(); const scan = { schema: SCAN_SCHEMA, events: [event()] }; let phase = "fail"; let sends = 0;
  const exec = (_file, args) => { if (args[1] === "read") { if (phase === "no-history") throw new Error("offline"); return JSON.stringify({ messages: phase === "delivered" ? [{ content: `AMF-REVIEW:${event().decisionId}` }] : [] }); } sends += 1; throw new Error("ambiguous delivery"); };
  const failed = relayReviewNotifications(scan, { stateDir: fixture.root, targetFile: fixture.targetFile }, { execFileSync: exec }); assert.equal(failed.pending, 1); assert.equal(sends, 1);
  phase = "no-history"; const held = relayReviewNotifications(scan, { stateDir: fixture.root, targetFile: fixture.targetFile }, { execFileSync: exec }); assert.equal(held.pending, 1); assert.equal(sends, 1);
  phase = "delivered"; const reconciled = relayReviewNotifications(scan, { stateDir: fixture.root, targetFile: fixture.targetFile }, { execFileSync: exec }); assert.equal(reconciled.sent, 1); assert.equal(reconciled.pending, 0); assert.equal(sends, 1);
});
