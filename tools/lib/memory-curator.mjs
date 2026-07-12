import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  canonicalize,
  parseMemoryRecord,
  recordPathFor,
  recordSha256,
  validateMemoryRecord,
  validateMemoryRecordTransition
} from "./amf-memory-record.mjs";
import { proposeEdit, proposeMemoryRecord } from "./memory-proposals.mjs";
import {
  acquireExclusiveLock,
  assertNoSymlinkPath,
  atomicWriteFileSync,
  readFileNoFollowSync
} from "./secure-fs.mjs";
import { toPosixPath, workspaceRelative } from "./workspace.mjs";

const CURATOR_SCHEMA = "amf-curator/v1";
const CURATOR_ROOT = path.join("memory", "amf", "curator");
const QUEUE_DIR = path.join(CURATOR_ROOT, "queue");
const REVIEWS_DIR = path.join(CURATOR_ROOT, "reviews");
const DECISION_RECEIPTS_DIR = path.join(CURATOR_ROOT, "decision-receipts");
const LEDGER_PATH = path.join(CURATOR_ROOT, "decisions.jsonl");
const WORKSPACE_SENTINEL_PATH = path.join("memory", "amf", "curator.initialized.json");
const CANDIDATE_ID_RE = /^candidate-[0-9a-f]{40}$/;
const DECISION_ID_RE = /^decision-[0-9a-f]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DEFAULT_POLICY = Object.freeze({
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
  reviewers: [],
  gitWriter: {
    enabled: false,
    dryRunOnly: true,
    protectedBranches: ["main", "master", "main-integration"]
  }
});

const EVENT_FIELDS = new Set([
  "schema", "eventId", "sequence", "occurredAt", "type", "candidateId",
  "decisionId", "details", "previousEventMac", "eventMac"
]);
const EVENT_DETAIL_FIELDS = Object.freeze({
  "candidate-received": new Set([
    "recordRefHmac", "revision", "scopeType", "visibility", "changeKind",
    "recordSha256", "sourceClass", "sourceRefHmac"
  ]),
  "decision-recorded": new Set([
    "action", "confidence", "apply", "actorIdSha256", "reviewerLabelSha256",
    "supersedesDecisionId", "reasonCodes"
  ]),
  "proposal-recorded": new Set([
    "proposalId", "targetRefHmac", "proposedContentSha256", "expectedRevision"
  ]),
  "proposal-applied": new Set([
    "proposalId", "targetRefHmac", "persistedContentSha256", "recordRefHmac",
    "revision", "appliedArchiveSha256"
  ])
});
const SCOPE_TYPES = new Set(["agent", "person", "relationship", "room", "domain", "shared"]);
const VISIBILITIES = new Set(["private", "restricted", "shared", "confidential"]);
const CHANGE_KINDS = new Set(["create", "revision", "revoke", "supersede", "expire", "superseding-create"]);
const REVIEW_ACTIONS = new Set(["review", "duplicate", "approve", "reject"]);
const REVIEW_ARTIFACT_FIELDS = new Set([
  "schema", "decisionId", "candidateId", "candidateRecordSha256", "candidateRevision",
  "createdAt", "inputSha256", "decisionKeySha256", "supersedesDecisionId",
  "action", "rationale", "reviewerLabel", "actorId", "confidence", "apply",
  "reasons", "artifactMac"
]);
const DECISION_RECEIPT_FIELDS = new Set([
  "schema", "receiptType", "outcome", "decisionId", "candidateId",
  "candidateRecordSha256", "candidateRevision", "canonicalRecordId",
  "canonicalLifecycleAtDecision", "fabricProposalId", "fabricProposalScope", "fabricProposalDigest",
  "policyDigest", "createdAt", "decisionDigest",
  "artifactMac"
]);
const DECISION_OUTCOMES = new Set(["review_required", "rejected", "approved_pending_apply"]);
const SOURCE_CLASSES = new Set(["codex", "claude", "hermes", "openclaw", "principia", "fabric", "operator", "migration", "synthetic", "other"]);
const SAFE_CODE_RE = /^[a-z][a-z0-9-]{1,63}$/;
const SAFE_ACTOR_RE = /^(?:agent|person|service):[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RATIONALE_BYTES = 4 * 1024;

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

function exactKeys(value, allowed, required = allowed) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && [...required].every((key) => Object.hasOwn(value, key));
}

function isTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function resolveLedgerKey(policy, runtime = {}) {
  const value = runtime.ledgerKey ?? process.env[policy.ledgerKeyEnv];
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    return { ok: false, error: `authoritative curator operation requires a >=32-byte key in ${policy.ledgerKeyEnv}` };
  }
  return { ok: true, key: Buffer.from(value, "utf8") };
}

function pathIsInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveStateContext(workspaceRoot, policy, runtime = {}) {
  const configured = runtime.stateDir ?? process.env[policy.stateDirEnv];
  if (typeof configured !== "string" || !path.isAbsolute(configured)) {
    return { ok: false, error: `authoritative curator operation requires an absolute provisioned state root in ${policy.stateDirEnv}` };
  }
  const requested = path.resolve(configured);
  let realState;
  let realWorkspace;
  try {
    const stats = fs.lstatSync(requested);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700
        || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
      return { ok: false, error: "curator state root must be a real 0700 directory" };
    }
    realState = fs.realpathSync(requested);
    realWorkspace = fs.realpathSync(workspaceRoot);
  } catch (error) {
    return { ok: false, error: `curator state root is not provisioned: ${error.message}` };
  }
  if (realState !== requested) return { ok: false, error: "curator state root contains a symlink component" };
  if (pathIsInside(realWorkspace, realState) || pathIsInside(realState, realWorkspace)) {
    return { ok: false, error: "curator state root must be outside the workspace/repository" };
  }
  const workspaceId = sha256(realWorkspace);
  return {
    ok: true,
    root: realState,
    workspaceId,
    anchorPath: path.join(realState, `${workspaceId}.anchor.json`),
    initializedPath: path.join(realState, `${workspaceId}.initialized.json`),
    workspaceSentinelPath: path.join(realWorkspace, WORKSPACE_SENTINEL_PATH)
  };
}

function authorizeReviewer(policy, runtime, capabilities) {
  const token = runtime?.reviewerToken ?? process.env[policy.reviewerTokenEnv];
  if (typeof token !== "string" || token.length < 16) return { ok: false, error: "reviewer capability is not configured server-side" };
  const tokenSha256 = sha256(token);
  const actor = policy.reviewers.find((entry) => secureDigestEqual(entry.tokenSha256, tokenSha256));
  if (!actor) return { ok: false, error: "reviewer capability is unauthorized" };
  if (!SAFE_ACTOR_RE.test(String(actor.actorId ?? "")) || !Array.isArray(actor.capabilities)) {
    return { ok: false, error: "reviewer allowlist entry is malformed" };
  }
  const missing = capabilities.filter((capability) => !actor.capabilities.includes(capability));
  if (missing.length > 0) return { ok: false, error: `reviewer capability missing: ${missing.join(",")}` };
  return { ok: true, actorId: actor.actorId, capabilities: [...actor.capabilities] };
}

function safeStableId(prefix, seed) {
  return `${prefix}-${sha256(`${CURATOR_SCHEMA}\0${seed}`).slice(0, 40)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateStableKey(value, label) {
  if (typeof value !== "string" || value.length < 8 || value.length > 256 || /[\r\n\0]/.test(value)) {
    return `${label} must be a stable string of 8-256 characters without control newlines`;
  }
  return null;
}

function normalizeConfidence(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function normalizeSource(input) {
  const source = input?.source;
  if (!isPlainObject(source)
      || typeof source.type !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/.test(source.type)
      || typeof source.id !== "string" || source.id.length < 1 || source.id.length > 256
      || /[\r\n\0]/.test(source.id)) {
    return { ok: false, error: "source must contain a stable type and id; RAW payloads are not accepted" };
  }
  if (Object.keys(source).sort().join(",") !== "id,type") {
    return { ok: false, error: "source accepts exactly type and id; RAW payloads are not accepted" };
  }
  return { ok: true, source: { type: source.type, id: source.id } };
}

function normalizeFabricProposal(input, source) {
  const binding = input?.fabricProposal;
  if (source.type !== "fabric") {
    return binding === undefined ? { ok: true, binding: null } : { ok: false, error: "fabricProposal is accepted only for source.type=fabric" };
  }
  if (!exactKeys(binding, new Set(["proposalId", "proposalDigest"]))
      || typeof binding.proposalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(binding.proposalId)
      || !HASH_RE.test(String(binding.proposalDigest ?? ""))) {
    return { ok: false, error: "source.type=fabric requires an exact proposalId/proposalDigest binding" };
  }
  return { ok: true, binding: { proposalId: binding.proposalId, proposalDigest: binding.proposalDigest } };
}

function curatorPolicy(config = {}) {
  const configured = isPlainObject(config.amfCurator) ? config.amfCurator : {};
  const gitWriter = isPlainObject(configured.gitWriter) ? configured.gitWriter : {};
  const policy = {
    ...DEFAULT_POLICY,
    ...configured,
    autoScopes: Array.isArray(configured.autoScopes) ? [...configured.autoScopes] : [...DEFAULT_POLICY.autoScopes],
    autoVisibilities: Array.isArray(configured.autoVisibilities)
      ? [...configured.autoVisibilities]
      : [...DEFAULT_POLICY.autoVisibilities],
    reviewers: Array.isArray(configured.reviewers) ? configured.reviewers.map((entry) => ({ ...entry })) : [],
    gitWriter: {
      ...DEFAULT_POLICY.gitWriter,
      ...gitWriter,
      protectedBranches: Array.isArray(gitWriter.protectedBranches)
        ? [...gitWriter.protectedBranches]
        : [...DEFAULT_POLICY.gitWriter.protectedBranches]
    }
  };
  if (policy.version !== DEFAULT_POLICY.version) throw new Error(`unsupported curator policy: ${policy.version}`);
  if (typeof policy.autoPromote !== "boolean") throw new Error("amfCurator.autoPromote must be boolean");
  if (typeof policy.minimumConfidence !== "number" || policy.minimumConfidence < 0 || policy.minimumConfidence > 1) {
    throw new Error("amfCurator.minimumConfidence must be between 0 and 1");
  }
  for (const [label, values] of [["autoScopes", policy.autoScopes], ["autoVisibilities", policy.autoVisibilities]]) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || value === "")) {
      throw new Error(`amfCurator.${label} must be a string array`);
    }
  }
  if (typeof policy.ledgerKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.ledgerKeyEnv)
      || typeof policy.stateDirEnv !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.stateDirEnv)
      || typeof policy.reviewerTokenEnv !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.reviewerTokenEnv)) {
    throw new Error("curator security environment variable names are invalid");
  }
  for (const reviewer of policy.reviewers) {
    if (!isPlainObject(reviewer) || !exactKeys(reviewer, new Set(["tokenSha256", "actorId", "capabilities"]))
        || !HASH_RE.test(String(reviewer.tokenSha256 ?? "")) || !SAFE_ACTOR_RE.test(String(reviewer.actorId ?? ""))
        || !Array.isArray(reviewer.capabilities)
        || reviewer.capabilities.some((value) => !new Set(["memory:curate"]).has(value))) {
      throw new Error("amfCurator.reviewers contains an invalid allowlist entry");
    }
  }
  return policy;
}

function ensureCuratorLayout(workspaceRoot) {
  const root = path.join(workspaceRoot, CURATOR_ROOT);
  assertNoSymlinkPath(workspaceRoot, root);
  fs.mkdirSync(path.join(workspaceRoot, QUEUE_DIR), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspaceRoot, REVIEWS_DIR), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspaceRoot, DECISION_RECEIPTS_DIR), { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(workspaceRoot, root, { allowMissing: false });
  assertNoSymlinkPath(workspaceRoot, path.join(workspaceRoot, QUEUE_DIR), { allowMissing: false });
  assertNoSymlinkPath(workspaceRoot, path.join(workspaceRoot, REVIEWS_DIR), { allowMissing: false });
  assertNoSymlinkPath(workspaceRoot, path.join(workspaceRoot, DECISION_RECEIPTS_DIR), { allowMissing: false });
}

function readJsonArtifact(workspaceRoot, absolute, label) {
  try {
    const parsed = JSON.parse(readFileNoFollowSync(workspaceRoot, absolute));
    if (!isPlainObject(parsed)) throw new Error("top-level JSON must be an object");
    return { ok: true, record: parsed };
  } catch (error) {
    return { ok: false, error: `${label} is not valid safe JSON: ${error.message}` };
  }
}

function candidatePath(workspaceRoot, candidateId) {
  return path.join(workspaceRoot, QUEUE_DIR, `${candidateId}.json`);
}

function reviewPath(workspaceRoot, decisionId) {
  return path.join(workspaceRoot, REVIEWS_DIR, `${decisionId}.json`);
}

function decisionReceiptPath(workspaceRoot, decisionId) {
  return path.join(workspaceRoot, DECISION_RECEIPTS_DIR, `${decisionId}.json`);
}

function artifactMac(key, artifact) {
  const copy = { ...artifact };
  delete copy.artifactMac;
  return hmacSha256(key, canonicalize(copy));
}

function listSafeJson(workspaceRoot, relativeDir) {
  const absoluteDir = path.join(workspaceRoot, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  assertNoSymlinkPath(workspaceRoot, absoluteDir, { allowMissing: false });
  const rows = [];
  for (const name of fs.readdirSync(absoluteDir).sort()) {
    if (!name.endsWith(".json")) throw new Error(`bogus curator artifact: ${toPosixPath(path.join(relativeDir, name))}`);
    const absolute = path.join(absoluteDir, name);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe curator artifact: ${toPosixPath(path.relative(workspaceRoot, absolute))}`);
    const loaded = readJsonArtifact(workspaceRoot, absolute, "curator artifact");
    if (!loaded.ok) throw new Error(loaded.error);
    rows.push(loaded.record);
  }
  return rows;
}

