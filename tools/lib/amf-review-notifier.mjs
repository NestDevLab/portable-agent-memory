import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalize } from "./amf-memory-record.mjs";
import { buildFabricDecisionReceipt, curatorPolicy, curatorStatus } from "./memory-curator.mjs";
import { atomicWriteFileSync, readFileNoFollowSync, readOwnerOnlyFileSync } from "./secure-fs.mjs";

const SCAN_SCHEMA = "amf-review-notification-scan/v1";
const ENVELOPE_SCHEMA = "amf-review-notification-envelope/v1";
const HASH_RE = /^[a-f0-9]{64}$/;
const DECISION_RE = /^decision-[a-f0-9]{40}$/;
const SAFE_SCOPE_RE = /^(agent|person|relationship|room|domain|shared):[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;
const SAFE_REASON_RE = /^[a-z][a-z0-9-]{0,63}$/;

function object(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields) { return object(value) && Object.keys(value).sort().join("\0") === [...fields].sort().join("\0"); }
function sha256(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }
function artifactMac(key, value) {
  const copy = { ...value }; delete copy.artifactMac;
  return crypto.createHmac("sha256", key).update(canonicalize(copy), "utf8").digest("hex");
}
function safeEqual(left, right) {
  if (!HASH_RE.test(String(left)) || !HASH_RE.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function ledgerKey(config, runtime = {}) {
  const policy = curatorPolicy(config);
  const envName = policy.ledgerKeyEnv || "PAM_CURATOR_LEDGER_KEY";
  const value = runtime.ledgerKey ?? (runtime.env || process.env)[envName];
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) throw new Error("review notifier ledger key is unavailable");
  return Buffer.from(value, "utf8");
}

function readAuthenticatedArtifact(workspaceRoot, absolute, key, label) {
  const value = JSON.parse(readFileNoFollowSync(workspaceRoot, absolute));
  if (!safeEqual(value.artifactMac, artifactMac(key, value))) throw new Error(`${label} authentication failed`);
  return value;
}

function validateEvent(event) {
  return exact(event, new Set(["decisionId", "decisionDigest", "proposalId", "scope", "confidence", "reasonCodes", "createdAt"]))
    && DECISION_RE.test(String(event.decisionId)) && HASH_RE.test(String(event.decisionDigest))
    && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(String(event.proposalId))
    && SAFE_SCOPE_RE.test(String(event.scope))
    && typeof event.confidence === "number" && event.confidence >= 0 && event.confidence <= 1
    && Array.isArray(event.reasonCodes) && event.reasonCodes.length <= 16
    && new Set(event.reasonCodes).size === event.reasonCodes.length
    && event.reasonCodes.every(reason => SAFE_REASON_RE.test(String(reason)))
    && Number.isFinite(Date.parse(event.createdAt));
}

function scanReviewNotifications(workspaceRoot, config, input = {}, runtime = {}) {
  const scope = String(input.scope || "");
  const limit = input.limit ?? 50;
  if (!SAFE_SCOPE_RE.test(scope) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("review notification scan input is invalid");
  const status = curatorStatus(workspaceRoot, config, {}, runtime);
  if (!status.ok) throw new Error("curator ledger is not healthy");
  const key = ledgerKey(config, runtime);
  const events = [];
  for (const candidate of status.candidates) {
    const decision = candidate.latestDecision;
    if (decision?.outcome !== "review_required") continue;
    const receiptPath = path.join(workspaceRoot, "memory/amf/curator/decision-receipts", `${decision.decisionId}.json`);
    const outboxPath = path.join(workspaceRoot, "memory/amf/curator/fabric-outbox", `${decision.decisionId}.json`);
    if (!fs.existsSync(receiptPath) || !fs.existsSync(outboxPath)) continue;
    const receipt = readAuthenticatedArtifact(workspaceRoot, receiptPath, key, "decision receipt");
    if (receipt.fabricProposalScope !== scope) continue;
    const outbox = readAuthenticatedArtifact(workspaceRoot, outboxPath, key, "Fabric decision ACK");
    const built = buildFabricDecisionReceipt(receipt);
    if (!built.ok || outbox.phase !== "fabric_acked" || !object(outbox.ack)
        || canonicalize(outbox.receipt) !== canonicalize(built.receipt)
        || receipt.decisionDigest !== decision.decisionDigest || receipt.fabricProposalScope !== scope) {
      throw new Error("review notification is not bound to an acknowledged Fabric decision");
    }
    const event = {
      decisionId: decision.decisionId,
      decisionDigest: decision.decisionDigest,
      proposalId: receipt.fabricProposalId,
      scope,
      confidence: decision.confidence,
      reasonCodes: [...decision.reasonCodes],
      createdAt: receipt.createdAt
    };
    if (!validateEvent(event)) throw new Error("review notification metadata is invalid");
    events.push(event);
  }
  events.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.decisionId.localeCompare(right.decisionId));
  return { schema: SCAN_SCHEMA, events: events.slice(0, limit) };
}

function assertPrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0
      || (typeof process.geteuid === "function" && stat.uid !== process.geteuid())) {
    throw new Error("review notifier state directory must be owner-only");
  }
}

