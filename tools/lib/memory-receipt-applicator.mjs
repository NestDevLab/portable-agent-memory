import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalize } from "./amf-memory-record.mjs";
import { applyProposal, proposalArtifactDigest } from "./memory-apply-proposal.mjs";
import {
  ensureCuratorProposal,
  loadApprovedDecisionBundle,
  verifyAppliedCandidate
} from "./memory-curator.mjs";
import {
  acquireExclusiveLock,
  assertNoSymlinkPath,
  atomicWriteFileSync,
  readFileNoFollowSync
} from "./secure-fs.mjs";
import { workspaceRelative } from "./workspace.mjs";

const APPLICATOR_SCHEMA = "amf-receipt-applicator/v1";
const APPLICATOR_ROOT = path.join("memory", "amf", "applicator");
const STATE_DIR = path.join(APPLICATOR_ROOT, "state");
const OUTBOX_DIR = path.join(APPLICATOR_ROOT, "outbox");
const HASH_RE = /^[0-9a-f]{64}$/;
const SAFE_ACTOR_RE = /^(?:agent|person|service):[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const PHASES = new Set(["prepared", "pam_applied", "receipt_queued", "fabric_acked"]);
const DEFAULT_APPLICATOR = Object.freeze({
  version: APPLICATOR_SCHEMA,
  tokenEnv: "PAM_APPLICATOR_TOKEN",
  applicators: [],
  transport: {
    kind: "disabled",
    endpointEnv: "PAM_FABRIC_RECEIPT_ENDPOINT"
  }
});

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function hmacSha256(key, value) {
  return crypto.createHmac("sha256", key).update(String(value), "utf8").digest("hex");
}

function secureDigestEqual(left, right) {
  if (!HASH_RE.test(String(left ?? "")) || !HASH_RE.test(String(right ?? ""))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, required = allowed) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && [...required].every((key) => Object.hasOwn(value, key));
}

function applicatorPolicy(config = {}) {
  const configured = isPlainObject(config.amfApplicator) ? config.amfApplicator : {};
  const transport = isPlainObject(configured.transport) ? configured.transport : {};
  const policy = {
    ...DEFAULT_APPLICATOR,
    ...configured,
    applicators: Array.isArray(configured.applicators) ? configured.applicators.map((row) => ({ ...row })) : [],
    transport: { ...DEFAULT_APPLICATOR.transport, ...transport }
  };
  if (policy.version !== APPLICATOR_SCHEMA) throw new Error(`unsupported applicator policy: ${policy.version}`);
  if (typeof policy.tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.tokenEnv)) {
    throw new Error("amfApplicator.tokenEnv is invalid");
  }
  for (const actor of policy.applicators) {
    if (!exactKeys(actor, new Set(["tokenSha256", "actorId", "capabilities"]))
        || !HASH_RE.test(String(actor.tokenSha256 ?? ""))
        || !SAFE_ACTOR_RE.test(String(actor.actorId ?? ""))
        || !Array.isArray(actor.capabilities)
        || actor.capabilities.some((value) => value !== "memory:apply-receipt")) {
      throw new Error("amfApplicator.applicators contains an invalid allowlist entry");
    }
  }
  if (!new Set(["disabled", "http"]).has(policy.transport.kind)) {
    throw new Error("amfApplicator.transport.kind must be disabled or http");
  }
  if (policy.transport.kind === "http"
      && (typeof policy.transport.endpointEnv !== "string"
        || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.transport.endpointEnv))) {
    throw new Error("amfApplicator HTTP endpointEnv is invalid");
  }
  return policy;
}

function authorizeApplicator(policy, runtime = {}) {
  const token = runtime.applicatorToken ?? process.env[policy.tokenEnv];
  if (typeof token !== "string" || token.length < 16) {
    return { ok: false, error: "memory applicator capability is not configured server-side" };
  }
  const digest = sha256(token);
  const actor = policy.applicators.find((row) => secureDigestEqual(row.tokenSha256, digest));
  if (!actor || !actor.capabilities.includes("memory:apply-receipt")) {
    return { ok: false, error: "memory applicator lacks memory:apply-receipt" };
  }
  return { ok: true, actorId: actor.actorId, key: Buffer.from(token, "utf8") };
}