function claimFingerprint(metadata) {
  const claimMaterial = metadata.claim.encoding === "plain"
    ? metadata.claim.text.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US")
    : metadata.provenance.map((item) => ({
        sourceType: item.sourceType,
        eventId: item.eventId,
        contentSha256: item.contentSha256
      }));
  return sha256(canonicalize({
    claimType: metadata.claimType,
    scope: metadata.scope,
    subjects: metadata.subjects,
    claimMaterial
  }));
}

function recordSummary(validation) {
  const metadata = validation.metadata;
  return {
    id: metadata.id,
    revision: metadata.revision,
    claimType: metadata.claimType,
    scope: metadata.scope,
    visibility: metadata.visibility,
    confidence: { ...metadata.confidence },
    lifecycleStatus: metadata.lifecycle.status,
    supersedes: [...metadata.lifecycle.supersedes],
    claimEncoding: metadata.claim.encoding
  };
}

function redactedRecordSummary(record) {
  return {
    id: record.id,
    revision: record.revision,
    claimType: record.claimType,
    scopeType: record.scope.type,
    visibility: record.visibility,
    confidence: { ...record.confidence },
    lifecycleStatus: record.lifecycleStatus,
    supersedes: [...record.supersedes],
    claimEncoding: record.claimEncoding
  };
}

function inspectCandidate(workspaceRoot, content) {
  if (typeof content !== "string" || content.trim() === "") {
    return { ok: false, error: "content must be a complete amf-memory/v1 record; RAW payloads are not accepted" };
  }
  const validation = validateMemoryRecord(content, { workspaceRoot });
  if (!validation.ok) {
    return { ok: false, error: `candidate record fails validation: ${validation.errors.join("; ")}`, validation };
  }
  const targetPath = recordPathFor(validation.metadata);
  const absolute = path.join(workspaceRoot, targetPath);
  assertNoSymlinkPath(workspaceRoot, absolute);
  const targetExists = fs.existsSync(absolute);
  let currentContent = null;
  let transition = null;
  let duplicateExisting = false;
  if (targetExists) {
    currentContent = readFileNoFollowSync(workspaceRoot, absolute);
    duplicateExisting = recordSha256(currentContent) === recordSha256(content);
    if (!duplicateExisting) {
      transition = validateMemoryRecordTransition(currentContent, content, {
        expectedPath: targetPath,
        workspaceRoot
      });
      if (!transition.ok) {
        return { ok: false, error: `candidate revision fails transition validation: ${transition.errors.join("; ")}`, validation, transition };
      }
    }
  } else if (validation.metadata.revision !== 1) {
    return { ok: false, error: "a candidate without a canonical target must start at revision 1", validation };
  }
  const summary = recordSummary(validation);
  let changeKind = targetExists ? "revision" : "create";
  if (targetExists && summary.lifecycleStatus === "revoked") changeKind = "revoke";
  else if (targetExists && summary.lifecycleStatus === "superseded") changeKind = "supersede";
  else if (targetExists && summary.lifecycleStatus === "expired") changeKind = "expire";
  else if (!targetExists && summary.supersedes.length > 0) changeKind = "superseding-create";
  return {
    ok: true,
    validation,
    targetPath,
    targetExists,
    currentContent,
    transition,
    duplicateExisting,
    changeKind,
    summary,
    semanticFingerprint: claimFingerprint(validation.metadata)
  };
}

function readCandidate(workspaceRoot, candidateId, key) {
  if (!CANDIDATE_ID_RE.test(String(candidateId ?? ""))) return { ok: false, error: "invalid candidateId" };
  const absolute = candidatePath(workspaceRoot, candidateId);
  if (!fs.existsSync(absolute)) return { ok: false, error: `candidate not found: ${candidateId}` };
  const loaded = readJsonArtifact(workspaceRoot, absolute, "candidate");
  if (!loaded.ok) return loaded;
  if (loaded.record.schema !== `${CURATOR_SCHEMA}/candidate` || loaded.record.candidateId !== candidateId) {
    return { ok: false, error: "candidate artifact identity is invalid" };
  }
  const record = loaded.record;
  if (typeof record.recordContent !== "string" || recordSha256(record.recordContent) !== record.recordSha256
      || !HASH_RE.test(String(record.inputSha256 ?? ""))
      || !HASH_RE.test(String(record.idempotencyKeySha256 ?? ""))
      || !HASH_RE.test(String(record.semanticFingerprint ?? ""))
      || !HASH_RE.test(String(record.artifactMac ?? ""))
      || !secureDigestEqual(artifactMac(key, record), record.artifactMac)
      || safeStableId("candidate", record.idempotencyKeySha256) !== candidateId) {
    return { ok: false, error: "candidate artifact hashes are invalid" };
  }
  const inputIdentity = {
    recordSha256: record.recordSha256,
    rationale: record.rationale,
    source: record.source,
    confidence: record.confidence,
    fabricProposal: record.fabricProposal
  };
  if (sha256(canonicalize(inputIdentity)) !== record.inputSha256) {
    return { ok: false, error: "candidate artifact input hash is invalid" };
  }
  const validation = validateMemoryRecord(record.recordContent, {
    expectedPath: recordPathFor(parseMemoryRecord(record.recordContent).metadata),
    workspaceRoot,
    resolveSupersedes: false,
    checkWorkspaceGraph: false
  });
  if (!validation.ok) return { ok: false, error: `candidate artifact record is invalid: ${validation.errors.join("; ")}` };
  const derivedSummary = recordSummary(validation);
  const derivedPath = recordPathFor(validation.metadata);
  const derivedFingerprint = claimFingerprint(validation.metadata);
  if (canonicalize(record.record) !== canonicalize(derivedSummary)
      || record.confidence !== derivedSummary.confidence.score
      || record.targetPath !== derivedPath || record.semanticFingerprint !== derivedFingerprint) {
    return { ok: false, error: "candidate artifact derived fields do not match validated recordContent" };
  }
  const derived = {
    ...record,
    record: derivedSummary,
    targetPath: derivedPath,
    semanticFingerprint: derivedFingerprint
  };
  return { ok: true, record: derived, absolute };
}

function eventMac(key, event) {
  const copy = { ...event };
  delete copy.eventMac;
  return hmacSha256(key, canonicalize(copy));
}

function anchorMac(key, anchor) {
  const copy = { ...anchor };
  delete copy.anchorMac;
  return hmacSha256(key, canonicalize(copy));
}

function validateEventDetails(type, details) {
  const fields = EVENT_DETAIL_FIELDS[type];
  if (!fields || !exactKeys(details, fields)) return false;
  if (type === "candidate-received") {
    return HASH_RE.test(details.recordRefHmac) && Number.isInteger(details.revision) && details.revision > 0
      && SCOPE_TYPES.has(details.scopeType) && VISIBILITIES.has(details.visibility)
      && CHANGE_KINDS.has(details.changeKind) && HASH_RE.test(details.recordSha256)
      && SOURCE_CLASSES.has(details.sourceClass) && HASH_RE.test(details.sourceRefHmac);
  }
  if (type === "decision-recorded") {
    return REVIEW_ACTIONS.has(details.action)
      && typeof details.confidence === "number" && details.confidence >= 0 && details.confidence <= 1
      && typeof details.apply === "boolean" && HASH_RE.test(details.actorIdSha256)
      && HASH_RE.test(details.reviewerLabelSha256)
      && (details.supersedesDecisionId === null || DECISION_ID_RE.test(details.supersedesDecisionId))
      && Array.isArray(details.reasonCodes) && details.reasonCodes.length <= 16
      && new Set(details.reasonCodes).size === details.reasonCodes.length
      && details.reasonCodes.every((code) => SAFE_CODE_RE.test(code));
  }
  if (type === "proposal-recorded") {
    return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(details.proposalId)
      && HASH_RE.test(details.targetRefHmac)
      && HASH_RE.test(details.proposedContentSha256)
      && (details.expectedRevision === null || (Number.isInteger(details.expectedRevision) && details.expectedRevision > 0));
  }
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(details.proposalId)
    && HASH_RE.test(details.targetRefHmac)
    && HASH_RE.test(details.persistedContentSha256) && HASH_RE.test(details.appliedArchiveSha256)
    && HASH_RE.test(details.recordRefHmac)
    && Number.isInteger(details.revision) && details.revision > 0;
}

function validateDecisionEvent(key, event, sequence, previousEventMac) {
  return exactKeys(event, EVENT_FIELDS)
    && event.schema === `${CURATOR_SCHEMA}/decision-event`
    && typeof event.eventId === "string" && /^event-[A-Za-z0-9-]{8,240}$/.test(event.eventId)
    && event.sequence === sequence && isTimestamp(event.occurredAt)
    && Object.hasOwn(EVENT_DETAIL_FIELDS, event.type)
    && CANDIDATE_ID_RE.test(String(event.candidateId ?? ""))
    && (event.decisionId === null || DECISION_ID_RE.test(event.decisionId))
    && event.previousEventMac === previousEventMac
    && HASH_RE.test(String(event.eventMac ?? "")) && secureDigestEqual(eventMac(key, event), event.eventMac)
    && validateEventDetails(event.type, event.details)
    && (event.type === "candidate-received" ? event.decisionId === null : event.decisionId !== null);
}

function buildLedgerAnchor(key, events, byteLength) {
  const anchor = {
    schema: `${CURATOR_SCHEMA}/ledger-anchor`,
    sequence: events.length,
    headEventMac: events.at(-1)?.eventMac ?? null,
    byteLength
  };
  anchor.anchorMac = anchorMac(key, anchor);
  return anchor;
}

function readLedgerAnchor(state, key) {
  const absolute = state.anchorPath;
  if (!fs.existsSync(absolute)) return { ok: true, exists: false, record: null, absolute };
  const loaded = readJsonArtifact(state.root, absolute, "ledger anchor");
  if (!loaded.ok) return loaded;
  const anchor = loaded.record;
  const fields = new Set(["schema", "sequence", "headEventMac", "byteLength", "anchorMac"]);
  if (!exactKeys(anchor, fields) || anchor.schema !== `${CURATOR_SCHEMA}/ledger-anchor`
      || !Number.isInteger(anchor.sequence) || anchor.sequence < 0
      || (anchor.headEventMac !== null && !HASH_RE.test(String(anchor.headEventMac)))
      || !Number.isInteger(anchor.byteLength) || anchor.byteLength < 0
      || !HASH_RE.test(String(anchor.anchorMac ?? "")) || !secureDigestEqual(anchorMac(key, anchor), anchor.anchorMac)) {
    return { ok: false, error: "ledger anchor authentication failed" };
  }
  return { ok: true, exists: true, record: anchor, absolute };
}

function writeLedgerAnchor(state, key, events, byteLength, options = {}) {
  const absolute = state.anchorPath;
  const anchor = buildLedgerAnchor(key, events, byteLength);
  atomicWriteFileSync(state.root, absolute, `${JSON.stringify(anchor, null, 2)}\n`, {
    mode: 0o600,
    exclusive: options.exclusive === true
  });
  return anchor;
}

function initializedMarkerMac(key, marker) {
  const copy = { ...marker };
  delete copy.markerMac;
  return hmacSha256(key, canonicalize(copy));
}

function readInitializedMarker(root, absolute, key, label) {
  if (!fs.existsSync(absolute)) return { ok: true, exists: false, record: null };
  const loaded = readJsonArtifact(root, absolute, label);
  if (!loaded.ok) return loaded;
  const marker = loaded.record;
  const fields = new Set(["schema", "workspaceId", "initializedAt", "markerMac"]);
  if (!exactKeys(marker, fields) || marker.schema !== `${CURATOR_SCHEMA}/initialized`
      || !HASH_RE.test(String(marker.workspaceId ?? "")) || !isTimestamp(marker.initializedAt)
      || !secureDigestEqual(initializedMarkerMac(key, marker), marker.markerMac)) {
    return { ok: false, error: `${label} authentication failed` };
  }
  return { ok: true, exists: true, record: marker };
}

function stateInitializationStatus(workspaceRoot, state, key) {
  const external = readInitializedMarker(state.root, state.initializedPath, key, "external initialized marker");
  if (!external.ok) return external;
  const sentinel = readInitializedMarker(workspaceRoot, state.workspaceSentinelPath, key, "workspace initialized sentinel");
  if (!sentinel.ok) return sentinel;
  const anchor = readLedgerAnchor(state, key);
  if (!anchor.ok) return anchor;
  if (!external.exists && !sentinel.exists && !anchor.exists) {
    const applicatorRoot = path.join(workspaceRoot, "memory", "amf", "applicator");
    const hasApplicatorEvidence = fs.existsSync(applicatorRoot)
      && fs.readdirSync(applicatorRoot, { recursive: true }).length > 0;
    if (hasApplicatorEvidence) {
      return { ok: false, error: "curator state was deleted while durable applicator history remains; manual recovery required" };
    }
    return { ok: true, initialized: false, anchor };
  }
  if (!external.exists || !sentinel.exists || !anchor.exists) {
    return { ok: false, error: "curator external state is partial or was deleted; manual recovery required" };
  }
  if (external.record.workspaceId !== state.workspaceId || sentinel.record.workspaceId !== state.workspaceId
      || canonicalize(external.record) !== canonicalize(sentinel.record)) {
    return { ok: false, error: "curator initialized markers do not match this workspace" };
  }
  return { ok: true, initialized: true, anchor, marker: external.record };
}

