import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { canonicalize, isAmfRecordPath, parseMemoryRecord } from "./amf-memory-record.mjs";
import { applyProposal, proposalArtifactDigest } from "./memory-apply-proposal.mjs";
import {
  ensureCuratorProposal,
  loadApprovedDecisionBundle,
  buildFabricDecisionReceipt,
  verifyAppliedCandidate
} from "./memory-curator.mjs";
import {
  acquireExclusiveLock,
  assertNoSymlinkPath,
  atomicWriteFileSync,
  readFileNoFollowSync,
  readOwnerOnlyFileSync
} from "./secure-fs.mjs";
import { workspaceRelative } from "./workspace.mjs";

const APPLICATOR_SCHEMA = "amf-receipt-applicator/v1";
const APPLICATOR_ROOT = path.join("memory", "amf", "applicator");
const STATE_DIR = path.join(APPLICATOR_ROOT, "state");
const OUTBOX_DIR = path.join(APPLICATOR_ROOT, "outbox");
const DECISION_MAP_DIR = path.join(APPLICATOR_ROOT, "decision-map");
const GIT_DELIVERY_DIR = path.join(APPLICATOR_ROOT, "git-delivery");
const HASH_RE = /^[0-9a-f]{64}$/;
const SAFE_ACTOR_RE = /^(?:agent|person|service):[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const PHASES = new Set(["prepared", "pam_applied", "receipt_queued", "fabric_acked"]);
const DEFAULT_APPLICATOR = Object.freeze({
  version: APPLICATOR_SCHEMA,
  tokenEnv: "PAM_APPLICATOR_TOKEN",
  stateKeyEnv: "PAM_APPLICATOR_STATE_KEY",
  stateKeyFileEnv: "PAM_APPLICATOR_STATE_KEY_FILE",
  applicators: [],
  recordIndexPath: "memory/amf/record-index.json",
  gitWriter: {
    enabled: false,
    repoRootEnv: "PAM_GIT_WRITER_REPO_ROOT",
    allowedBranches: [],
    push: { enabled: false, remote: null, allowedRemotes: [] }
  },
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
  const gitWriter = isPlainObject(configured.gitWriter) ? configured.gitWriter : {};
  const gitPush = isPlainObject(gitWriter.push) ? gitWriter.push : {};
  const policy = {
    ...DEFAULT_APPLICATOR,
    ...configured,
    applicators: Array.isArray(configured.applicators) ? configured.applicators.map((row) => ({ ...row })) : [],
    transport: { ...DEFAULT_APPLICATOR.transport, ...transport },
    gitWriter: {
      ...DEFAULT_APPLICATOR.gitWriter,
      ...gitWriter,
      allowedBranches: Array.isArray(gitWriter.allowedBranches) ? [...gitWriter.allowedBranches] : [],
      push: { ...DEFAULT_APPLICATOR.gitWriter.push, ...gitPush, allowedRemotes: Array.isArray(gitPush.allowedRemotes) ? [...gitPush.allowedRemotes] : [] }
    }
  };
  if (policy.version !== APPLICATOR_SCHEMA) throw new Error(`unsupported applicator policy: ${policy.version}`);
  if (typeof policy.recordIndexPath !== "string" || !/^memory\/amf\/[A-Za-z0-9][A-Za-z0-9._/-]{1,127}$/.test(policy.recordIndexPath)
      || policy.recordIndexPath.split("/").includes("..")) throw new Error("amfApplicator.recordIndexPath is invalid");
  if (typeof policy.tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.tokenEnv)) {
    throw new Error("amfApplicator.tokenEnv is invalid");
  }
  if (typeof policy.stateKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.stateKeyEnv)) throw new Error("amfApplicator.stateKeyEnv is invalid");
  if (typeof policy.stateKeyFileEnv !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.stateKeyFileEnv)) throw new Error("amfApplicator.stateKeyFileEnv is invalid");
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
  if (typeof policy.gitWriter.enabled !== "boolean" || typeof policy.gitWriter.repoRootEnv !== "string"
      || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy.gitWriter.repoRootEnv)
      || policy.gitWriter.allowedBranches.some(value => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) || value.includes(".."))
      || typeof policy.gitWriter.push.enabled !== "boolean"
      || (policy.gitWriter.push.enabled && (typeof policy.gitWriter.push.remote !== "string" || !policy.gitWriter.push.allowedRemotes.includes(policy.gitWriter.push.remote)))
      || policy.gitWriter.push.allowedRemotes.some(value => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))) throw new Error("amfApplicator.gitWriter is invalid");
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
  const stateKey = resolveStateKey(policy, runtime);
  if (typeof stateKey !== "string" || Buffer.byteLength(stateKey, "utf8") < 32) return { ok: false, error: "applicator state authentication key is not configured" };
  return { ok: true, actorId: actor.actorId, key: Buffer.from(stateKey, "utf8") };
}