function envelopePath(stateDir, event) {
  return path.join(stateDir, `${sha256(`review-notification\0${event.decisionId}`)}.json`);
}

function writeEnvelope(stateDir, absolute, envelope) {
  atomicWriteFileSync(stateDir, absolute, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(absolute, 0o600);
}

function readEnvelope(stateDir, absolute) {
  const value = JSON.parse(readFileNoFollowSync(stateDir, absolute));
  if (!exact(value, new Set(["schema", "event", "status", "attempts", "lastErrorCode", "updatedAt"]))
      || value.schema !== ENVELOPE_SCHEMA || !validateEvent(value.event)
      || !["pending", "sent"].includes(value.status) || !Number.isSafeInteger(value.attempts) || value.attempts < 0
      || ![null, "delivery_failed", "history_unavailable"].includes(value.lastErrorCode)
      || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("review notifier envelope is invalid");
  return value;
}

function strings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, output);
  else if (object(value)) for (const item of Object.values(value)) strings(item, output);
  return output;
}

function renderMessage(event) {
  const marker = `AMF-REVIEW:${event.decisionId}`;
  return [
    "Memory review required",
    `Marker: ${marker}`,
    `Decision: ${event.decisionId}`,
    `Proposal: ${event.proposalId}`,
    `Scope: ${event.scope}`,
    `Confidence: ${event.confidence.toFixed(3)}`,
    `Reasons: ${event.reasonCodes.join(", ") || "manual-review"}`,
    `Created: ${event.createdAt}`,
    "Review: inspect the private PAM curation ledger, then record an authenticated approve or reject decision."
  ].join("\n");
}

function relayReviewNotifications(scan, options, runtime = {}) {
  if (!exact(scan, new Set(["schema", "events"])) || scan.schema !== SCAN_SCHEMA
      || !Array.isArray(scan.events) || scan.events.length > 100 || scan.events.some(event => !validateEvent(event))) {
    throw new Error("review notification scan payload is invalid");
  }
  if (options.dryRun === true) return { ok: true, mode: "dry-run", discovered: scan.events.length, queued: 0, sent: 0, pending: scan.events.length };
  const stateDir = path.resolve(String(options.stateDir || ""));
  assertPrivateDirectory(stateDir);
  const target = readOwnerOnlyFileSync(options.targetFile, { label: "Discord target file", maxBytes: 128 }).trim();
  if (!/^[0-9]{16,24}$/.test(target)) throw new Error("Discord target file is invalid");
  const openclaw = path.resolve(String(options.openclawBin || "/usr/local/bin/openclaw"));
  const exec = runtime.execFileSync;
  if (typeof exec !== "function") throw new Error("review notifier dispatcher is unavailable");
  const now = runtime.now || (() => new Date());
  let queued = 0; let sent = 0; let pending = 0;

  for (const event of scan.events) {
    const absolute = envelopePath(stateDir, event);
    if (!fs.existsSync(absolute)) {
      writeEnvelope(stateDir, absolute, { schema: ENVELOPE_SCHEMA, event, status: "pending", attempts: 0, lastErrorCode: null, updatedAt: now().toISOString() });
      queued += 1;
    } else {
      const existing = readEnvelope(stateDir, absolute);
      if (canonicalize(existing.event) !== canonicalize(event)) throw new Error("review notifier envelope conflict");
    }
  }

  let history = null;
  try {
    const result = exec(openclaw, ["message", "read", "--channel", "discord", "--target", `channel:${target}`, "--limit", "100", "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    history = strings(JSON.parse(result)).join("\n");
  } catch {}

  for (const event of scan.events) {
    const absolute = envelopePath(stateDir, event);
    let envelope = readEnvelope(stateDir, absolute);
    if (envelope.status === "sent") continue;
    const marker = `AMF-REVIEW:${event.decisionId}`;
    if (history?.includes(marker)) {
      envelope = { ...envelope, status: "sent", lastErrorCode: null, updatedAt: now().toISOString() };
      writeEnvelope(stateDir, absolute, envelope); sent += 1; continue;
    }
    if (envelope.attempts > 0 && history === null) {
      envelope = { ...envelope, lastErrorCode: "history_unavailable", updatedAt: now().toISOString() };
      writeEnvelope(stateDir, absolute, envelope); pending += 1; continue;
    }
    envelope = { ...envelope, attempts: envelope.attempts + 1, lastErrorCode: null, updatedAt: now().toISOString() };
    writeEnvelope(stateDir, absolute, envelope);
    try {
      exec(openclaw, ["message", "send", "--channel", "discord", "--target", `channel:${target}`, "--message", renderMessage(event), "--silent", "--json"], { encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      envelope = { ...envelope, status: "sent", updatedAt: now().toISOString() };
      writeEnvelope(stateDir, absolute, envelope); sent += 1;
    } catch {
      envelope = { ...envelope, lastErrorCode: "delivery_failed", updatedAt: now().toISOString() };
      writeEnvelope(stateDir, absolute, envelope); pending += 1;
    }
  }
  return { ok: pending === 0, mode: "relay", discovered: scan.events.length, queued, sent, pending };
}

export { ENVELOPE_SCHEMA, SCAN_SCHEMA, relayReviewNotifications, scanReviewNotifications };