function initializeExternalState(workspaceRoot, state, key) {
  const status = stateInitializationStatus(workspaceRoot, state, key);
  if (!status.ok) return status;
  if (status.initialized) return { ok: true, initialized: true, duplicate: true };
  const marker = {
    schema: `${CURATOR_SCHEMA}/initialized`,
    workspaceId: state.workspaceId,
    initializedAt: new Date().toISOString()
  };
  marker.markerMac = initializedMarkerMac(key, marker);
  try {
    atomicWriteFileSync(state.root, state.initializedPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, exclusive: true });
    writeLedgerAnchor(state, key, [], 0, { exclusive: true });
    atomicWriteFileSync(workspaceRoot, state.workspaceSentinelPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, exclusive: true });
  } catch (error) {
    return { ok: false, error: `could not initialize external curator state atomically: ${error.message}` };
  }
  return { ok: true, initialized: true, duplicate: false };
}

function readDecisionLedger(workspaceRoot, key, state, options = {}) {
  if (!key) return { ok: false, error: "authoritative curator ledger key is required" };
  if (!state?.root) {
    const resolved = resolveStateContext(workspaceRoot, DEFAULT_POLICY, {});
    if (!resolved.ok) return resolved;
    state = resolved;
  }
  const absolute = path.join(workspaceRoot, LEDGER_PATH);
  const initialization = stateInitializationStatus(workspaceRoot, state, key);
  if (!initialization.ok) return initialization;
  const anchor = initialization.anchor;
  if (!anchor.ok) return anchor;
  if (!fs.existsSync(absolute)) {
    if (anchor.exists) {
      if (anchor.record.sequence === 0 && anchor.record.headEventMac === null && anchor.record.byteLength === 0) {
        return { ok: true, events: [], headMac: null, byteLength: 0 };
      }
      return { ok: false, error: "ledger truncation detected: anchor exists without ledger" };
    }
    return { ok: true, events: [], headMac: null, byteLength: 0 };
  }
  let content;
  try {
    content = readFileNoFollowSync(workspaceRoot, absolute);
  } catch (error) {
    return { ok: false, error: `could not read curator ledger: ${error.message}` };
  }
  const events = [];
  const offsets = [];
  let previous = null;
  let consumed = 0;
  const ids = new Set();
  for (const [index, rawLine] of content.match(/.*(?:\n|$)/g).entries()) {
    if (rawLine === "") continue;
    consumed += Buffer.byteLength(rawLine, "utf8");
    const line = rawLine.replace(/\n$/, "").replace(/\r$/, "");
    if (line === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      return { ok: false, error: `curator ledger line ${index + 1} is invalid JSON: ${error.message}` };
    }
    if (ids.has(event?.eventId) || !validateDecisionEvent(key, event, events.length + 1, previous)) {
      return { ok: false, error: `curator ledger line ${index + 1} fails strict schema or authentication` };
    }
    ids.add(event.eventId);
    events.push(event);
    offsets.push(consumed);
    previous = event.eventMac;
  }
  const byteLength = Buffer.byteLength(content, "utf8");
  if (!anchor.exists) return { ok: false, error: "ledger anchor is missing" };
  const anchored = anchor.record;
  if (anchored.sequence > events.length) return { ok: false, error: "ledger truncation detected: authenticated anchor is ahead" };
  const anchoredMac = anchored.sequence === 0 ? null : events[anchored.sequence - 1]?.eventMac;
  const anchoredLength = anchored.sequence === 0 ? 0 : offsets[anchored.sequence - 1];
  if (anchored.headEventMac !== anchoredMac || anchored.byteLength !== anchoredLength) {
    return { ok: false, error: "ledger anchor does not match the authenticated prefix" };
  }
  const anchorBehind = anchored.sequence < events.length;
  if (anchorBehind && options.allowBehind !== true) return { ok: false, error: "ledger anchor mismatch: authenticated anchor is behind" };
  return { ok: true, events, headMac: previous, byteLength, anchorBehind, anchoredSequence: anchored.sequence };
}