function resolveStateKey(policy, runtime = {}) {
  if (typeof runtime.stateKey === "string") return runtime.stateKey;
  const filename = (runtime.env || process.env)[policy.stateKeyFileEnv];
  if (filename) {
    try { return readOwnerOnlyFileSync(filename, { label: "applicator state key", maxBytes: 4096 }).trim(); }
    catch { return null; }
  }
  return (runtime.env || process.env)[policy.stateKeyEnv];
}

function ensureLayout(workspaceRoot) {
  const root = path.join(workspaceRoot, APPLICATOR_ROOT);
  assertNoSymlinkPath(workspaceRoot, root);
  fs.mkdirSync(path.join(workspaceRoot, STATE_DIR), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspaceRoot, OUTBOX_DIR), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspaceRoot, DECISION_MAP_DIR), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspaceRoot, GIT_DELIVERY_DIR), { recursive: true, mode: 0o700 });
  assertNoSymlinkPath(workspaceRoot, root, { allowMissing: false });
  assertNoSymlinkPath(workspaceRoot, path.join(workspaceRoot, STATE_DIR), { allowMissing: false });
  assertNoSymlinkPath(workspaceRoot, path.join(workspaceRoot, OUTBOX_DIR), { allowMissing: false });
}

function gitRun(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", shell: false, maxBuffer: 1024 * 1024 });
}

function gitOutput(root, args, code = 0) {
  const result = gitRun(root, args);
  if (result.status !== code) throw new Error("Git delivery command failed");
  return result.stdout;
}

function gitDeliveryPath(workspaceRoot, decisionId) { return path.join(workspaceRoot, GIT_DELIVERY_DIR, `${decisionId}.json`); }