function ensureLayout(workspaceRoot) {
  const root = path.join(workspaceRoot, APPLICATOR_ROOT);
  assertNoSymlinkPath(workspaceRoot, root);
  fs.mkdirSync(path.join(workspaceRoot, STATE_DIR), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspaceRoot, OUTBOX_DIR), { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(workspaceRoot, root, { allowMissing: false });
  assertNoSymlinkPath(workspaceRoot, path.join(workspaceRoot, STATE_DIR), { allowMissing: false });
  assertNoSymlinkPath(workspaceRoot, path.join(workspaceRoot, OUTBOX_DIR), { allowMissing: false });
}

function artifactMac(key, value) {
  const copy = { ...value };
  delete copy.artifactMac;
  return hmacSha256(key, canonicalize(copy));
}

function applyIdFor(decisionId, idempotencyKey) {
  return `apply-${sha256(`${APPLICATOR_SCHEMA}\0${decisionId}\0${sha256(idempotencyKey)}`).slice(0, 40)}`;
}

function statePath(workspaceRoot, applyId) {
  return path.join(workspaceRoot, STATE_DIR, `${applyId}.json`);
}

function outboxPath(workspaceRoot, applyId) {
  return path.join(workspaceRoot, OUTBOX_DIR, `${applyId}.json`);
}

function readJson(workspaceRoot, absolute, label) {
  try {
    const parsed = JSON.parse(readFileNoFollowSync(workspaceRoot, absolute));
    if (!isPlainObject(parsed)) throw new Error("top-level JSON must be an object");
    return { ok: true, record: parsed };
  } catch (error) {
    return { ok: false, error: `${label} is invalid: ${error.message}` };
  }
}

function validState(state, key) {
  return state?.schema === `${APPLICATOR_SCHEMA}/state`
    && /^apply-[0-9a-f]{40}$/.test(String(state.applyId ?? ""))
    && HASH_RE.test(String(state.inputDigest ?? ""))
    && /^decision-[0-9a-f]{40}$/.test(String(state.decisionId ?? ""))
    && /^candidate-[0-9a-f]{40}$/.test(String(state.candidateId ?? ""))
    && HASH_RE.test(String(state.decisionDigest ?? ""))
    && HASH_RE.test(String(state.policyDigestAtApply ?? ""))
    && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(String(state.proposalId ?? ""))
    && HASH_RE.test(String(state.proposalDigest ?? ""))
    && PHASES.has(state.phase)
    && (state.receipt === null || isPlainObject(state.receipt))
    && (state.ack === null || isPlainObject(state.ack))
    && HASH_RE.test(String(state.artifactMac ?? ""))
    && secureDigestEqual(artifactMac(key, state), state.artifactMac);
}

function writeState(workspaceRoot, key, state) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  next.artifactMac = artifactMac(key, next);
  atomicWriteFileSync(workspaceRoot, statePath(workspaceRoot, state.applyId), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

function proposalArtifactPath(workspaceRoot, proposalId) {
  return path.join(workspaceRoot, "memory", "maintenance", "proposals", `${proposalId}.json`);
}

function buildReceipt(state, bundle, verified) {
  return {
    schema: `${APPLICATOR_SCHEMA}/apply-receipt`,
    receiptType: "memory_apply_receipt",
    applyId: state.applyId,
    proposalId: state.proposalId,
    decisionId: bundle.decisionReceipt.decisionId,
    decisionDigest: bundle.decisionReceipt.decisionDigest,
    policyDigestAtApply: state.policyDigestAtApply,
    canonicalRecordId: bundle.decisionReceipt.canonicalRecordId,
    revision: bundle.decisionReceipt.candidateRevision,
    canonicalLifecycleAtDecision: bundle.decisionReceipt.canonicalLifecycleAtDecision,
    proposalDigest: state.proposalDigest,
    archiveDigest: verified.appliedArchiveSha256,
    targetDigest: bundle.candidate.recordSha256,
    appliedAt: verified.archive.appliedAt
  };
}

function writeOutbox(workspaceRoot, key, receipt) {
  const absolute = outboxPath(workspaceRoot, receipt.applyId);
  const artifact = { ...receipt };
  artifact.artifactMac = artifactMac(key, artifact);
  if (fs.existsSync(absolute)) {
    const loaded = readJson(workspaceRoot, absolute, "apply receipt outbox");
    if (!loaded.ok || !secureDigestEqual(artifactMac(key, loaded.record), loaded.record.artifactMac)
        || canonicalize(loaded.record) !== canonicalize(artifact)) {
      return { ok: false, error: "apply receipt outbox conflict" };
    }
    return { ok: true, artifact: loaded.record, duplicate: true };
  }
  atomicWriteFileSync(workspaceRoot, absolute, `${JSON.stringify(artifact, null, 2)}\n`, { exclusive: true, mode: 0o600 });
  return { ok: true, artifact, duplicate: false };
}

function dispatchReceipt(policy, state, runtime = {}) {
  if (typeof runtime.transportSink === "function") {
    const response = runtime.transportSink(state.receipt);
    if (!isPlainObject(response) || response.ok !== true
        || typeof response.ackId !== "string" || response.ackId.trim() === "") {
      return { ok: false, error: "Fabric receipt sink did not return a durable ack" };
    }
    return { ok: true, ack: { ackId: response.ackId, acknowledgedAt: response.acknowledgedAt ?? new Date().toISOString() } };
  }
  if (policy.transport.kind === "http") {
    const endpoint = process.env[policy.transport.endpointEnv];
    if (typeof endpoint !== "string" || !endpoint.startsWith("https://")) {
      return { ok: false, error: "Fabric HTTP receipt endpoint is missing or not HTTPS; receipt remains queued" };
    }
    return { ok: false, error: "live HTTP dispatch is disabled in PAM; inject an audited transport sink" };
  }
  return { ok: true, queued: true };
}

function applyDecisionReceipt(workspaceRoot, config, input, runtime = {}) {
  const allowed = new Set(["decisionId", "idempotencyKey", "dispatch"]);
  const required = new Set(["decisionId", "idempotencyKey"]);
  if (!exactKeys(input, allowed, required)
      || !/^decision-[0-9a-f]{40}$/.test(String(input.decisionId ?? ""))
      || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 256
      || (input.dispatch !== undefined && typeof input.dispatch !== "boolean")) {
    return { ok: false, error: "applicator input is invalid or contains unknown fields" };
  }
  let policy;
  try { policy = applicatorPolicy(config); } catch (error) { return { ok: false, error: error.message }; }
  const authorized = authorizeApplicator(policy, runtime);
  if (!authorized.ok) return authorized;
  const bundle = loadApprovedDecisionBundle(workspaceRoot, config, { decisionId: input.decisionId }, runtime);
  if (!bundle.ok) return bundle;
  ensureLayout(workspaceRoot);
  const applyId = applyIdFor(input.decisionId, input.idempotencyKey);
  const inputDigest = sha256(canonicalize({
    decisionId: input.decisionId,
    idempotencyKeySha256: sha256(input.idempotencyKey)
  }));
  const lockAbsolute = path.join(workspaceRoot, APPLICATOR_ROOT, `${applyId}.lock`);
  let lock;
  try { lock = acquireExclusiveLock(workspaceRoot, lockAbsolute); }
  catch (error) { return { ok: false, error: `applicator is already running: ${error.message}` }; }
  try {
    let state;
    const absolute = statePath(workspaceRoot, applyId);
    if (fs.existsSync(absolute)) {
      const loaded = readJson(workspaceRoot, absolute, "applicator state");
      if (!loaded.ok || !validState(loaded.record, authorized.key)
          || loaded.record.inputDigest !== inputDigest
          || loaded.record.decisionId !== input.decisionId
          || loaded.record.decisionDigest !== bundle.decisionReceipt.decisionDigest) {
        return { ok: false, error: `applicator idempotency or decision conflict: ${applyId}` };
      }
      state = loaded.record;
    } else {
      const proposed = ensureCuratorProposal(workspaceRoot, config, bundle.candidate, { sourcePrefix: "pam-amf-applicator" });
      if (!proposed.ok) return proposed;
      const proposalAbsolute = proposalArtifactPath(workspaceRoot, proposed.proposalId);
      if (!fs.existsSync(proposalAbsolute)) return { ok: false, error: "prepared proposal artifact is missing" };
      const proposalText = readFileNoFollowSync(workspaceRoot, proposalAbsolute);
      let proposalRecord;
      try { proposalRecord = JSON.parse(proposalText); }
      catch (error) { return { ok: false, error: `prepared proposal is invalid JSON: ${error.message}` }; }
      state = writeState(workspaceRoot, authorized.key, {
        schema: `${APPLICATOR_SCHEMA}/state`,
        applyId,
        inputDigest,
        decisionId: input.decisionId,
        candidateId: bundle.candidate.candidateId,
        decisionDigest: bundle.decisionReceipt.decisionDigest,
        policyDigestAtApply: bundle.policyDigestAtApply,
        proposalId: proposed.proposalId,
        proposalDigest: proposalArtifactDigest(proposalRecord),
        phase: "prepared",
        receipt: null,
        ack: null,
        updatedAt: new Date().toISOString()
      });
      if (runtime.faultAt === "after-prepared") throw new Error("injected applicator fault after prepared state");
    }

    if (state.phase === "prepared") {
      const applied = applyProposal(workspaceRoot, config, { proposalId: state.proposalId }, {
        expectedProposalDigest: state.proposalDigest,
        ...(typeof runtime.onTargetLockAcquired === "function"
          ? { onTargetLockAcquired: runtime.onTargetLockAcquired }
          : {})
      });
      if (!applied.ok) return { ...applied, applyId, proposalId: state.proposalId };
      if (runtime.faultAt === "after-pam-apply") throw new Error("injected applicator fault after PAM apply");
      const verified = verifyAppliedCandidate(
        workspaceRoot,
        Buffer.from(runtime.ledgerKey ?? process.env[bundle.policy.ledgerKeyEnv], "utf8"),
        bundle.candidate,
        state.proposalId,
        null,
        { sourcePrefix: "pam-amf-applicator" }
      );
      if (!verified.ok) return verified;
      state = writeState(workspaceRoot, authorized.key, {
        ...state,
        phase: "pam_applied",
        receipt: buildReceipt(state, bundle, verified)
      });
      if (runtime.faultAt === "after-pam-applied-state") throw new Error("injected applicator fault after PAM applied state");
    }

    if (state.phase === "pam_applied") {
      const queued = writeOutbox(workspaceRoot, authorized.key, state.receipt);
      if (!queued.ok) return queued;
      state = writeState(workspaceRoot, authorized.key, { ...state, phase: "receipt_queued" });
      if (runtime.faultAt === "after-receipt-queued") throw new Error("injected applicator fault after receipt queued");
    }

    if (state.phase === "receipt_queued" || state.phase === "fabric_acked") {
      const verifiedOutbox = writeOutbox(workspaceRoot, authorized.key, state.receipt);
      if (!verifiedOutbox.ok) return verifiedOutbox;
    }

    if (state.phase === "receipt_queued" && input.dispatch === true) {
      const dispatched = dispatchReceipt(policy, state, runtime);
      if (!dispatched.ok) return { ...dispatched, applyId, status: "receipt_queued" };
      if (dispatched.queued) return { ok: true, status: "receipt_queued", applyId, proposalId: state.proposalId, receipt: state.receipt };
      if (runtime.faultAt === "after-fabric-ack") throw new Error("injected applicator fault after Fabric ack before state update");
      state = writeState(workspaceRoot, authorized.key, { ...state, phase: "fabric_acked", ack: dispatched.ack });
    }

    return {
      ok: true,
      status: state.phase,
      applyId,
      proposalId: state.proposalId,
      receipt: state.receipt,
      ack: state.ack,
      outboxPath: workspaceRelative(workspaceRoot, outboxPath(workspaceRoot, applyId)),
      actorIdSha256: sha256(authorized.actorId)
    };
  } finally {
    lock.release();
  }
}

export {
  APPLICATOR_ROOT,
  APPLICATOR_SCHEMA,
  DEFAULT_APPLICATOR,
  applicatorPolicy,
  applyDecisionReceipt
};