function appendDecisionEvent(workspaceRoot, key, state, input, options = {}) {
  ensureCuratorLayout(workspaceRoot);
  const lockAbsolute = path.join(workspaceRoot, CURATOR_ROOT, "decisions.lock");
  const lock = acquireExclusiveLock(workspaceRoot, lockAbsolute);
  try {
    const ledger = readDecisionLedger(workspaceRoot, key, state);
    if (!ledger.ok) return ledger;
    const base = {
      schema: `${CURATOR_SCHEMA}/decision-event`,
      eventId: input.eventId,
      sequence: ledger.events.length + 1,
      occurredAt: input.occurredAt,
      type: input.type,
      candidateId: input.candidateId,
      decisionId: input.decisionId ?? null,
      details: input.details ?? {},
      previousEventMac: ledger.headMac
    };
    const existing = ledger.events.find((event) => event.eventId === input.eventId);
    if (existing) {
      const comparable = { ...existing };
      delete comparable.eventMac;
      const desired = { ...base, sequence: existing.sequence, previousEventMac: existing.previousEventMac };
      if (canonicalize(comparable) !== canonicalize(desired)) {
        return { ok: false, error: `ledger event idempotency conflict: ${input.eventId}` };
      }
      return { ok: true, duplicate: true, event: existing };
    }
    const event = { ...base };
    event.eventMac = eventMac(key, event);
    if (!validateDecisionEvent(key, event, event.sequence, ledger.headMac)) {
      return { ok: false, error: "refusing ledger event that fails strict schema" };
    }
    const absolute = path.join(workspaceRoot, LEDGER_PATH);
    assertNoSymlinkPath(workspaceRoot, absolute);
    const ledgerExisted = fs.existsSync(absolute);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(absolute, flags, 0o600);
    const line = `${JSON.stringify(event)}\n`;
    try {
      fs.writeFileSync(fd, line, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const nextEvents = [...ledger.events, event];
    const nextLength = ledger.byteLength + Buffer.byteLength(line, "utf8");
    if (options.faultAt === "after-ledger-append") throw new Error("injected curator fault after ledger append before anchor replace");
    writeLedgerAnchor(state, key, nextEvents, nextLength);
    if (!ledgerExisted) {
      const dirFd = fs.openSync(path.dirname(absolute), fs.constants.O_RDONLY);
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
    return { ok: true, duplicate: false, event };
  } finally {
    lock.release();
  }
}

function findCandidateDuplicate(workspaceRoot, candidate, index, options = {}) {
  if (candidate.duplicateExisting) {
    return { kind: "canonical-exact", recordId: candidate.summary.id };
  }
  if (candidate.targetExists) return null;
  const recordsDir = path.join(workspaceRoot, "memory", "amf", "records");
  if (fs.existsSync(recordsDir)) {
    assertNoSymlinkPath(workspaceRoot, recordsDir, { allowMissing: false });
    for (const name of fs.readdirSync(recordsDir).sort()) {
      if (!name.endsWith(".md")) continue;
      const absolute = path.join(recordsDir, name);
      const relative = toPosixPath(path.relative(workspaceRoot, absolute));
      if (options.ignoreCanonicalPath === relative) continue;
      if (!fs.lstatSync(absolute).isFile()) throw new Error(`unsafe AMF record: ${name}`);
      const content = readFileNoFollowSync(workspaceRoot, absolute);
      const validation = validateMemoryRecord(content, {
        expectedPath: relative,
        workspaceRoot,
        resolveSupersedes: false,
        checkWorkspaceGraph: false
      });
      if (!validation.ok || validation.metadata.lifecycle.status !== "active") continue;
      if (candidate.summary.supersedes.includes(validation.metadata.id)) continue;
      if (claimFingerprint(validation.metadata) === candidate.semanticFingerprint) {
        return { kind: "canonical-semantic", recordId: validation.metadata.id };
      }
      const candidateEvents = new Set(candidate.validation.metadata.provenance.map((item) => `${item.eventId}\0${item.contentSha256}`));
      if (validation.metadata.provenance.some((item) => candidateEvents.has(`${item.eventId}\0${item.contentSha256}`))) {
        return { kind: "canonical-provenance", recordId: validation.metadata.id };
      }
    }
  }
  for (const queued of index.candidates) {
    if (queued.candidateId !== candidate.candidateId
        && queued.semanticFingerprint === candidate.semanticFingerprint
        && !candidate.summary.supersedes.includes(queued.record?.id)) {
      return { kind: "queued-semantic", candidateId: queued.candidateId, recordId: queued.record?.id ?? null };
    }
  }
  return null;
}

function deduplicateCandidate(workspaceRoot, candidate, key, state) {
  const ledger = readDecisionLedger(workspaceRoot, key, state);
  if (!ledger.ok) throw new Error(ledger.error);
  const index = loadVerifiedCuratorIndex(workspaceRoot, key, ledger);
  assertAppliedArchiveHistory(workspaceRoot, ledger);
  return findCandidateDuplicate(workspaceRoot, candidate, index);
}

function policyDecision(candidate, duplicate, policy) {
  const reasons = [];
  if (duplicate) return { action: "duplicate", reasons: [`duplicate-${duplicate.kind}`], eligible: false };
  if (!policy.autoPromote) reasons.push("auto-promotion-disabled");
  if (candidate.record.confidence.score < policy.minimumConfidence) reasons.push("below-confidence-threshold");
  if (!policy.autoScopes.includes(candidate.record.scope.type)) reasons.push("scope-requires-review");
  if (!policy.autoVisibilities.includes(candidate.record.visibility)) reasons.push("visibility-requires-review");
  if (policy.requireReviewForLifecycleChange && candidate.changeKind !== "create") reasons.push("lifecycle-change-requires-review");
  if (policy.requireReviewForSupersession && candidate.record.supersedes.length > 0) reasons.push("supersession-requires-review");
  if (policy.rejectOnWarnings && candidate.validationWarnings.length > 0) reasons.push("validation-warning-requires-review");
  return {
    action: reasons.length === 0 ? "promote" : "review",
    reasons,
    eligible: reasons.length === 0
  };
}

function policyDecisionKey(policy) {
  return `policy:${sha256(canonicalize(policy))}`;
}

function policyReviewInput(candidate, policy, evaluation, actorId) {
  return {
    idempotencyKey: policyDecisionKey(policy),
    action: evaluation.action === "promote" ? "approve" : evaluation.action,
    rationale: evaluation.action === "promote"
      ? "Candidate satisfied the explicitly enabled high-confidence policy."
      : `Policy routed candidate to ${evaluation.action}.`,
    reviewerLabel: "service:amf-curator-policy",
    actorId,
    confidence: candidate.record.confidence.score,
    apply: false,
    reasons: evaluation.reasons
  };
}

function sourceClassFor(sourceType) {
  const prefix = String(sourceType).split(/[._-]/, 1)[0];
  return SOURCE_CLASSES.has(prefix) && prefix !== "other" ? prefix : "other";
}

function candidateReceivedDetails(candidate, key) {
  return {
    recordRefHmac: hmacSha256(key, `record\0${candidate.record.id}`),
    revision: candidate.record.revision,
    scopeType: candidate.record.scope.type,
    visibility: candidate.record.visibility,
    changeKind: candidate.changeKind,
    recordSha256: candidate.recordSha256,
    sourceClass: sourceClassFor(candidate.source.type),
    sourceRefHmac: hmacSha256(key, `source\0${candidate.source.type}\0${candidate.source.id}`)
  };
}

function reviewDecisionDetails(review) {
  return {
    action: review.action,
    confidence: review.confidence,
    apply: review.apply,
    actorIdSha256: sha256(review.actorId),
    reviewerLabelSha256: sha256(review.reviewerLabel),
    supersedesDecisionId: review.supersedesDecisionId,
    reasonCodes: review.reasons
  };
}

function reviewMatchesLedger(review, ledger) {
  const event = ledger.events.find((entry) => entry.type === "decision-recorded" && entry.decisionId === review.decisionId);
  return Boolean(event) && event.candidateId === review.candidateId
    && canonicalize(event.details) === canonicalize(reviewDecisionDetails(review));
}

function loadVerifiedCuratorIndex(workspaceRoot, key, ledger) {
  const candidates = [];
  const queueAbsolute = path.join(workspaceRoot, QUEUE_DIR);
  if (fs.existsSync(queueAbsolute)) {
    for (const name of fs.readdirSync(queueAbsolute).sort()) {
      if (!name.endsWith(".json")) throw new Error(`bogus queue artifact: ${name}`);
      const loaded = readCandidate(workspaceRoot, name.slice(0, -5), key);
      if (!loaded.ok) throw new Error(loaded.error);
      candidates.push(loaded.record);
    }
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const reviews = listSafeJson(workspaceRoot, REVIEWS_DIR);
  if (reviews.some((review) => {
    const candidate = candidateById.get(review.candidateId);
    return !candidate || !validateReviewArtifact(review, key) || !reviewMatchesCandidate(review, candidate)
      || !reviewMatchesLedger(review, ledger);
  })) {
    throw new Error("unverified review artifact in curator index");
  }
  if (ledger.events.filter((event) => event.type === "decision-recorded").length !== reviews.length) {
    throw new Error("review index and authenticated ledger differ");
  }
  const received = ledger.events.filter((event) => event.type === "candidate-received");
  if (received.length !== candidates.length || received.some((event) => {
    const candidate = candidateById.get(event.candidateId);
    return !candidate || canonicalize(event.details) !== canonicalize(candidateReceivedDetails(candidate, key));
  })) {
    throw new Error("candidate index and authenticated ledger differ");
  }
  return { candidates, reviews };
}

function verifyIndexWithSingleMissingReceived(workspaceRoot, key, ledger, missingCandidateId) {
  const candidates = [];
  const queueAbsolute = path.join(workspaceRoot, QUEUE_DIR);
  for (const name of fs.readdirSync(queueAbsolute).sort()) {
    if (!name.endsWith(".json")) throw new Error(`bogus queue artifact: ${name}`);
    const loaded = readCandidate(workspaceRoot, name.slice(0, -5), key);
    if (!loaded.ok) throw new Error(loaded.error);
    candidates.push(loaded.record);
  }
  const missing = candidates.filter((candidate) => candidate.candidateId === missingCandidateId);
  if (missing.length !== 1) throw new Error("candidate recovery identity is not unique");
  const received = ledger.events.filter((event) => event.type === "candidate-received");
  const expected = candidates.filter((candidate) => candidate.candidateId !== missingCandidateId);
  const expectedById = new Map(expected.map((candidate) => [candidate.candidateId, candidate]));
  if (received.length !== expected.length || received.some((event) => {
    const candidate = expectedById.get(event.candidateId);
    return !candidate || canonicalize(event.details) !== canonicalize(candidateReceivedDetails(candidate, key));
  })) throw new Error("candidate recovery would hide unrelated queue/ledger drift");
  const reviews = listSafeJson(workspaceRoot, REVIEWS_DIR);
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  if (reviews.some((review) => {
    const candidate = candidateById.get(review.candidateId);
    return !candidate || !validateReviewArtifact(review, key) || !reviewMatchesCandidate(review, candidate)
      || !reviewMatchesLedger(review, ledger);
  })
      || ledger.events.filter((event) => event.type === "decision-recorded").length !== reviews.length) {
    throw new Error("candidate recovery found unverified review history");
  }
  assertAppliedArchiveHistory(workspaceRoot, ledger);
  return missing[0];
}

function exactReviewForInput(workspaceRoot, candidate, key, ledger, input) {
  const keyError = validateStableKey(input.idempotencyKey, "decision idempotencyKey");
  if (keyError) return { ok: false, error: keyError };
  const confidence = normalizeConfidence(input.confidence);
  if (confidence === null) return { ok: false, error: "confidence must be between 0 and 1" };
  if (!REVIEW_ACTIONS.has(input.action)) return { ok: false, error: "decision action is invalid" };
  if (typeof input.rationale !== "string" || input.rationale.trim() === ""
      || Buffer.byteLength(input.rationale, "utf8") > MAX_RATIONALE_BYTES) {
    return { ok: false, error: `decision rationale is required and limited to ${MAX_RATIONALE_BYTES} bytes` };
  }
  const reviewerLabel = input.reviewerLabel ?? "service:amf-curator-policy";
  const actorId = input.actorId ?? "service:amf-curator-policy";
  const reasons = Array.isArray(input.reasons) ? input.reasons.map(String) : [];
  if (!SAFE_ACTOR_RE.test(reviewerLabel) || !SAFE_ACTOR_RE.test(actorId)
      || reasons.length > 16 || new Set(reasons).size !== reasons.length
      || reasons.some((code) => !SAFE_CODE_RE.test(code))) {
    return { ok: false, error: "review recovery identity is invalid" };
  }
  const decisionKeySha256 = sha256(input.idempotencyKey);
  const decisionId = safeStableId("decision", `${candidate.candidateId}\0${decisionKeySha256}`);
  const absolute = reviewPath(workspaceRoot, decisionId);
  if (!fs.existsSync(absolute)) return { ok: true, exists: false, decisionId };
  const loaded = readJsonArtifact(workspaceRoot, absolute, "review");
  if (!loaded.ok) return loaded;
  const review = loaded.record;
  const identity = {
    candidateId: candidate.candidateId,
    candidateRecordSha256: candidate.recordSha256,
    candidateRevision: candidate.record.revision,
    action: input.action,
    rationale: input.rationale,
    reviewerLabel,
    actorId,
    confidence,
    apply: input.apply === true,
    reasons
  };
  const decisionEvents = ledger.events.filter((event) => event.type === "decision-recorded"
    && event.candidateId === candidate.candidateId);
  const existingIndex = decisionEvents.findIndex((event) => event.decisionId === decisionId);
  const previousDecisionId = existingIndex >= 0
    ? decisionEvents[existingIndex - 1]?.decisionId ?? null
    : decisionEvents.at(-1)?.decisionId ?? null;
  if (!validateReviewArtifact(review, key) || !reviewMatchesCandidate(review, candidate)
      || review.decisionId !== decisionId || review.decisionKeySha256 !== decisionKeySha256
      || review.inputSha256 !== sha256(canonicalize(identity))
      || review.supersedesDecisionId !== previousDecisionId
      || canonicalize(Object.fromEntries(Object.keys(identity).map((name) => [name, review[name]]))) !== canonicalize(identity)) {
    return { ok: false, error: `decision idempotency or candidate-version conflict: ${decisionId}` };
  }
  return { ok: true, exists: true, review, decisionId, logged: existingIndex >= 0 };
}

function verifyIndexWithSingleMissingReview(workspaceRoot, key, ledger, expectedReview) {
  const candidates = [];
  const queueAbsolute = path.join(workspaceRoot, QUEUE_DIR);
  for (const name of fs.readdirSync(queueAbsolute).sort()) {
    if (!name.endsWith(".json")) throw new Error(`bogus queue artifact: ${name}`);
    const loaded = readCandidate(workspaceRoot, name.slice(0, -5), key);
    if (!loaded.ok) throw new Error(loaded.error);
    candidates.push(loaded.record);
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const received = ledger.events.filter((event) => event.type === "candidate-received");
  if (received.length !== candidates.length || received.some((event) => {
    const candidate = candidateById.get(event.candidateId);
    return !candidate || canonicalize(event.details) !== canonicalize(candidateReceivedDetails(candidate, key));
  })) throw new Error("review recovery found candidate queue/ledger drift");

  const reviews = listSafeJson(workspaceRoot, REVIEWS_DIR);
  const decisionIds = new Set();
  for (const review of reviews) {
    const candidate = candidateById.get(review.candidateId);
    if (!candidate || !validateReviewArtifact(review, key) || !reviewMatchesCandidate(review, candidate)
        || decisionIds.has(review.decisionId)) {
      throw new Error("review recovery found an invalid, duplicate, or version-unbound artifact");
    }
    decisionIds.add(review.decisionId);
  }
  const missing = reviews.filter((review) => !reviewMatchesLedger(review, ledger));
  if (missing.length !== 1 || missing[0].decisionId !== expectedReview.decisionId
      || canonicalize(missing[0]) !== canonicalize(expectedReview)) {
    throw new Error("review recovery identity is not unique or exact");
  }
  const loggedReviews = reviews.filter((review) => review.decisionId !== expectedReview.decisionId);
  const decisions = ledger.events.filter((event) => event.type === "decision-recorded");
  if (loggedReviews.length !== decisions.length
      || loggedReviews.some((review) => !reviewMatchesLedger(review, ledger))) {
    throw new Error("review recovery would hide unrelated review/ledger drift");
  }
  assertAppliedArchiveHistory(workspaceRoot, ledger);
  return { candidates, reviews };
}

function loadPolicyRecoveryIndex(workspaceRoot, key, ledger, candidateId, expectedDecisionId) {
  const candidates = [];
  const queueAbsolute = path.join(workspaceRoot, QUEUE_DIR);
  for (const name of fs.readdirSync(queueAbsolute).sort()) {
    if (!name.endsWith(".json")) throw new Error(`bogus queue artifact: ${name}`);
    const loaded = readCandidate(workspaceRoot, name.slice(0, -5), key);
    if (!loaded.ok) throw new Error(loaded.error);
    candidates.push(loaded.record);
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  if (!candidateById.has(candidateId)) throw new Error("policy recovery candidate is missing from the authenticated queue");
  const received = ledger.events.filter((event) => event.type === "candidate-received");
  if (received.length !== candidates.length || received.some((event) => {
    const candidate = candidateById.get(event.candidateId);
    return !candidate || canonicalize(event.details) !== canonicalize(candidateReceivedDetails(candidate, key));
  })) throw new Error("policy recovery found candidate queue/ledger drift");

  const reviews = listSafeJson(workspaceRoot, REVIEWS_DIR);
  const decisionIds = new Set();
  for (const review of reviews) {
    const candidate = candidateById.get(review.candidateId);
    if (!candidate || !validateReviewArtifact(review, key) || !reviewMatchesCandidate(review, candidate)
        || decisionIds.has(review.decisionId)) {
      throw new Error("policy recovery found an invalid, duplicate, or version-unbound review");
    }
    decisionIds.add(review.decisionId);
  }
  const unlogged = reviews.filter((review) => !reviewMatchesLedger(review, ledger));
  if (unlogged.length > 1 || (unlogged.length === 1
      && (unlogged[0].candidateId !== candidateId || unlogged[0].decisionId !== expectedDecisionId))) {
    throw new Error("policy recovery found an unrelated or ambiguous unlogged review");
  }
  const logged = reviews.filter((review) => !unlogged.includes(review));
  const decisions = ledger.events.filter((event) => event.type === "decision-recorded");
  if (logged.length !== decisions.length || logged.some((review) => !reviewMatchesLedger(review, ledger))) {
    throw new Error("policy recovery would hide unrelated review/ledger drift");
  }
  return { candidates, reviews, unloggedReview: unlogged[0] ?? null };
}

function validateReviewArtifact(review, key) {
  const identity = {
    candidateId: review.candidateId,
    candidateRecordSha256: review.candidateRecordSha256,
    candidateRevision: review.candidateRevision,
    action: review.action,
    rationale: review.rationale,
    reviewerLabel: review.reviewerLabel,
    actorId: review.actorId,
    confidence: review.confidence,
    apply: review.apply,
    reasons: review.reasons
  };
  return exactKeys(review, REVIEW_ARTIFACT_FIELDS)
    && review.schema === `${CURATOR_SCHEMA}/review`
    && CANDIDATE_ID_RE.test(String(review.candidateId ?? ""))
    && DECISION_ID_RE.test(String(review.decisionId ?? ""))
    && HASH_RE.test(String(review.candidateRecordSha256 ?? ""))
    && Number.isInteger(review.candidateRevision) && review.candidateRevision > 0
    && isTimestamp(review.createdAt)
    && HASH_RE.test(String(review.decisionKeySha256 ?? ""))
    && HASH_RE.test(String(review.inputSha256 ?? ""))
    && HASH_RE.test(String(review.artifactMac ?? ""))
    && review.decisionId === safeStableId("decision", `${review.candidateId}\0${review.decisionKeySha256}`)
    && review.inputSha256 === sha256(canonicalize(identity))
    && secureDigestEqual(artifactMac(key, review), review.artifactMac)
    && REVIEW_ACTIONS.has(review.action)
    && typeof review.rationale === "string" && review.rationale.trim() !== ""
    && Buffer.byteLength(review.rationale, "utf8") <= MAX_RATIONALE_BYTES
    && SAFE_ACTOR_RE.test(String(review.reviewerLabel ?? ""))
    && SAFE_ACTOR_RE.test(String(review.actorId ?? ""))
    && typeof review.confidence === "number" && review.confidence >= 0 && review.confidence <= 1
    && typeof review.apply === "boolean"
    && (review.supersedesDecisionId === null || DECISION_ID_RE.test(String(review.supersedesDecisionId)))
    && Array.isArray(review.reasons) && review.reasons.length <= 16
    && new Set(review.reasons).size === review.reasons.length
    && review.reasons.every((code) => SAFE_CODE_RE.test(code));
}

function curatorPolicyDigest(policy) {
  return sha256(canonicalize(policy));
}

function decisionOutcome(action) {
  if (action === "approve") return "approved_pending_apply";
  if (action === "reject") return "rejected";
  return "review_required";
}

function decisionReceiptPayload(receipt) {
  return {
    schema: receipt.schema,
    receiptType: receipt.receiptType,
    outcome: receipt.outcome,
    decisionId: receipt.decisionId,
    candidateId: receipt.candidateId,
    candidateRecordSha256: receipt.candidateRecordSha256,
    candidateRevision: receipt.candidateRevision,
    canonicalRecordId: receipt.canonicalRecordId,
    canonicalLifecycleAtDecision: receipt.canonicalLifecycleAtDecision,
    fabricProposalId: receipt.fabricProposalId,
    fabricProposalScope: receipt.fabricProposalScope,
    fabricProposalDigest: receipt.fabricProposalDigest,
    policyDigest: receipt.policyDigest,
    createdAt: receipt.createdAt
  };
}

function validateDecisionReceipt(receipt, key, candidate, review) {
  const payload = decisionReceiptPayload(receipt);
  return exactKeys(receipt, DECISION_RECEIPT_FIELDS)
    && receipt.schema === `${CURATOR_SCHEMA}/decision-receipt`
    && receipt.receiptType === "memory_curator_decision"
    && DECISION_OUTCOMES.has(receipt.outcome)
    && receipt.outcome === decisionOutcome(review.action)
    && receipt.decisionId === review.decisionId
    && receipt.candidateId === candidate.candidateId
    && receipt.candidateRecordSha256 === candidate.recordSha256
    && receipt.candidateRevision === candidate.record.revision
    && receipt.canonicalRecordId === candidate.record.id
    && receipt.canonicalLifecycleAtDecision === candidate.record.lifecycleStatus
    && receipt.fabricProposalId === (candidate.fabricProposal?.proposalId ?? null)
    && receipt.fabricProposalScope === (candidate.fabricProposal ? candidate.record.scope.id : null)
    && receipt.fabricProposalDigest === (candidate.fabricProposal?.proposalDigest ?? null)
    && HASH_RE.test(String(receipt.policyDigest ?? ""))
    && receipt.createdAt === review.createdAt
    && receipt.decisionDigest === sha256(canonicalize(payload))
    && HASH_RE.test(String(receipt.artifactMac ?? ""))
    && secureDigestEqual(artifactMac(key, receipt), receipt.artifactMac);
}

function ensureDecisionReceipt(workspaceRoot, key, policy, candidate, review, runtime = {}) {
  const absolute = decisionReceiptPath(workspaceRoot, review.decisionId);
  const payload = {
    schema: `${CURATOR_SCHEMA}/decision-receipt`,
    receiptType: "memory_curator_decision",
    outcome: decisionOutcome(review.action),
    decisionId: review.decisionId,
    candidateId: candidate.candidateId,
    candidateRecordSha256: candidate.recordSha256,
    candidateRevision: candidate.record.revision,
    canonicalRecordId: candidate.record.id,
    canonicalLifecycleAtDecision: candidate.record.lifecycleStatus,
    fabricProposalId: candidate.fabricProposal?.proposalId ?? null,
    fabricProposalScope: candidate.fabricProposal ? candidate.record.scope.id : null,
    fabricProposalDigest: candidate.fabricProposal?.proposalDigest ?? null,
    policyDigest: curatorPolicyDigest(policy),
    createdAt: review.createdAt
  };
  const receipt = { ...payload, decisionDigest: sha256(canonicalize(payload)) };
  receipt.artifactMac = artifactMac(key, receipt);
  if (fs.existsSync(absolute)) {
    const loaded = readJsonArtifact(workspaceRoot, absolute, "decision receipt");
    if (!loaded.ok || !validateDecisionReceipt(loaded.record, key, candidate, review)
        || canonicalize(loaded.record) !== canonicalize(receipt)) {
      return { ok: false, error: `decision receipt conflict: ${review.decisionId}` };
    }
    return { ok: true, duplicate: true, receipt: loaded.record };
  }
  atomicWriteFileSync(workspaceRoot, absolute, `${JSON.stringify(receipt, null, 2)}\n`, {
    exclusive: true,
    mode: 0o600
  });
  if (runtime.faultAt === "after-decision-receipt-write") {
    throw new Error("injected curator fault after decision receipt fsync");
  }
  return { ok: true, duplicate: false, receipt };
}

function reviewMatchesCandidate(review, candidate) {
  return review.candidateId === candidate.candidateId
    && review.candidateRecordSha256 === candidate.recordSha256
    && review.candidateRevision === candidate.record.revision;
}

function latestReview(workspaceRoot, candidateId, key, state) {
  const candidate = readCandidate(workspaceRoot, candidateId, key);
  if (!candidate.ok) throw new Error(candidate.error);
  const reviews = listSafeJson(workspaceRoot, REVIEWS_DIR).filter((row) => row.candidateId === candidateId);
  if (reviews.some((review) => !validateReviewArtifact(review, key)
      || !reviewMatchesCandidate(review, candidate.record))) {
    throw new Error(`invalid review artifact for ${candidateId}`);
  }
  if (reviews.length === 0) return null;
  const ledger = readDecisionLedger(workspaceRoot, key, state);
  if (!ledger.ok) throw new Error(ledger.error);
  if (reviews.some((review) => !reviewMatchesLedger(review, ledger))) {
    throw new Error(`review ledger binding is invalid for ${candidateId}`);
  }
  const order = new Map();
  ledger.events.filter((event) => event.type === "decision-recorded").forEach((event, index) => order.set(event.decisionId, index));
  reviews.sort((left, right) => (order.get(left.decisionId) ?? -1) - (order.get(right.decisionId) ?? -1));
  return reviews.at(-1);
}

function recordReviewUnlocked(workspaceRoot, candidate, key, state, input, runtime = {}) {
  const keyError = validateStableKey(input.idempotencyKey, "decision idempotencyKey");
  if (keyError) return { ok: false, error: keyError };
  const confidence = normalizeConfidence(input.confidence);
  if (confidence === null) return { ok: false, error: "confidence must be between 0 and 1" };
  if (!REVIEW_ACTIONS.has(input.action)) {
    return { ok: false, error: "decision action must be review, duplicate, approve, or reject" };
  }
  if (typeof input.rationale !== "string" || input.rationale.trim() === "") {
    return { ok: false, error: "decision rationale is required" };
  }
  const reviewerLabel = input.reviewerLabel ?? "service:amf-curator-policy";
  const actorId = input.actorId ?? "service:amf-curator-policy";
  if (!SAFE_ACTOR_RE.test(reviewerLabel) || !SAFE_ACTOR_RE.test(actorId)) {
    return { ok: false, error: "reviewerLabel and authenticated actorId must be canonical identifiers" };
  }
  const reasons = Array.isArray(input.reasons) ? input.reasons.map(String) : [];
  if (reasons.some((code) => !SAFE_CODE_RE.test(code))) return { ok: false, error: "decision reason codes are invalid" };
  const decisionKeySha256 = sha256(input.idempotencyKey);
  const decisionId = safeStableId("decision", `${candidate.candidateId}\0${decisionKeySha256}`);
  const absolute = reviewPath(workspaceRoot, decisionId);
  const inputIdentity = {
    candidateId: candidate.candidateId,
    candidateRecordSha256: candidate.recordSha256,
    candidateRevision: candidate.record.revision,
    action: input.action,
    rationale: input.rationale,
    reviewerLabel,
    actorId,
    confidence,
    apply: input.apply === true,
    reasons
  };
  const inputSha256 = sha256(canonicalize(inputIdentity));
  const logReview = (review) => appendDecisionEvent(workspaceRoot, key, state, {
    eventId: `event-${decisionId}`,
    occurredAt: review.createdAt,
    type: "decision-recorded",
    candidateId: candidate.candidateId,
    decisionId,
    details: reviewDecisionDetails(review)
  }, runtime);
  if (fs.existsSync(absolute)) {
    const loaded = readJsonArtifact(workspaceRoot, absolute, "review");
    if (!loaded.ok) return loaded;
    const stored = loaded.record;
    if (!validateReviewArtifact(stored, key) || stored.decisionId !== decisionId
        || stored.candidateId !== candidate.candidateId
        || stored.decisionKeySha256 !== decisionKeySha256
        || stored.inputSha256 !== inputSha256) {
      return { ok: false, error: `decision idempotency conflict: ${decisionId}` };
    }
    const logged = logReview(stored);
    if (!logged.ok) return logged;
    return { ok: true, duplicate: true, review: loaded.record };
  }
  const previous = latestReview(workspaceRoot, candidate.candidateId, key, state);
  const createdAt = new Date().toISOString();
  const review = {
    schema: `${CURATOR_SCHEMA}/review`,
    decisionId,
    candidateId: candidate.candidateId,
    createdAt,
    inputSha256,
    decisionKeySha256,
    supersedesDecisionId: previous?.decisionId ?? null,
    ...inputIdentity
  };
  review.artifactMac = artifactMac(key, review);
  try {
    atomicWriteFileSync(workspaceRoot, absolute, `${JSON.stringify(review, null, 2)}\n`, {
      exclusive: true,
      mode: 0o600
    });
    if (runtime.faultAt === "after-review-write") {
      throw new Error("injected curator fault after review artifact fsync before decision ledger event");
    }
  } catch (error) {
    if (String(error.message).startsWith("injected curator fault")) throw error;
    return { ok: false, error: `could not record curator review: ${error.message}` };
  }
  const logged = logReview(review);
  if (!logged.ok) return logged;
  return { ok: true, duplicate: false, review };
}

function recordReview(workspaceRoot, candidate, key, state, input, runtime = {}) {
  const lockAbsolute = path.join(workspaceRoot, CURATOR_ROOT, `review-${candidate.candidateId}.lock`);
  let lock;
  try {
    lock = acquireExclusiveLock(workspaceRoot, lockAbsolute);
  } catch (error) {
    return { ok: false, error: `candidate review is already being modified: ${error.message}` };
  }
  try {
    return recordReviewUnlocked(workspaceRoot, candidate, key, state, input, runtime);
  } finally {
    lock.release();
  }
}

function recoverExactReviewBoundary(workspaceRoot, candidate, key, state, ledger, input, runtime = {}) {
  const exact = exactReviewForInput(workspaceRoot, candidate, key, ledger, input);
  if (!exact.ok) return exact;
  if (!exact.exists) return { ok: true, handled: false, ledger };
  let current = ledger;
  if (!exact.logged) {
    try {
      verifyIndexWithSingleMissingReview(workspaceRoot, key, current, exact.review);
    } catch (error) {
      return { ok: false, error: error.message };
    }
    const appended = appendDecisionEvent(workspaceRoot, key, state, {
      eventId: `event-${exact.review.decisionId}`,
      occurredAt: exact.review.createdAt,
      type: "decision-recorded",
      candidateId: candidate.candidateId,
      decisionId: exact.review.decisionId,
      details: reviewDecisionDetails(exact.review)
    }, runtime);
    if (!appended.ok) return appended;
    current = readDecisionLedger(workspaceRoot, key, state);
    if (!current.ok) return current;
  }
  return { ok: true, handled: !exact.logged, reviewRecovered: !exact.logged, review: exact.review, ledger: current };
}

function findExistingProposal(workspaceRoot, candidate, sourcePrefix = "pam-amf-curator") {
  const dir = path.join(workspaceRoot, "memory", "maintenance", "proposals");
  if (!fs.existsSync(dir)) return null;
  assertNoSymlinkPath(workspaceRoot, dir, { allowMissing: false });
  const source = `${sourcePrefix}:${candidate.candidateId}`;
  const matches = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const absolute = path.join(dir, name);
    if (!fs.lstatSync(absolute).isFile()) throw new Error(`unsafe proposal artifact: ${name}`);
    const loaded = readJsonArtifact(workspaceRoot, absolute, "proposal");
    if (!loaded.ok) throw new Error(loaded.error);
    if (loaded.record.source === source) matches.push(loaded.record);
  }
  if (matches.length === 0) return null;
  const proposalIds = new Set(matches.map((match) => match.proposalId));
  if (proposalIds.size !== 1) throw new Error(`multiple proposal identities exist for ${candidate.candidateId}`);
  for (const match of matches) {
    if (match.proposedContentSha256 !== candidate.recordSha256 || match.targetPath !== candidate.targetPath) {
      throw new Error("curator proposal identity conflicts with candidate");
    }
  }
  return matches.find((match) => match.status === "applied") ?? matches[0];
}

function listCuratorAppliedArchives(workspaceRoot) {
  const dir = path.join(workspaceRoot, "memory", "maintenance", "proposals");
  if (!fs.existsSync(dir)) return [];
  assertNoSymlinkPath(workspaceRoot, dir, { allowMissing: false });
  const archives = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith(".applied.json")) continue;
    const absolute = path.join(dir, name);
    const loaded = readJsonArtifact(workspaceRoot, absolute, "applied proposal archive");
    if (!loaded.ok) throw new Error(loaded.error);
    if (typeof loaded.record.source === "string" && loaded.record.source.startsWith("pam-amf-curator:")) {
      archives.push(loaded.record);
    }
  }
  return archives;
}

function assertAppliedArchiveHistory(workspaceRoot, ledger) {
  const archives = listCuratorAppliedArchives(workspaceRoot);
  const appliedEvents = ledger.events.filter((event) => event.type === "proposal-applied");
  const archiveIds = new Set(archives.map((archive) => archive.proposalId));
  const eventIds = new Set(appliedEvents.map((event) => event.details.proposalId));
  if (archiveIds.size !== archives.length || eventIds.size !== appliedEvents.length
      || archiveIds.size !== eventIds.size || [...archiveIds].some((id) => !eventIds.has(id))) {
    throw new Error("authenticated ledger and curator applied-archive history differ");
  }
  return archives;
}

function crossCheckLedgerHistory(workspaceRoot, key, ledger) {
  const index = loadVerifiedCuratorIndex(workspaceRoot, key, ledger);
  assertAppliedArchiveHistory(workspaceRoot, ledger);
  const candidates = new Map(index.candidates.map((candidate) => [candidate.candidateId, candidate]));
  for (const event of ledger.events.filter((entry) => entry.type === "proposal-recorded")) {
    const candidate = candidates.get(event.candidateId);
    if (!candidate) throw new Error("proposal ledger event has no authenticated candidate");
    const proposal = findExistingProposal(workspaceRoot, candidate);
    const expected = {
      proposalId: proposal?.proposalId,
      targetRefHmac: hmacSha256(key, `target\0${candidate.targetPath}`),
      proposedContentSha256: candidate.recordSha256,
      expectedRevision: candidate.targetExists ? candidate.record.revision - 1 : null
    };
    if (!proposal || canonicalize(event.details) !== canonicalize(expected)) {
      throw new Error("proposal ledger event does not match proposal artifact");
    }
  }
  for (const event of ledger.events.filter((entry) => entry.type === "proposal-applied")) {
    const candidate = candidates.get(event.candidateId);
    if (!candidate) throw new Error("applied ledger event has no authenticated candidate");
    const verified = verifyAppliedCandidate(workspaceRoot, key, candidate, event.details.proposalId, event);
    if (!verified.ok) throw new Error(verified.error);
  }
  return index;
}

function ensureProposal(workspaceRoot, config, candidate, options = {}) {
  const sourcePrefix = options.sourcePrefix ?? "pam-amf-curator";
  const existing = findExistingProposal(workspaceRoot, candidate, sourcePrefix);
  if (existing) return { ok: true, duplicate: true, proposalId: existing.proposalId };
  const source = `${sourcePrefix}:${candidate.candidateId}`;
  const result = candidate.targetExists
    ? proposeEdit(workspaceRoot, config, {
        path: candidate.targetPath,
        rationale: candidate.rationale,
        source,
        findingIds: [candidate.candidateId],
        diff: { kind: "replace", before: candidate.currentContent, after: candidate.recordContent }
      })
    : proposeMemoryRecord(workspaceRoot, config, {
        content: candidate.recordContent,
        rationale: candidate.rationale,
        source,
        findingIds: [candidate.candidateId]
      });
  if (!result.ok) return result;
  return { ok: true, duplicate: false, proposalId: result.proposalId, proposalPath: result.proposalPath };
}

function verifyAppliedCandidate(workspaceRoot, key, candidate, proposalId, event = null, options = {}) {
  const archiveAbsolute = path.join(workspaceRoot, "memory", "maintenance", "proposals", `${proposalId}.applied.json`);
  if (!fs.existsSync(archiveAbsolute)) return { ok: false, error: "applied state is missing its proposal archive" };
  let archiveText;
  let archive;
  try {
    archiveText = readFileNoFollowSync(workspaceRoot, archiveAbsolute);
    archive = JSON.parse(archiveText);
  } catch (error) {
    return { ok: false, error: `applied archive is invalid: ${error.message}` };
  }
  const expectedSource = `${options.sourcePrefix ?? "pam-amf-curator"}:${candidate.candidateId}`;
  const proposedBody = archive?.diff?.kind === "create" ? archive.diff.content : archive?.diff?.after;
  const expectedRevision = candidate.targetExists ? candidate.record.revision - 1 : null;
  const expectedTargetSha256 = candidate.targetExists ? recordSha256(candidate.currentContent) : null;
  if (!isPlainObject(archive) || archive.status !== "applied" || archive.proposalId !== proposalId
      || !isTimestamp(archive.appliedAt)
      || archive.source !== expectedSource || archive.targetPath !== candidate.targetPath
      || archive.proposedContentSha256 !== candidate.recordSha256
      || archive.persistedContentSha256 !== candidate.recordSha256
      || archive.proposedContentLength !== candidate.recordContent.length
      || archive.rationale !== candidate.rationale
      || canonicalize(archive.findingIds) !== canonicalize([candidate.candidateId])
      || archive.expectedRevision !== expectedRevision
      || archive.expectedTargetSha256 !== expectedTargetSha256
      || archive.validation?.schema !== "amf-memory/v1"
      || proposedBody !== candidate.recordContent) {
    return { ok: false, error: "applied archive identity does not match the authenticated candidate" };
  }
  const targetAbsolute = path.join(workspaceRoot, candidate.targetPath);
  if (!fs.existsSync(targetAbsolute)) return { ok: false, error: "applied canonical target is missing" };
  let targetContent;
  try {
    targetContent = readFileNoFollowSync(workspaceRoot, targetAbsolute);
  } catch (error) {
    return { ok: false, error: `applied canonical target is unsafe: ${error.message}` };
  }
  if (recordSha256(targetContent) !== candidate.recordSha256 || targetContent !== candidate.recordContent) {
    return { ok: false, error: "applied canonical target hash/content mismatch" };
  }
  const validation = validateMemoryRecord(targetContent, {
    expectedPath: candidate.targetPath,
    workspaceRoot,
    resolveSupersedes: false,
    checkWorkspaceGraph: false
  });
  if (!validation.ok || validation.metadata.id !== candidate.record.id
      || validation.metadata.revision !== candidate.record.revision) {
    return { ok: false, error: "applied canonical target schema/revision mismatch" };
  }
  const appliedArchiveSha256 = sha256(archiveText);
  if (event && (event.type !== "proposal-applied" || event.details.proposalId !== proposalId
      || event.details.targetRefHmac !== hmacSha256(key, `target\0${candidate.targetPath}`)
      || event.details.persistedContentSha256 !== candidate.recordSha256
      || event.details.recordRefHmac !== hmacSha256(key, `record\0${candidate.record.id}`)
      || event.details.revision !== candidate.record.revision
      || event.details.appliedArchiveSha256 !== appliedArchiveSha256)) {
    return { ok: false, error: "applied ledger event does not match archive and canonical target" };
  }
  return { ok: true, archive, archiveText, appliedArchiveSha256, validation };
}

function candidatePolicyContext(workspaceRoot, candidate) {
  const validation = validateMemoryRecord(candidate.recordContent, {
    expectedPath: candidate.targetPath,
    workspaceRoot,
    resolveSupersedes: false,
    checkWorkspaceGraph: false
  });
  if (!validation.ok || validation.metadata.id !== candidate.record.id
      || validation.metadata.revision !== candidate.record.revision) {
    throw new Error("policy recovery candidate record/version validation failed");
  }
  return {
    ...candidate,
    summary: candidate.record,
    validation,
    duplicateExisting: candidate.targetExists === true && candidate.currentContent === candidate.recordContent
  };
}

function recoverExactPolicyBoundary(workspaceRoot, policy, key, state, candidate, ledger, runtime = {}) {
  const decisionKey = policyDecisionKey(policy);
  const decisionId = safeStableId("decision", `${candidate.candidateId}\0${sha256(decisionKey)}`);
  if (!fs.existsSync(reviewPath(workspaceRoot, decisionId))) {
    return { ok: true, handled: false, ledger };
  }
  let index;
  try {
    index = loadPolicyRecoveryIndex(workspaceRoot, key, ledger, candidate.candidateId, decisionId);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const proposal = ledger.events.find((event) => event.type === "proposal-recorded"
    && event.candidateId === candidate.candidateId && event.decisionId === decisionId);
  const applied = ledger.events.find((event) => event.type === "proposal-applied"
    && event.candidateId === candidate.candidateId && event.decisionId === decisionId);
  const archiveAbsolute = proposal
    ? path.join(workspaceRoot, "memory", "maintenance", "proposals", `${proposal.details.proposalId}.applied.json`)
    : null;
  const externalAheadApply = Boolean(proposal && !applied && fs.existsSync(archiveAbsolute));
  if (!index.unloggedReview && !externalAheadApply) {
    return { ok: true, handled: false, ledger };
  }
  if (!externalAheadApply) {
    try { assertAppliedArchiveHistory(workspaceRoot, ledger); }
    catch (error) { return { ok: false, error: error.message }; }
  }
  let context;
  let duplicate;
  try {
    context = candidatePolicyContext(workspaceRoot, candidate);
    duplicate = findCandidateDuplicate(workspaceRoot, context, index, {
      ignoreCanonicalPath: externalAheadApply ? candidate.targetPath : null
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const evaluation = policyDecision(candidate, duplicate, policy);
  let actorId = "service:amf-curator-policy";
  if (evaluation.action === "promote") {
    const authorized = authorizeReviewer(policy, runtime, ["memory:curate"]);
    if (!authorized.ok) return authorized;
    actorId = authorized.actorId;
  }
  const reviewInput = policyReviewInput(candidate, policy, evaluation, actorId);
  const exact = exactReviewForInput(workspaceRoot, candidate, key, ledger, reviewInput);
  if (!exact.ok) return exact;
  if (!exact.exists || exact.decisionId !== decisionId) {
    return { ok: false, error: "policy recovery review does not match the deterministic policy snapshot" };
  }
  const recovered = recoverExactReviewBoundary(workspaceRoot, candidate, key, state, ledger, reviewInput, runtime);
  if (!recovered.ok) return recovered;
  return {
    ok: true,
    handled: recovered.reviewRecovered === true,
    policyRecovery: recovered.reviewRecovered === true,
    review: exact.review,
    policy: evaluation,
    ledger: recovered.ledger ?? readDecisionLedger(workspaceRoot, key, state)
  };
}

function submitCuratorCandidate(workspaceRoot, config, input, runtime = {}) {
  const submitFields = new Set(["content", "rationale", "idempotencyKey", "confidence", "source", "fabricProposal"]);
  if (!exactKeys(input, submitFields, new Set(["content", "rationale", "idempotencyKey", "confidence", "source"]))) return { ok: false, error: "submit input contains missing or unknown fields" };
  let policy;
  try {
    policy = curatorPolicy(config);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const security = resolveLedgerKey(policy, runtime);
  if (!security.ok) return security;
  const stateResult = resolveStateContext(workspaceRoot, policy, runtime);
  if (!stateResult.ok) return stateResult;
  const state = stateResult;
  const key = security.key;
  const keyError = validateStableKey(input?.idempotencyKey, "idempotencyKey");
  if (keyError) return { ok: false, error: keyError };
  if (typeof input.content !== "string" || Buffer.byteLength(input.content, "utf8") > MAX_RECORD_BYTES) {
    return { ok: false, error: `content must be a record no larger than ${MAX_RECORD_BYTES} bytes` };
  }
  if (typeof input.rationale !== "string" || input.rationale.trim() === ""
      || Buffer.byteLength(input.rationale, "utf8") > MAX_RATIONALE_BYTES) {
    return { ok: false, error: `rationale is required and limited to ${MAX_RATIONALE_BYTES} bytes` };
  }
  const confidence = normalizeConfidence(input.confidence);
  if (confidence === null) return { ok: false, error: "confidence must be between 0 and 1" };
  const source = normalizeSource(input);
  if (!source.ok) return source;
  const fabricProposal = normalizeFabricProposal(input, source.source);
  if (!fabricProposal.ok) return fabricProposal;
  ensureCuratorLayout(workspaceRoot);
  const earlyKeySha256 = sha256(input.idempotencyKey);
  const earlyCandidateId = safeStableId("candidate", earlyKeySha256);
  const earlyInputSha256 = sha256(canonicalize({
    recordSha256: recordSha256(input.content),
    rationale: input.rationale,
    source: source.source,
    confidence,
    fabricProposal: fabricProposal.binding
  }));
  const earlyAbsolute = candidatePath(workspaceRoot, earlyCandidateId);
  let preflightLedger = readDecisionLedger(workspaceRoot, key, state);
  if (!preflightLedger.ok) return { ...preflightLedger, status: "unhealthy", candidates: [] };
  if (fs.existsSync(earlyAbsolute)) {
    const loaded = readCandidate(workspaceRoot, earlyCandidateId, key);
    if (!loaded.ok) return { ...loaded, status: "unhealthy", candidates: [] };
    if (loaded.record.inputSha256 !== earlyInputSha256
        || loaded.record.recordContent !== input.content
        || loaded.record.idempotencyKeySha256 !== earlyKeySha256) {
      return { ok: false, error: `candidate idempotency conflict: ${earlyCandidateId}` };
    }
    const receivedAlready = preflightLedger.events.some((event) => event.type === "candidate-received" && event.candidateId === earlyCandidateId);
    if (!receivedAlready) {
      try {
        verifyIndexWithSingleMissingReceived(workspaceRoot, key, preflightLedger, earlyCandidateId);
      } catch (error) {
        return { ok: false, status: "unhealthy", error: error.message, candidates: [] };
      }
      const initialization = stateInitializationStatus(workspaceRoot, state, key);
      if (!initialization.ok) return { ...initialization, status: "unhealthy", candidates: [] };
      if (!initialization.initialized) {
        if (preflightLedger.events.length !== 0 || listCuratorAppliedArchives(workspaceRoot).length !== 0) {
          return { ok: false, status: "unhealthy", error: "refusing curator state rebootstrap over existing history", candidates: [] };
        }
        const initialized = initializeExternalState(workspaceRoot, state, key);
        if (!initialized.ok) return { ...initialized, status: "unhealthy", candidates: [] };
      }
      const recoveredReceived = appendDecisionEvent(workspaceRoot, key, state, {
        eventId: `event-${earlyCandidateId}-received`,
        occurredAt: loaded.record.receivedAt,
        type: "candidate-received",
        candidateId: earlyCandidateId,
        details: candidateReceivedDetails(loaded.record, key)
      }, runtime);
      if (!recoveredReceived.ok) return recoveredReceived;
      preflightLedger = readDecisionLedger(workspaceRoot, key, state);
      if (!preflightLedger.ok) return { ...preflightLedger, status: "unhealthy", candidates: [] };
    }
    const policyRecovery = recoverExactPolicyBoundary(
      workspaceRoot, policy, key, state, loaded.record, preflightLedger, runtime
    );
    if (!policyRecovery.ok) {
      return { ...policyRecovery, status: "unhealthy", candidates: [] };
    }
    preflightLedger = policyRecovery.ledger ?? preflightLedger;
    if (!preflightLedger.ok) return { ...preflightLedger, status: "unhealthy", candidates: [] };
    try {
      loadVerifiedCuratorIndex(workspaceRoot, key, preflightLedger);
      assertAppliedArchiveHistory(workspaceRoot, preflightLedger);
    } catch (error) {
      return { ok: false, status: "unhealthy", error: error.message, candidates: [] };
    }
    if (preflightLedger.events.some((event) => event.candidateId === earlyCandidateId && event.type === "proposal-applied")) {
      return { ok: false, error: "legacy curator-applied state requires applicator migration" };
    }
  } else {
    try {
      loadVerifiedCuratorIndex(workspaceRoot, key, preflightLedger);
      assertAppliedArchiveHistory(workspaceRoot, preflightLedger);
    } catch (error) {
      return { ok: false, status: "unhealthy", error: error.message, candidates: [] };
    }
  }
  let inspected;
  try {
    inspected = inspectCandidate(workspaceRoot, input.content);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (!inspected.ok) return inspected;
  const recordConfidence = inspected.summary.confidence.score;
  if (confidence !== recordConfidence) {
    return { ok: false, error: "candidate confidence must exactly match record.confidence.score" };
  }
  const idempotencyKeySha256 = sha256(input.idempotencyKey);
  const candidateId = safeStableId("candidate", idempotencyKeySha256);
  const absolute = candidatePath(workspaceRoot, candidateId);
  const inputIdentity = {
    recordSha256: recordSha256(input.content),
    rationale: input.rationale,
    source: source.source,
    confidence: recordConfidence,
    fabricProposal: fabricProposal.binding
  };
  const inputSha256 = sha256(canonicalize(inputIdentity));
  let candidate;
  let duplicateSubmission = false;
  if (fs.existsSync(absolute)) {
    const loaded = readCandidate(workspaceRoot, candidateId, key);
    if (!loaded.ok) return loaded;
    if (loaded.record.inputSha256 !== inputSha256
        || loaded.record.recordContent !== input.content
        || loaded.record.idempotencyKeySha256 !== idempotencyKeySha256) {
      return { ok: false, error: `candidate idempotency conflict: ${candidateId}` };
    }
    candidate = loaded.record;
    duplicateSubmission = true;
  } else {
    candidate = {
      schema: `${CURATOR_SCHEMA}/candidate`,
      candidateId,
      receivedAt: new Date().toISOString(),
      idempotencyKeySha256,
      inputSha256,
      recordSha256: inputIdentity.recordSha256,
      recordContent: input.content,
      rationale: input.rationale,
      source: source.source,
      fabricProposal: fabricProposal.binding,
      confidence: recordConfidence,
      targetPath: inspected.targetPath,
      targetExists: inspected.targetExists,
      currentContent: inspected.currentContent,
      changeKind: inspected.changeKind,
      semanticFingerprint: inspected.semanticFingerprint,
      record: inspected.summary,
      validationWarnings: inspected.validation.warnings
    };
    candidate.artifactMac = artifactMac(key, candidate);
    try {
      atomicWriteFileSync(workspaceRoot, absolute, `${JSON.stringify(candidate, null, 2)}\n`, {
        exclusive: true,
        mode: 0o600
      });
      if (runtime.faultAt === "after-candidate-write") throw new Error("injected curator fault after candidate artifact fsync before first ledger event");
    } catch (error) {
      if (String(error.message).startsWith("injected curator fault")) throw error;
      if (!fs.existsSync(absolute)) return { ok: false, error: `could not queue curator candidate: ${error.message}` };
      const recovered = readCandidate(workspaceRoot, candidateId, key);
      if (!recovered.ok || recovered.record.inputSha256 !== inputSha256
          || recovered.record.recordContent !== input.content
          || recovered.record.idempotencyKeySha256 !== idempotencyKeySha256) {
        return { ok: false, error: `could not queue curator candidate: ${error.message}` };
      }
      candidate = recovered.record;
      duplicateSubmission = true;
    }
  }
  const initialization = stateInitializationStatus(workspaceRoot, state, key);
  if (!initialization.ok) return { ...initialization, status: "unhealthy", candidates: [] };
  if (!initialization.initialized) {
    if (preflightLedger.events.length !== 0 || listCuratorAppliedArchives(workspaceRoot).length !== 0) {
      return { ok: false, status: "unhealthy", error: "refusing curator state rebootstrap over existing history", candidates: [] };
    }
    const initialized = initializeExternalState(workspaceRoot, state, key);
    if (!initialized.ok) return { ...initialized, status: "unhealthy", candidates: [] };
  }
  const received = appendDecisionEvent(workspaceRoot, key, state, {
    eventId: `event-${candidateId}-received`,
    occurredAt: candidate.receivedAt,
    type: "candidate-received",
    candidateId,
    details: candidateReceivedDetails(candidate, key)
  }, runtime);
  if (!received.ok) return received;
  if (duplicateSubmission) {
    const ledger = readDecisionLedger(workspaceRoot, key, state);
    if (!ledger.ok) return ledger;
    if (ledger.events.some((event) => event.candidateId === candidateId && event.type === "proposal-applied")) {
      return { ok: false, error: "legacy curator-applied state requires applicator migration" };
    }
    const latest = latestReview(workspaceRoot, candidateId, key, state);
    if (latest) {
      const receiptAbsolute = decisionReceiptPath(workspaceRoot, latest.decisionId);
      let receipt;
      if (fs.existsSync(receiptAbsolute)) {
        const loadedReceipt = readJsonArtifact(workspaceRoot, receiptAbsolute, "decision receipt");
        if (!loadedReceipt.ok || !validateDecisionReceipt(loadedReceipt.record, key, candidate, latest)) {
          return { ok: false, status: "unhealthy", error: "existing decision receipt is invalid", candidates: [] };
        }
        receipt = loadedReceipt.record;
      } else {
        const expectedPolicyDecisionId = safeStableId(
          "decision",
          `${candidate.candidateId}\0${sha256(policyDecisionKey(policy))}`
        );
        if (latest.decisionId !== expectedPolicyDecisionId) {
          return { ok: false, status: "unhealthy", error: "missing non-policy decision receipt requires exact review retry", candidates: [] };
        }
        const ensuredReceipt = ensureDecisionReceipt(workspaceRoot, key, policy, candidate, latest, runtime);
        if (!ensuredReceipt.ok) return { ...ensuredReceipt, status: "unhealthy", candidates: [] };
        receipt = ensuredReceipt.receipt;
      }
      if (receipt.policyDigest !== curatorPolicyDigest(policy)) {
        return { ok: false, error: "curator policy changed after the existing decision; a new review is required" };
      }
      return {
        ok: true,
        status: receipt.outcome,
        candidateId,
        candidatePath: workspaceRelative(workspaceRoot, absolute),
        decisionId: latest.decisionId,
        decisionDigest: receipt.decisionDigest,
        duplicateSubmission: true,
        fabricReceipt: buildFabricDecisionReceipt(receipt).ok ? buildFabricDecisionReceipt(receipt).receipt : null
      };
    }
  }
  let duplicate;
  try {
    duplicate = deduplicateCandidate(workspaceRoot, { ...inspected, ...candidate, validation: inspected.validation }, key, state);
  } catch (error) {
    return { ok: false, status: "unhealthy", error: error.message, candidates: [] };
  }
  const evaluation = policyDecision(candidate, duplicate, policy);
  let actorId = "service:amf-curator-policy";
  if (evaluation.action === "promote") {
    const authorized = authorizeReviewer(policy, runtime, ["memory:curate"]);
    if (!authorized.ok) return authorized;
    actorId = authorized.actorId;
  }
  const decision = recordReview(
    workspaceRoot, candidate, key, state, policyReviewInput(candidate, policy, evaluation, actorId), runtime
  );
  if (!decision.ok) return decision;
  const receipt = ensureDecisionReceipt(workspaceRoot, key, policy, candidate, decision.review, runtime);
  if (!receipt.ok) return receipt;
  return {
    ok: true,
    status: receipt.receipt.outcome,
    candidateId,
    candidatePath: workspaceRelative(workspaceRoot, absolute),
    decisionId: decision.review.decisionId,
    decisionDigest: receipt.receipt.decisionDigest,
    duplicateSubmission,
    duplicateOf: duplicate,
    policy: evaluation,
    fabricReceipt: buildFabricDecisionReceipt(receipt.receipt).ok ? buildFabricDecisionReceipt(receipt.receipt).receipt : null
  };
}

function reviewCuratorCandidate(workspaceRoot, config, input, runtime = {}) {
  const allowed = new Set(["candidateId", "action", "rationale", "reviewer", "idempotencyKey", "confidence"]);
  const required = new Set(["candidateId", "action", "rationale", "reviewer", "idempotencyKey"]);
  if (!exactKeys(input, allowed, required)) return { ok: false, error: "review input contains missing or unknown fields" };
  if (!new Set(["approve", "reject"]).has(input.action)) return { ok: false, error: "manual action must be approve or reject" };
  if (input.confidence !== undefined && normalizeConfidence(input.confidence) === null) return { ok: false, error: "confidence must be between 0 and 1" };
  if (!SAFE_ACTOR_RE.test(String(input.reviewer ?? ""))) return { ok: false, error: "reviewer must be a canonical declarative identifier" };
  if (typeof input.rationale !== "string" || input.rationale.trim() === ""
      || Buffer.byteLength(input.rationale, "utf8") > MAX_RATIONALE_BYTES) {
    return { ok: false, error: `rationale is required and limited to ${MAX_RATIONALE_BYTES} bytes` };
  }
  let policy;
  try { policy = curatorPolicy(config); } catch (error) { return { ok: false, error: error.message }; }
  const security = resolveLedgerKey(policy, runtime);
  if (!security.ok) return security;
  const stateResult = resolveStateContext(workspaceRoot, policy, runtime);
  if (!stateResult.ok) return stateResult;
  const state = stateResult;
  const authorized = authorizeReviewer(policy, runtime, ["memory:curate"]);
  if (!authorized.ok) return authorized;
  ensureCuratorLayout(workspaceRoot);
  let ledger = readDecisionLedger(workspaceRoot, security.key, state);
  if (!ledger.ok) return ledger;
  const loaded = readCandidate(workspaceRoot, input.candidateId, security.key);
  if (!loaded.ok) return loaded;
  const candidate = loaded.record;
  const reviewInput = {
    idempotencyKey: input.idempotencyKey,
    action: input.action,
    rationale: input.rationale,
    reviewerLabel: input.reviewer,
    actorId: authorized.actorId,
    confidence: input.confidence ?? candidate.confidence,
    apply: false,
    reasons: input.action === "reject" ? ["manual-rejection"] : ["manual-approval"]
  };
  const recovered = recoverExactReviewBoundary(workspaceRoot, candidate, security.key, state, ledger, reviewInput, runtime);
  if (!recovered.ok) return { ...recovered, status: "unhealthy", candidates: [] };
  ledger = recovered.ledger ?? readDecisionLedger(workspaceRoot, security.key, state);
  if (!ledger.ok) return ledger;
  try {
    loadVerifiedCuratorIndex(workspaceRoot, security.key, ledger);
    assertAppliedArchiveHistory(workspaceRoot, ledger);
  } catch (error) {
    return { ok: false, status: "unhealthy", error: error.message, candidates: [] };
  }
  const decision = recordReview(workspaceRoot, candidate, security.key, state, reviewInput, runtime);
  if (!decision.ok) return decision;
  const receipt = ensureDecisionReceipt(workspaceRoot, security.key, policy, candidate, decision.review, runtime);
  if (!receipt.ok) return receipt;
  return {
    ok: true,
    status: receipt.receipt.outcome,
    candidateId: candidate.candidateId,
    decisionId: decision.review.decisionId,
    decisionDigest: receipt.receipt.decisionDigest,
    duplicate: decision.duplicate
  };
}

function curatorStatus(workspaceRoot, config, input = {}, runtime = {}) {
  const allowed = new Set(["candidateId"]);
  if (!exactKeys(input, allowed, new Set())) return { ok: false, status: "unhealthy", error: "status input contains unknown fields", candidates: [] };
  if (input.candidateId !== undefined && !CANDIDATE_ID_RE.test(String(input.candidateId))) {
    return { ok: false, status: "unhealthy", error: "invalid candidateId", candidates: [] };
  }
  let policy;
  try { policy = curatorPolicy(config); } catch (error) { return { ok: false, status: "unhealthy", error: error.message, candidates: [] }; }
  const security = resolveLedgerKey(policy, runtime);
  if (!security.ok) return { ...security, status: "unhealthy", candidates: [] };
  const stateResult = resolveStateContext(workspaceRoot, policy, runtime);
  if (!stateResult.ok) return { ...stateResult, status: "unhealthy", candidates: [] };
  const state = stateResult;
  const ledger = readDecisionLedger(workspaceRoot, security.key, state);
  if (!ledger.ok) return { ...ledger, status: "unhealthy", candidates: [] };
  const queueAbsolute = path.join(workspaceRoot, QUEUE_DIR);
  let candidates = [];
  let reviews = [];
  try {
    assertAppliedArchiveHistory(workspaceRoot, ledger);
    if (fs.existsSync(queueAbsolute)) {
      for (const name of fs.readdirSync(queueAbsolute).sort()) {
        if (!name.endsWith(".json")) throw new Error(`bogus queue artifact: ${name}`);
        const candidateId = name.slice(0, -5);
        const loaded = readCandidate(workspaceRoot, candidateId, security.key);
        if (!loaded.ok) throw new Error(loaded.error);
        candidates.push(loaded.record);
      }
    }
    reviews = listSafeJson(workspaceRoot, REVIEWS_DIR);
    const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
    if (reviews.some((review) => {
      const candidate = candidateById.get(review.candidateId);
      return !candidate || !validateReviewArtifact(review, security.key)
        || !reviewMatchesCandidate(review, candidate);
    })) throw new Error("review artifact authentication or candidate-version binding failed");
    const receivedEvents = ledger.events.filter((event) => event.type === "candidate-received");
    if (receivedEvents.length !== candidates.length) throw new Error("candidate queue and authenticated ledger cardinality differ");
    for (const event of receivedEvents) {
      const candidate = candidateById.get(event.candidateId);
      if (!candidate || canonicalize(event.details) !== canonicalize(candidateReceivedDetails(candidate, security.key))) {
        throw new Error("candidate queue is not bound to the authenticated ledger");
      }
    }
    const decisionEvents = ledger.events.filter((event) => event.type === "decision-recorded");
    if (decisionEvents.length !== reviews.length || reviews.some((review) => !reviewMatchesLedger(review, ledger))) {
      throw new Error("review artifacts are not bound to the authenticated ledger");
    }
    if (ledger.events.some((event) => event.type === "proposal-recorded" || event.type === "proposal-applied")) {
      throw new Error("legacy curator apply events require applicator migration");
    }
    for (const review of reviews) {
      const candidate = candidateById.get(review.candidateId);
      const loaded = readJsonArtifact(workspaceRoot, decisionReceiptPath(workspaceRoot, review.decisionId), "decision receipt");
      if (!loaded.ok || !validateDecisionReceipt(loaded.record, security.key, candidate, review)) {
        throw new Error(`decision receipt is missing or invalid: ${review.decisionId}`);
      }
    }
    if (input.candidateId) candidates = candidates.filter((candidate) => candidate.candidateId === input.candidateId);
  } catch (error) {
    return { ok: false, status: "unhealthy", error: error.message, candidates: [] };
  }
  return {
    ok: true,
    status: "healthy",
    ledger: {
      path: toPosixPath(LEDGER_PATH),
      events: ledger.events.length,
      headMac: ledger.headMac
    },
    candidates: candidates.map((candidate) => {
      const candidateReviews = reviews.filter((review) => review.candidateId === candidate.candidateId);
      const latest = latestReview(workspaceRoot, candidate.candidateId, security.key, state);
      const receipt = latest
        ? readJsonArtifact(workspaceRoot, decisionReceiptPath(workspaceRoot, latest.decisionId), "decision receipt").record
        : null;
      return {
        candidateId: candidate.candidateId,
        record: redactedRecordSummary(candidate.record),
        changeKind: candidate.changeKind,
        receivedAt: candidate.receivedAt,
        decisions: candidateReviews.length,
        latestDecision: latest ? {
          decisionId: latest.decisionId,
          action: latest.action,
          outcome: receipt.outcome,
          decisionDigest: receipt.decisionDigest,
          actorIdSha256: sha256(latest.actorId),
          reviewerLabelSha256: sha256(latest.reviewerLabel)
        } : null
      };
    })
  };
}

function recoverCuratorLedger(workspaceRoot, config, input, runtime = {}) {
  if (!isPlainObject(input) || !new Set(["advance-anchor", "recover-review"]).has(input.action)) {
    return { ok: false, error: "recovery action must be advance-anchor or recover-review" };
  }
  let policy;
  try { policy = curatorPolicy(config); } catch (error) { return { ok: false, error: error.message }; }
  const security = resolveLedgerKey(policy, runtime);
  if (!security.ok) return security;
  const state = resolveStateContext(workspaceRoot, policy, runtime);
  if (!state.ok) return state;
  const authorized = authorizeReviewer(policy, runtime, ["memory:curate"]);
  if (!authorized.ok) return authorized;
  if (input.action === "recover-review") {
    const allowed = new Set([
      "action", "candidateId", "decisionAction", "rationale", "reviewer",
      "idempotencyKey", "confidence"
    ]);
    const required = new Set(["action", "candidateId", "decisionAction", "rationale", "reviewer", "idempotencyKey"]);
    if (!exactKeys(input, allowed, required) || !new Set(["approve", "reject"]).has(input.decisionAction)
        || (input.confidence !== undefined && normalizeConfidence(input.confidence) === null)
        || !SAFE_ACTOR_RE.test(String(input.reviewer ?? ""))) {
      return { ok: false, error: "recover-review input is invalid or contains unknown fields" };
    }
    const ledger = readDecisionLedger(workspaceRoot, security.key, state);
    if (!ledger.ok) return ledger;
    const loaded = readCandidate(workspaceRoot, input.candidateId, security.key);
    if (!loaded.ok) return loaded;
    const reviewInput = {
      idempotencyKey: input.idempotencyKey,
      action: input.decisionAction,
      rationale: input.rationale,
      reviewerLabel: input.reviewer,
      actorId: authorized.actorId,
      confidence: input.confidence ?? loaded.record.confidence,
      apply: false,
      reasons: input.decisionAction === "reject" ? ["manual-rejection"] : ["manual-approval"]
    };
    const exact = exactReviewForInput(workspaceRoot, loaded.record, security.key, ledger, reviewInput);
    if (!exact.ok) return exact;
    if (!exact.exists || exact.logged) {
      return { ok: false, error: "recover-review requires exactly one existing unlogged review artifact" };
    }
    const recovered = recoverExactReviewBoundary(
      workspaceRoot, loaded.record, security.key, state, ledger, reviewInput, runtime
    );
    if (!recovered.ok) return recovered;
    const receipt = ensureDecisionReceipt(workspaceRoot, security.key, policy, loaded.record, exact.review, runtime);
    if (!receipt.ok) return receipt;
    return {
      ok: true,
      status: "recovered",
      action: "recover-review",
      recovery: "review-event",
      candidateId: loaded.record.candidateId,
      decisionId: exact.decisionId,
      actorIdSha256: sha256(authorized.actorId)
    };
  }
  if (!exactKeys(input, new Set(["action"]))) {
    return { ok: false, error: "advance-anchor accepts no fields other than action" };
  }
  const ledger = readDecisionLedger(workspaceRoot, security.key, state, { allowBehind: true });
  if (!ledger.ok) return ledger;
  if (!ledger.anchorBehind) return { ok: false, error: "recovery refused: external anchor is not a strict prefix" };
  try {
    crossCheckLedgerHistory(workspaceRoot, security.key, ledger);
  } catch (error) {
    return { ok: false, error: `recovery cross-check failed: ${error.message}` };
  }
  writeLedgerAnchor(state, security.key, ledger.events, ledger.byteLength);
  const verified = readDecisionLedger(workspaceRoot, security.key, state);
  if (!verified.ok) return verified;
  return {
    ok: true,
    status: "recovered",
    action: "advance-anchor",
    advancedBy: ledger.events.length - ledger.anchoredSequence,
    sequence: verified.events.length,
    headMac: verified.headMac,
    actorIdSha256: sha256(authorized.actorId)
  };
}

function loadApprovedDecisionBundle(workspaceRoot, config, input, runtime = {}) {
  if (!exactKeys(input, new Set(["decisionId"]))) {
    return { ok: false, error: "decision lookup requires exactly decisionId" };
  }
  if (!DECISION_ID_RE.test(String(input.decisionId ?? ""))) return { ok: false, error: "decisionId is invalid" };
  let policy;
  try { policy = curatorPolicy(config); } catch (error) { return { ok: false, error: error.message }; }
  const security = resolveLedgerKey(policy, runtime);
  if (!security.ok) return security;
  const state = resolveStateContext(workspaceRoot, policy, runtime);
  if (!state.ok) return state;
  const ledger = readDecisionLedger(workspaceRoot, security.key, state);
  if (!ledger.ok) return ledger;
  let index;
  try { index = loadVerifiedCuratorIndex(workspaceRoot, security.key, ledger); }
  catch (error) { return { ok: false, error: error.message }; }
  const review = index.reviews.find((entry) => entry.decisionId === input.decisionId);
  if (!review) return { ok: false, error: "decision is not authenticated and ledger-bound" };
  const candidate = index.candidates.find((entry) => entry.candidateId === review.candidateId);
  if (!candidate) return { ok: false, error: "decision candidate is missing" };
  const latest = latestReview(workspaceRoot, candidate.candidateId, security.key, state);
  if (!latest || latest.decisionId !== review.decisionId) {
    return { ok: false, error: "decision is superseded and cannot be applied" };
  }
  const loaded = readJsonArtifact(workspaceRoot, decisionReceiptPath(workspaceRoot, review.decisionId), "decision receipt");
  if (!loaded.ok || !validateDecisionReceipt(loaded.record, security.key, candidate, review)) {
    return { ok: false, error: "decision receipt is missing, altered, or not bound to the candidate" };
  }
  if (loaded.record.outcome !== "approved_pending_apply") {
    return { ok: false, error: `decision outcome is not applicable: ${loaded.record.outcome}` };
  }
  const policyDigestAtApply = curatorPolicyDigest(policy);
  if (loaded.record.policyDigest !== policyDigestAtApply) {
    return { ok: false, error: "curator policy changed after the decision; a new review is required" };
  }
  return {
    ok: true,
    candidate,
    review,
    decisionReceipt: loaded.record,
    policy,
    policyDigestAtApply
  };
}

function planCuratorGitWrite(config, input = {}) {
  const allowed = new Set(["branch", "baseBranch", "remote", "dryRun", "push"]);
  if (!exactKeys(input, allowed, new Set(["branch"]))) return { ok: false, error: "git plan input contains missing or unknown fields" };
  let policy;
  try {
    policy = curatorPolicy(config);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const writer = policy.gitWriter;
  if (writer.enabled !== true) return { ok: false, status: "disabled", error: "curator Git writer is disabled by policy" };
  if (input.dryRun === false || writer.dryRunOnly !== true) {
    return { ok: false, error: "curator Git writer supports dry-run planning only in this release" };
  }
  if (input.push === true) return { ok: false, error: "curator Git writer refuses direct push" };
  if (input.push !== undefined && typeof input.push !== "boolean") return { ok: false, error: "push must be boolean" };
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") return { ok: false, error: "dryRun must be boolean" };
  const branch = String(input.branch ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/.test(branch) || branch.includes("..")) {
    return { ok: false, error: "a safe feature branch is required" };
  }
  if (writer.protectedBranches.includes(branch) || /(^|\/)main$/.test(branch)) {
    return { ok: false, error: `curator Git writer refuses protected branch: ${branch}` };
  }
  for (const [label, value] of [["baseBranch", input.baseBranch ?? "main"], ["remote", input.remote ?? "origin"]]) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) || value.includes("..")) {
      return { ok: false, error: `${label} is invalid` };
    }
  }
  return {
    ok: true,
    status: "dry-run",
    enabled: true,
    branch,
    baseBranch: input.baseBranch ?? "main",
    remote: input.remote ?? "origin",
    operations: ["validate-clean-worktree", "stage-curator-owned-paths", "commit-on-feature-branch"],
    excludedOperations: ["push", "force-push", "direct-main-write", "merge", "deploy"],
    requiresApproval: ["commit", "push", "pull-request"]
  };
}

function buildFabricDecisionReceipt(decisionReceipt) {
  if (!decisionReceipt || !DECISION_OUTCOMES.has(decisionReceipt.outcome)
      || typeof decisionReceipt.fabricProposalId !== "string"
      || typeof decisionReceipt.fabricProposalScope !== "string"
      || !HASH_RE.test(String(decisionReceipt.fabricProposalDigest ?? ""))
      || !DECISION_ID_RE.test(String(decisionReceipt.decisionId ?? ""))
      || !HASH_RE.test(String(decisionReceipt.policyDigest ?? ""))
      || !isTimestamp(decisionReceipt.createdAt)) {
    return { ok: false, error: "decision receipt is not bound to a Fabric proposal" };
  }
  const base = {
    proposalId: decisionReceipt.fabricProposalId,
    proposalScope: decisionReceipt.fabricProposalScope,
    decisionId: decisionReceipt.decisionId,
    status: decisionReceipt.outcome,
    proposalDigest: decisionReceipt.fabricProposalDigest,
    policyDigest: decisionReceipt.policyDigest
  };
  return { ok: true, receipt: { kind: "decision", ...base, decisionDigest: sha256(canonicalize(base)), timestamp: decisionReceipt.createdAt } };
}

export {
  CURATOR_ROOT,
  CURATOR_SCHEMA,
  DEFAULT_POLICY,
  appendDecisionEvent,
  buildFabricDecisionReceipt,
  curatorPolicy,
  curatorStatus,
  inspectCandidate,
  loadApprovedDecisionBundle,
  planCuratorGitWrite,
  readDecisionLedger,
  recoverCuratorLedger,
  reviewCuratorCandidate,
  submitCuratorCandidate,
  ensureProposal as ensureCuratorProposal,
  verifyAppliedCandidate
};