function writeGitDelivery(workspaceRoot, key, value) {
  const next = { ...value }; next.artifactMac = artifactMac(key, next);
  atomicWriteFileSync(workspaceRoot, gitDeliveryPath(workspaceRoot, value.decisionId), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

function commitPaths(root, revision) {
  return gitOutput(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", revision]).trim().split("\n").filter(Boolean).sort();
}

function recoverDeliveryCommit(root, decisionId, expectedPaths) {
  const result = gitRun(root, ["log", "-1", "--format=%H%x00%B"]);
  if (result.status !== 0) return null;
  const [commit, message = ""] = result.stdout.split("\0");
  if (!message.includes(`AMF-Decision: ${decisionId}`) || canonicalize(commitPaths(root, commit)) !== canonicalize([...expectedPaths].sort())) return null;
  return commit.trim();
}

function gitRepositoryIdentity(root) {
  const common = gitOutput(root, ["rev-parse", "--git-common-dir"]).trim();
  const commonRealpath = fs.realpathSync(path.isAbsolute(common) ? common : path.resolve(root, common));
  return sha256(canonicalize({ root: fs.realpathSync(root), commonGitDir: commonRealpath }));
}

function gitPushBinding(root, writer, branch) {
  const targetRef = `refs/heads/${branch}`;
  if (!writer.push.enabled) return { enabled: false, remote: null, remoteUrlSha256: null, targetRef };
  const remote = writer.push.remote;
  if (!writer.push.allowedRemotes.includes(remote)) throw new Error("Git remote is not allowlisted");
  const remoteUrl = gitOutput(root, ["remote", "get-url", "--push", remote]).trim();
  if (!remoteUrl || /[\r\n\0]/.test(remoteUrl)) throw new Error("Git push remote is invalid");
  return { enabled: true, remote, remoteUrlSha256: sha256(remoteUrl), targetRef };
}

function pushCommit(root, writer, binding, commit) {
  if (!writer.push.enabled) throw new Error("Git push is disabled by policy");
  const remote = binding.remote;
  const branch = binding.targetRef.slice("refs/heads/".length);
  if (canonicalize(gitPushBinding(root, writer, branch)) !== canonicalize(binding)) throw new Error("Git push target binding changed");
  const remoteHead = gitRun(root, ["ls-remote", "--exit-code", "--heads", remote, binding.targetRef]);
  if (remoteHead.status === 0) {
    const remoteCommit = remoteHead.stdout.trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{40}$/.test(remoteCommit) || gitRun(root, ["fetch", "--no-tags", remote, remoteCommit]).status !== 0
        || gitRun(root, ["merge-base", "--is-ancestor", remoteCommit, commit]).status !== 0) throw new Error("Git push is not fast-forward");
  } else if (remoteHead.status !== 2) throw new Error("Git remote inspection failed");
  if (gitRun(root, ["push", remote, `${commit}:${binding.targetRef}`]).status !== 0) throw new Error("Git push was rejected");
  return remote;
}

function loadGitDeliveryReadyState(workspaceRoot, config, decisionId, bundle, key) {
  const map = readJson(workspaceRoot, decisionMapPath(workspaceRoot, decisionId), "applicator decision map");
  if (!map.ok || map.record.schema !== `${APPLICATOR_SCHEMA}/decision-map`
      || map.record.decisionId !== decisionId
      || !/^apply-[0-9a-f]{40}$/.test(String(map.record.applyId ?? ""))
      || !secureDigestEqual(artifactMac(key, map.record), map.record.artifactMac)) {
    return { ok: false, error: "Git delivery requires an authenticated receipt-ready apply state" };
  }
  const loaded = readJson(workspaceRoot, statePath(workspaceRoot, map.record.applyId), "applicator state");
  if (!loaded.ok || !validState(loaded.record, key)
      || !["receipt_queued", "fabric_acked"].includes(loaded.record.phase)
      || loaded.record.decisionId !== decisionId
      || loaded.record.candidateId !== bundle.candidate.candidateId) {
    return { ok: false, error: "Git delivery requires an authenticated receipt-ready apply state" };
  }
  const fabric = buildFabricApplyReceipt(loaded.record.receipt);
  const verified = fabric.ok
    ? verifyFabricApplyReceipt(workspaceRoot, config, fabric.receipt, { stateKey: key.toString("utf8") })
    : fabric;
  if (!verified.ok || verified.verified !== true) {
    return { ok: false, error: "Git delivery canonical artifacts do not match the authenticated apply receipt" };
  }
  return { ok: true, state: loaded.record };
}

function deliverAppliedMemoryToGit(workspaceRoot, config, input, runtime = {}) {
  if (!exactKeys(input, new Set(["decisionId", "push"]), new Set(["decisionId"]))
      || !/^decision-[0-9a-f]{40}$/.test(String(input.decisionId ?? ""))
      || (input.push !== undefined && typeof input.push !== "boolean")) return { ok: false, error: "Git delivery input is invalid" };
  let policy;
  try { policy = applicatorPolicy(config); } catch (error) { return { ok: false, error: error.message }; }
  const authorized = authorizeApplicator(policy, runtime); if (!authorized.ok) return authorized;
  const writer = policy.gitWriter;
  if (!writer.enabled) return { ok: false, status: "disabled", error: "Git writer is disabled by policy" };
  const configuredRoot = (runtime.env || process.env)[writer.repoRootEnv];
  let root;
  try { root = fs.realpathSync(configuredRoot); } catch { return { ok: false, error: "Git repository root is unavailable" }; }
  if (root !== fs.realpathSync(workspaceRoot) || gitRun(root, ["rev-parse", "--show-toplevel"]).stdout.trim() !== root) return { ok: false, error: "Git repository root is not the PAM workspace" };
  const branch = gitOutput(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  if (!writer.allowedBranches.includes(branch)) return { ok: false, error: "Git branch is not allowlisted" };
  let repoIdentity; let pushBinding;
  try { repoIdentity = gitRepositoryIdentity(root); pushBinding = gitPushBinding(root, writer, branch); }
  catch (error) { return { ok: false, error: error.message }; }
  const bundle = loadApprovedDecisionBundle(workspaceRoot, config, { decisionId: input.decisionId }, runtime);
  if (!bundle.ok) return bundle;
  const expectedPaths = [bundle.candidate.targetPath, policy.recordIndexPath].sort();
  ensureLayout(workspaceRoot);
  const lock = acquireExclusiveLock(workspaceRoot, path.join(workspaceRoot, APPLICATOR_ROOT, "git-writer.lock"));
  try {
    const ready = loadGitDeliveryReadyState(workspaceRoot, config, input.decisionId, bundle, authorized.key);
    if (!ready.ok) return ready;
    const stateAbsolute = gitDeliveryPath(workspaceRoot, input.decisionId);
    let delivery = null;
    const stateExisted = fs.existsSync(stateAbsolute);
    if (stateExisted) {
      const loaded = readJson(workspaceRoot, stateAbsolute, "Git delivery state");
      if (!loaded.ok || !secureDigestEqual(artifactMac(authorized.key, loaded.record), loaded.record.artifactMac)
          || loaded.record.schema !== `${APPLICATOR_SCHEMA}/git-delivery`
          || loaded.record.decisionId !== input.decisionId || loaded.record.repoIdentity !== repoIdentity
          || !["committed", "pushed"].includes(loaded.record.phase) || !/^[a-f0-9]{40,64}$/.test(String(loaded.record.commit ?? ""))
          || loaded.record.branch !== branch || canonicalize(loaded.record.pushBinding) !== canonicalize(pushBinding)
          || (loaded.record.phase === "committed" ? loaded.record.remote !== null : loaded.record.remote !== pushBinding.remote)
          || canonicalize(loaded.record.paths) !== canonicalize(expectedPaths)
          || canonicalize(commitPaths(root, loaded.record.commit)) !== canonicalize(expectedPaths)) return { ok: false, error: "Git delivery state is invalid" };
      delivery = loaded.record;
    }
    if (!delivery) {
      const records = gitOutput(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0").filter(Boolean);
      const changed = records.map(record => {
        const status = record.slice(0, 2);
        if (record.length < 4 || ["R", "C"].some(code => status.includes(code))) throw new Error("Git rename/copy state is not allowed");
        if (status.includes("U") || status === "AA" || status === "DD") throw new Error("Git unmerged state is not allowed");
        return record.slice(3);
      }).sort();
      if (changed.some(filename => !expectedPaths.includes(filename))) return { ok: false, error: "Git worktree contains unrelated changes" };
      let commit = changed.length ? null : recoverDeliveryCommit(root, input.decisionId, expectedPaths);
      if (!commit) {
        if (!changed.length) return { ok: false, error: "Git delivery has no scoped changes" };
        if (gitRun(root, ["add", "--", ...expectedPaths]).status !== 0) return { ok: false, error: "Git staging failed" };
        const message = `chore(memory): promote ${bundle.candidate.record.id}\n\nAMF-Decision: ${input.decisionId}`;
        const committed = gitRun(root, ["commit", "-m", message, "--", ...expectedPaths]);
        if (committed.status !== 0) {
          gitRun(root, ["restore", "--staged", "--", ...expectedPaths]);
          return { ok: false, error: "Git commit failed; scoped staging rolled back" };
        }
        commit = gitOutput(root, ["rev-parse", "HEAD"]).trim();
      }
      if (canonicalize(commitPaths(root, commit)) !== canonicalize(expectedPaths)) return { ok: false, error: "Git commit scope verification failed" };
      delivery = writeGitDelivery(workspaceRoot, authorized.key, {
        schema: `${APPLICATOR_SCHEMA}/git-delivery`, decisionId: input.decisionId, phase: "committed",
        commit, repoIdentity, branch, pushBinding, remote: null, paths: expectedPaths
      });
    }
    if (input.push === true && delivery.phase !== "pushed") {
      const remote = pushCommit(root, writer, delivery.pushBinding, delivery.commit);
      delivery = writeGitDelivery(workspaceRoot, authorized.key, { ...delivery, phase: "pushed", remote });
    }
    return { ok: true, status: delivery.phase, decisionId: input.decisionId, commit: delivery.commit, branch, remote: delivery.remote, duplicate: stateExisted };
  } catch (error) { return { ok: false, error: error.message }; }
  finally { lock.release(); }
}

function decisionMapPath(workspaceRoot, decisionId) { return path.join(workspaceRoot, DECISION_MAP_DIR, `${decisionId}.json`); }

function writeDecisionMap(workspaceRoot, key, decisionId, applyId) {
  const absolute = decisionMapPath(workspaceRoot, decisionId);
  const value = { schema: `${APPLICATOR_SCHEMA}/decision-map`, decisionId, applyId };
  value.artifactMac = artifactMac(key, value);
  if (fs.existsSync(absolute)) {
    const loaded = readJson(workspaceRoot, absolute, "applicator decision map");
    if (!loaded.ok || canonicalize(loaded.record) !== canonicalize(value)) return { ok: false, error: "applicator decision map conflict" };
    return { ok: true };
  }
  atomicWriteFileSync(workspaceRoot, absolute, `${JSON.stringify(value, null, 2)}\n`, { exclusive: true, mode: 0o600 });
  return { ok: true };
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
    && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(String(state.fabricProposalId ?? ""))
    && typeof state.fabricProposalScope === "string" && state.fabricProposalScope.length >= 3 && state.fabricProposalScope.length <= 256
    && HASH_RE.test(String(state.fabricProposalDigest ?? ""))
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
  const metadata = parseMemoryRecord(bundle.candidate.recordContent).metadata;
  return {
    schema: `${APPLICATOR_SCHEMA}/apply-receipt`,
    receiptType: "memory_apply_receipt",
    applyId: state.applyId,
    proposalId: state.fabricProposalId,
    proposalScope: state.fabricProposalScope,
    decisionId: bundle.decisionReceipt.decisionId,
    decisionDigest: state.decisionDigest,
    policyDigestAtApply: state.policyDigestAtApply,
    canonicalRecordId: bundle.decisionReceipt.canonicalRecordId,
    revision: bundle.decisionReceipt.candidateRevision,
    canonicalLifecycleAtDecision: bundle.decisionReceipt.canonicalLifecycleAtDecision,
    proposalDigest: state.fabricProposalDigest,
    archiveDigest: verified.appliedArchiveSha256,
    targetDigest: sha256(canonicalize(metadata)),
    appliedAt: verified.archive.appliedAt
  };
}

function contextRefsForScope(scope) {
  if (scope.type === "room") return { conversation: [scope.id], room: [scope.id] };
  if (scope.type === "person") return { person: [scope.id] };
  if (scope.type === "relationship") return { relationship: [scope.id] };
  return null;
}

function updateRecordIndex(workspaceRoot, policy, candidate) {
  const absolute = path.join(workspaceRoot, policy.recordIndexPath);
  const lock = acquireExclusiveLock(workspaceRoot, `${absolute}.lock`);
  try {
    let index = { schema: "amf-record-index/v1", records: {} };
    if (fs.existsSync(absolute)) {
      const loaded = readJson(workspaceRoot, absolute, "AMF record index");
      if (!loaded.ok || loaded.record.schema !== "amf-record-index/v1"
          || !isPlainObject(loaded.record.records)) return { ok: false, error: "AMF record index is invalid" };
      index = loaded.record;
    }
    const metadata = parseMemoryRecord(candidate.recordContent).metadata;
    const entry = { path: candidate.targetPath, scope: metadata.scope.id };
    const contextRefs = contextRefsForScope(metadata.scope);
    if (contextRefs) entry.contextRefs = contextRefs;
    const next = { schema: "amf-record-index/v1", records: { ...index.records, [metadata.id]: entry } };
    atomicWriteFileSync(workspaceRoot, absolute, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, entry };
  } finally {
    lock.release();
  }
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

function buildFabricApplyReceipt(receipt) {
  const fields = ["proposalId", "proposalScope", "decisionId", "decisionDigest", "policyDigestAtApply", "canonicalRecordId", "revision", "canonicalLifecycleAtDecision", "proposalDigest", "archiveDigest", "targetDigest"];
  if (!isPlainObject(receipt) || fields.some(field => receipt[field] === undefined)) return { ok: false, error: "apply receipt is incomplete" };
  return { ok: true, receipt: { kind: "apply", ...Object.fromEntries(fields.map(field => [field, receipt[field]])), timestamp: receipt.appliedAt } };
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
  const fabricDecision = buildFabricDecisionReceipt(bundle.decisionReceipt);
  const boundDecisionDigest = fabricDecision.ok ? fabricDecision.receipt.decisionDigest : bundle.decisionReceipt.decisionDigest;
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
          || loaded.record.decisionDigest !== boundDecisionDigest) {
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
        decisionDigest: boundDecisionDigest,
        policyDigestAtApply: bundle.policyDigestAtApply,
        proposalId: proposed.proposalId,
        proposalDigest: proposalArtifactDigest(proposalRecord),
        fabricProposalId: bundle.candidate.fabricProposal?.proposalId ?? proposed.proposalId,
        fabricProposalScope: bundle.candidate.record.scope.id,
        fabricProposalDigest: bundle.candidate.fabricProposal?.proposalDigest ?? proposalArtifactDigest(proposalRecord),
        phase: "prepared",
        receipt: null,
        ack: null,
        updatedAt: new Date().toISOString()
      });
      if (runtime.faultAt === "after-prepared") throw new Error("injected applicator fault after prepared state");
    }

    const mapped = writeDecisionMap(workspaceRoot, authorized.key, input.decisionId, applyId);
    if (!mapped.ok) return mapped;

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
      const indexed = updateRecordIndex(workspaceRoot, policy, bundle.candidate);
      if (!indexed.ok) return indexed;
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

function verifyFabricApplyReceipt(workspaceRoot, config, receipt, runtime = {}) {
  let policy;
  try { policy = applicatorPolicy(config); } catch (error) { return { ok: false, error: error.message }; }
  const stateKey = resolveStateKey(policy, runtime);
  if (typeof stateKey !== "string" || Buffer.byteLength(stateKey, "utf8") < 32) return { ok: false, error: "applicator verifier key is not configured" };
  const key = Buffer.from(stateKey, "utf8");
  if (!isPlainObject(receipt) || receipt.kind !== "apply" || !/^decision-[0-9a-f]{40}$/.test(String(receipt.decisionId ?? ""))) return { ok: false, error: "apply receipt is invalid" };
  const map = readJson(workspaceRoot, decisionMapPath(workspaceRoot, receipt.decisionId), "applicator decision map");
  if (!map.ok || map.record.schema !== `${APPLICATOR_SCHEMA}/decision-map`
      || map.record.decisionId !== receipt.decisionId || !/^apply-[0-9a-f]{40}$/.test(String(map.record.applyId ?? ""))
      || !secureDigestEqual(artifactMac(key, map.record), map.record.artifactMac)) return { ok: false, error: "applicator decision map is invalid" };
  const loaded = readJson(workspaceRoot, statePath(workspaceRoot, map.record.applyId), "applicator state");
  if (!loaded.ok || !validState(loaded.record, key) || !["receipt_queued", "fabric_acked"].includes(loaded.record.phase)) return { ok: false, error: "applicator state is not receipt-ready" };
  const expected = buildFabricApplyReceipt(loaded.record.receipt);
  if (!expected.ok || canonicalize(expected.receipt) !== canonicalize(receipt)) return { ok: false, error: "apply receipt does not match authenticated state" };
  const archiveAbsolute = path.join(workspaceRoot, "memory", "maintenance", "proposals", `${loaded.record.proposalId}.applied.json`);
  let archiveText;
  try { archiveText = readFileNoFollowSync(workspaceRoot, archiveAbsolute); }
  catch { return { ok: false, error: "apply archive is unavailable" }; }
  if (sha256(archiveText) !== receipt.archiveDigest) return { ok: false, error: "apply archive digest mismatch" };
  const index = readJson(workspaceRoot, path.join(workspaceRoot, policy.recordIndexPath), "AMF record index");
  const entry = index.ok && index.record.schema === "amf-record-index/v1" && isPlainObject(index.record.records)
    ? index.record.records[receipt.canonicalRecordId]
    : null;
  if (!isPlainObject(entry) || !isAmfRecordPath(entry.path)) return { ok: false, error: "canonical record index entry is missing" };
  let metadata;
  try { metadata = parseMemoryRecord(readFileNoFollowSync(workspaceRoot, path.join(workspaceRoot, entry.path))).metadata; }
  catch { return { ok: false, error: "canonical target is unavailable or invalid" }; }
  if (metadata.id !== receipt.canonicalRecordId || metadata.revision !== receipt.revision
      || entry.scope !== metadata.scope.id
      || metadata.lifecycle.status !== receipt.canonicalLifecycleAtDecision
      || sha256(canonicalize(metadata)) !== receipt.targetDigest) return { ok: false, error: "canonical target digest mismatch" };
  return { ok: true, verified: true, archiveDigest: receipt.archiveDigest, targetDigest: receipt.targetDigest, revision: receipt.revision };
}

function loadFabricApplyReceiptForDispatch(workspaceRoot, config, input, runtime = {}) {
  if (!exactKeys(input, new Set(["decisionId"])) || !/^decision-[0-9a-f]{40}$/.test(String(input.decisionId ?? ""))) return { ok: false, error: "decisionId is invalid" };
  let policy;
  try { policy = applicatorPolicy(config); } catch (error) { return { ok: false, error: error.message }; }
  const authorized = authorizeApplicator(policy, runtime);
  if (!authorized.ok) return authorized;
  const map = readJson(workspaceRoot, decisionMapPath(workspaceRoot, input.decisionId), "applicator decision map");
  if (!map.ok || !secureDigestEqual(artifactMac(authorized.key, map.record), map.record.artifactMac)) return { ok: false, error: "applicator decision map is invalid" };
  const loaded = readJson(workspaceRoot, statePath(workspaceRoot, map.record.applyId), "applicator state");
  if (!loaded.ok || !validState(loaded.record, authorized.key) || !["receipt_queued", "fabric_acked"].includes(loaded.record.phase)) return { ok: false, error: "apply receipt is not ready" };
  const fabric = buildFabricApplyReceipt(loaded.record.receipt);
  return fabric.ok ? { ok: true, applyId: loaded.record.applyId, status: loaded.record.phase, receipt: fabric.receipt } : fabric;
}

function recordFabricApplyAck(workspaceRoot, config, input, runtime = {}) {
  if (!exactKeys(input, new Set(["decisionId", "receipt", "ackId", "acknowledgedAt"]))
      || !/^decision-[0-9a-f]{40}$/.test(String(input.decisionId ?? ""))
      || typeof input.ackId !== "string" || input.ackId.length < 1 || input.ackId.length > 256
      || typeof input.acknowledgedAt !== "string" || !Number.isFinite(Date.parse(input.acknowledgedAt))) return { ok: false, error: "Fabric apply ack is invalid" };
  let policy;
  try { policy = applicatorPolicy(config); } catch (error) { return { ok: false, error: error.message }; }
  const authorized = authorizeApplicator(policy, runtime);
  if (!authorized.ok) return authorized;
  const map = readJson(workspaceRoot, decisionMapPath(workspaceRoot, input.decisionId), "applicator decision map");
  if (!map.ok || !secureDigestEqual(artifactMac(authorized.key, map.record), map.record.artifactMac)) return { ok: false, error: "applicator decision map is invalid" };
  const lock = acquireExclusiveLock(workspaceRoot, path.join(workspaceRoot, APPLICATOR_ROOT, `${map.record.applyId}.lock`));
  try {
    const loaded = readJson(workspaceRoot, statePath(workspaceRoot, map.record.applyId), "applicator state");
    if (!loaded.ok || !validState(loaded.record, authorized.key) || !["receipt_queued", "fabric_acked"].includes(loaded.record.phase)) return { ok: false, error: "apply receipt is not ready" };
    const fabric = buildFabricApplyReceipt(loaded.record.receipt);
    if (!fabric.ok || canonicalize(fabric.receipt) !== canonicalize(input.receipt)) return { ok: false, error: "Fabric apply ack receipt mismatch" };
    const ack = { ackId: input.ackId, acknowledgedAt: input.acknowledgedAt };
    if (loaded.record.phase === "fabric_acked") {
      return canonicalize(loaded.record.ack) === canonicalize(ack) ? { ok: true, duplicate: true, status: "fabric_acked" } : { ok: false, error: "Fabric apply ack conflict" };
    }
    writeState(workspaceRoot, authorized.key, { ...loaded.record, phase: "fabric_acked", ack });
    return { ok: true, duplicate: false, status: "fabric_acked" };
  } finally { lock.release(); }
}

export {
  APPLICATOR_ROOT,
  APPLICATOR_SCHEMA,
  DEFAULT_APPLICATOR,
  applicatorPolicy,
  applyDecisionReceipt,
  buildFabricApplyReceipt,
  deliverAppliedMemoryToGit,
  loadFabricApplyReceiptForDispatch,
  recordFabricApplyAck,
  verifyFabricApplyReceipt
};
