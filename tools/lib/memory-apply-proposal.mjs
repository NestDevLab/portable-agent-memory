import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  PROPOSALS_DIRNAME,
  applyReplace,
  applyUnifiedDiff,
  parseUnifiedDiff,
  summarizeAmfValidation,
  validateAmfRecordTarget,
  validateGraphJsonl,
  validatePathSafety
} from "./memory-proposals.mjs";
import { isAmfRecordPath, recordSha256 } from "./amf-memory-record.mjs";
import {
  acquireExclusiveLock,
  atomicWriteFileSync,
  readFileNoFollowSync,
  removeRegularFileNoFollowSync
} from "./secure-fs.mjs";
import { toPosixPath, workspaceRelative } from "./workspace.mjs";

function proposalPathFor(workspaceRoot, proposalId) {
  return path.join(workspaceRoot, PROPOSALS_DIRNAME, `${proposalId}.json`);
}

function appliedPathFor(workspaceRoot, proposalId) {
  return path.join(workspaceRoot, PROPOSALS_DIRNAME, `${proposalId}.applied.json`);
}

function validateProposalId(proposalId) {
  if (typeof proposalId !== "string" || proposalId.trim() === "") return "proposalId is required";
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(proposalId) || proposalId.includes("..")) {
    return "proposalId contains invalid characters or path separators";
  }
  return null;
}

function readJsonArtifact(workspaceRoot, absolute, label) {
  try {
    return { ok: true, record: JSON.parse(readFileNoFollowSync(workspaceRoot, absolute)) };
  } catch (error) {
    return { ok: false, error: `${label} is not valid safe JSON: ${error.message}` };
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function proposalIdentity(record) {
  return {
    proposalId: record?.proposalId ?? null,
    createdAt: record?.createdAt ?? null,
    source: record?.source ?? null,
    targetPath: record?.targetPath ?? null,
    diff: record?.diff ?? null,
    rationale: record?.rationale ?? null,
    findingIds: Array.isArray(record?.findingIds) ? record.findingIds : [],
    expectedRevision: record?.expectedRevision ?? null,
    expectedTargetSha256: record?.expectedTargetSha256 ?? null,
    proposedContentSha256: record?.proposedContentSha256 ?? null,
    proposedContentLength: record?.proposedContentLength ?? null
  };
}

function proposalArtifactDigest(record) {
  return crypto.createHash("sha256").update(canonicalJson(proposalIdentity(record)), "utf8").digest("hex");
}

function validationWarningSummary(validation) {
  const summary = validation?.amfMemory ?? validation ?? {};
  return {
    warnings: Array.isArray(summary.warnings) ? summary.warnings.map(String) : [],
    graphProjectionStale: summary.graphProjectionStale === true,
    regenerateAfterApply: summary.regenerateAfterApply === true,
    followup: summary.followup ?? null
  };
}

function validateAppliedArchiveBinding(proposalId, archive, proposal = null) {
  const proposedHash = String(archive?.proposedContentSha256 ?? "");
  const persistedHash = String(archive?.persistedContentSha256 ?? "");
  if (archive?.status !== "applied" || archive?.proposalId !== proposalId
      || typeof archive?.targetPath !== "string"
      || !/^[0-9a-f]{64}$/i.test(proposedHash)
      || !/^[0-9a-f]{64}$/i.test(persistedHash)
      || proposedHash !== persistedHash) {
    return "applied archive is malformed or belongs to another proposal";
  }
  if (!proposal) return null;
  if (proposal.proposalId !== proposalId
      || canonicalJson(proposalIdentity(archive)) !== canonicalJson(proposalIdentity(proposal))) {
    return "applied archive identity does not match the live proposal";
  }
  if (proposal.proposedContentSha256 !== proposedHash) {
    return "applied archive content hash does not match the live proposal";
  }
  if (canonicalJson(validationWarningSummary(archive.validation))
      !== canonicalJson(validationWarningSummary(proposal.validation))) {
    return "applied archive validation warnings do not match the live proposal";
  }
  return null;
}

function loadProposal(workspaceRoot, proposalId) {
  const absolute = proposalPathFor(workspaceRoot, proposalId);
  if (!fs.existsSync(absolute)) return { ok: false, error: `proposal not found: ${proposalId}` };
  const loaded = readJsonArtifact(workspaceRoot, absolute, "proposal");
  if (!loaded.ok) return loaded;
  if (loaded.record.proposalId !== proposalId) return { ok: false, error: "proposal artifact id does not match requested id" };
  return { ok: true, record: loaded.record, absolute };
}

function loadArchive(workspaceRoot, proposalId) {
  const absolute = appliedPathFor(workspaceRoot, proposalId);
  if (!fs.existsSync(absolute)) return { ok: true, exists: false, absolute, record: null };
  const loaded = readJsonArtifact(workspaceRoot, absolute, "applied archive");
  if (!loaded.ok) return loaded;
  return { ok: true, exists: true, absolute, record: loaded.record };
}

function renderProposedContent(targetPath, diff, currentContent) {
  if (diff.kind === "create") {
    if (!isAmfRecordPath(targetPath)) return { ok: false, error: "create proposals are restricted to AMF memory record paths" };
    if (typeof diff.content !== "string" || diff.content.trim() === "") return { ok: false, error: "create proposal requires content" };
    return { ok: true, content: diff.content };
  }
  if (diff.kind === "replace") {
    const applied = applyReplace(currentContent, diff);
    return applied.ok ? { ok: true, content: applied.next } : applied;
  }
  if (diff.kind === "unified-diff") {
    if (typeof diff.patch !== "string" || diff.patch.trim() === "") return { ok: false, error: "unified-diff requires a patch string" };
    const parsed = parseUnifiedDiff(diff.patch);
    if (!parsed.ok) return parsed;
    if (toPosixPath(parsed.targetPath) !== toPosixPath(targetPath)) {
      return { ok: false, error: `diff target mismatch: ${parsed.targetPath} vs ${targetPath}` };
    }
    const applied = applyUnifiedDiff(currentContent, parsed);
    return applied.ok ? { ok: true, content: applied.next } : applied;
  }
  return { ok: false, error: `unsupported diff kind: ${diff.kind}` };
}

function resultFromArchive(workspaceRoot, archive, recovered = false) {
  const validation = archive.validation ?? null;
  return {
    ok: true,
    status: "applied",
    target: toPosixPath(archive.targetPath),
    proposalArchivedAs: workspaceRelative(workspaceRoot, appliedPathFor(workspaceRoot, archive.proposalId)),
    appliedAt: archive.appliedAt,
    recovered,
    validation,
    warnings: validation?.warnings ?? [],
    graphProjectionStale: validation?.graphProjectionStale ?? false,
    regenerateAfterApply: validation?.regenerateAfterApply ?? false,
    followup: validation?.followup ?? null
  };
}

function recoverAppliedArchive(workspaceRoot, config, proposalId, archive, liveProposal = null) {
  const bindingError = validateAppliedArchiveBinding(proposalId, archive, liveProposal?.record);
  if (bindingError) return { ok: false, error: bindingError };
  const pathCheck = validatePathSafety(workspaceRoot, archive.targetPath, config);
  if (!pathCheck.ok) return { ok: false, error: pathCheck.error };
  if (!fs.existsSync(pathCheck.absolute)) return { ok: false, error: "applied archive exists but target is missing" };
  try {
    const content = readFileNoFollowSync(workspaceRoot, pathCheck.absolute);
    if (recordSha256(content) !== archive.persistedContentSha256) {
      return { ok: false, error: "applied archive target hash mismatch" };
    }
    if (liveProposal) {
      const refreshed = loadProposal(workspaceRoot, proposalId);
      if (!refreshed.ok) return { ok: false, error: `could not revalidate live proposal before recovery: ${refreshed.error}` };
      const refreshedBindingError = validateAppliedArchiveBinding(proposalId, archive, refreshed.record);
      if (refreshedBindingError) return { ok: false, error: refreshedBindingError };
      removeRegularFileNoFollowSync(workspaceRoot, refreshed.absolute);
    }
    return resultFromArchive(workspaceRoot, archive, true);
  } catch (error) {
    return { ok: false, error: `could not recover applied proposal: ${error.message}` };
  }
}

const RESERVATION_OPERATION_FIELDS = new Set([
  "status",
  "reservationId",
  "reservedAt",
  "appliedAt",
  "persistedContentSha256"
]);

function reservationProposalIdentity(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !RESERVATION_OPERATION_FIELDS.has(key))
  );
}

function reservationMatches(reservation, proposal) {
  return reservation?.status === "applying"
    && typeof reservation.reservationId === "string"
    && reservation.reservationId.trim() !== ""
    && Number.isFinite(Date.parse(reservation.reservedAt))
    && canonicalJson(reservationProposalIdentity(reservation))
      === canonicalJson(reservationProposalIdentity(proposal));
}

function applyProposal(workspaceRoot, config, input, runtimeOptions = {}) {
  const proposalId = input?.proposalId;
  const lockOptions = runtimeOptions.lockOptions ?? {};
  const expectedProposalDigest = runtimeOptions.expectedProposalDigest;
  const invalid = validateProposalId(proposalId);
  if (invalid) return { ok: false, error: invalid };
  if (expectedProposalDigest !== undefined && !/^[0-9a-f]{64}$/.test(String(expectedProposalDigest))) {
    return { ok: false, error: "expectedProposalDigest must be a lowercase SHA-256 digest" };
  }

  const proposalAbsolute = proposalPathFor(workspaceRoot, proposalId);
  const archivedAbsolute = appliedPathFor(workspaceRoot, proposalId);
  if (!fs.existsSync(proposalAbsolute) && !fs.existsSync(archivedAbsolute)) {
    return { ok: false, error: `proposal not found: ${proposalId}` };
  }
  const proposalLockAbsolute = path.join(workspaceRoot, PROPOSALS_DIRNAME, `${proposalId}.lock`);
  let proposalLock;
  try {
    proposalLock = acquireExclusiveLock(workspaceRoot, proposalLockAbsolute, lockOptions);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  let targetLock;
  function heartbeatLocks() {
    try {
      proposalLock?.heartbeat();
      targetLock?.heartbeat();
      return null;
    } catch (error) {
      return { ok: false, error: `lock ownership lost during apply: ${error.message}` };
    }
  }
  try {
    const initialArchive = loadArchive(workspaceRoot, proposalId);
    if (!initialArchive.ok) return initialArchive;
    if (initialArchive.exists && initialArchive.record.status === "applied") {
      if (expectedProposalDigest !== undefined
          && proposalArtifactDigest(initialArchive.record) !== expectedProposalDigest) {
        return { ok: false, error: "immutable proposal digest conflict" };
      }
      let liveProposal = null;
      if (fs.existsSync(proposalAbsolute)) {
        const loaded = loadProposal(workspaceRoot, proposalId);
        if (!loaded.ok) return loaded;
        liveProposal = loaded;
      }
      const lockFailure = heartbeatLocks();
      if (lockFailure) return lockFailure;
      return recoverAppliedArchive(workspaceRoot, config, proposalId, initialArchive.record, liveProposal);
    }

    const preliminary = loadProposal(workspaceRoot, proposalId);
    if (!preliminary.ok) return preliminary;
    const preliminaryDigest = proposalArtifactDigest(preliminary.record);
    const { targetPath } = preliminary.record;
    if (typeof targetPath !== "string" || targetPath.trim() === "") return { ok: false, error: "proposal missing targetPath" };
    const targetLockId = crypto.createHash("sha256").update(toPosixPath(targetPath)).digest("hex");
    const targetLockAbsolute = path.join(workspaceRoot, PROPOSALS_DIRNAME, `target-${targetLockId}.lock`);
    try {
      targetLock = acquireExclusiveLock(workspaceRoot, targetLockAbsolute, lockOptions);
    } catch (error) {
      return { ok: false, error: `target is already being modified: ${error.message}` };
    }

    if (typeof runtimeOptions.onTargetLockAcquired === "function") {
      runtimeOptions.onTargetLockAcquired({ proposalId, proposalAbsolute, targetPath });
    }
    const locked = loadProposal(workspaceRoot, proposalId);
    if (!locked.ok) return locked;
    const lockedDigest = proposalArtifactDigest(locked.record);
    if (lockedDigest !== preliminaryDigest) {
      return { ok: false, error: "proposal changed while acquiring the target lock" };
    }
    if (expectedProposalDigest !== undefined && lockedDigest !== expectedProposalDigest) {
      return { ok: false, error: "immutable proposal digest conflict" };
    }
    const { record } = locked;
    const { diff } = record;
    if (!diff || typeof diff !== "object") return { ok: false, error: "proposal missing diff" };

    const pathCheck = validatePathSafety(workspaceRoot, targetPath, config);
    if (!pathCheck.ok) return { ok: false, error: pathCheck.error };
    if (!/^[0-9a-f]{64}$/i.test(String(record.proposedContentSha256 ?? ""))) {
      return { ok: false, error: "proposal requires proposedContentSha256" };
    }
    const targetAbsolute = pathCheck.absolute;
    const targetExists = fs.existsSync(targetAbsolute);
    let currentContent = "";
    if (targetExists) {
      try {
        currentContent = readFileNoFollowSync(workspaceRoot, targetAbsolute);
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    const alreadyPersisted = targetExists && recordSha256(currentContent) === record.proposedContentSha256;
    if (diff.kind === "create" && targetExists && !alreadyPersisted) return { ok: false, error: `create target already exists: ${targetPath}` };
    if (diff.kind !== "create" && !targetExists) return { ok: false, error: `target file does not exist: ${targetPath}` };

    let proposedContent;
    let recordValidation;
    if (alreadyPersisted) {
      proposedContent = currentContent;
      recordValidation = validateAmfRecordTarget(targetPath, proposedContent, {
        allowExistingRevision: true,
        workspaceRoot
      });
      if (!recordValidation.ok) return recordValidation;
    } else {
      if (isAmfRecordPath(targetPath) && targetExists
          && (!Number.isInteger(record.expectedRevision) || !/^[0-9a-f]{64}$/i.test(String(record.expectedTargetSha256 ?? "")))) {
        return { ok: false, error: "AMF revision proposal requires expectedRevision and expectedTargetSha256" };
      }
      if (targetExists && record.expectedTargetSha256 !== null && record.expectedTargetSha256 !== undefined
          && recordSha256(currentContent) !== record.expectedTargetSha256) {
        return { ok: false, error: "target content does not match proposal base SHA-256 (drifted)" };
      }
      const rendered = renderProposedContent(targetPath, diff, currentContent);
      if (!rendered.ok) return { ok: false, error: rendered.error };
      proposedContent = rendered.content;
      if (recordSha256(proposedContent) !== record.proposedContentSha256) {
        return { ok: false, error: "proposed content SHA-256 does not match proposal artifact" };
      }
      const graphValidation = validateGraphJsonl(workspaceRoot, targetPath, proposedContent);
      if (!graphValidation.ok) return { ok: false, error: graphValidation.error };
      recordValidation = validateAmfRecordTarget(targetPath, proposedContent, targetExists
        ? {
            currentContent,
            expectedRevision: record.expectedRevision,
            expectedTargetSha256: record.expectedTargetSha256,
            workspaceRoot
          }
        : { workspaceRoot });
      if (!recordValidation.ok) return recordValidation;
    }

    const initialReservationMatches = initialArchive.exists && reservationMatches(initialArchive.record, record);
    const reservationId = initialReservationMatches ? initialArchive.record.reservationId : crypto.randomUUID();
    if (initialArchive.exists && !initialReservationMatches) {
      return { ok: false, error: "applied archive path is reserved by a different or malformed operation" };
    }
    if (!initialArchive.exists) {
      const lockFailure = heartbeatLocks();
      if (lockFailure) return lockFailure;
      const reservation = {
        ...record,
        proposalId,
        status: "applying",
        reservationId,
        reservedAt: new Date().toISOString()
      };
      try {
        atomicWriteFileSync(workspaceRoot, archivedAbsolute, `${JSON.stringify(reservation, null, 2)}\n`, {
          exclusive: true,
          mode: 0o600
        });
      } catch (error) {
        return { ok: false, error: `could not reserve applied archive: ${error.message}` };
      }
    }

    if (!alreadyPersisted) {
      const lockFailure = heartbeatLocks();
      if (lockFailure) return lockFailure;
      try {
        atomicWriteFileSync(workspaceRoot, targetAbsolute, proposedContent, {
          exclusive: diff.kind === "create",
          mode: isAmfRecordPath(targetPath) ? 0o600 : undefined
        });
      } catch (error) {
        return { ok: false, error: `could not persist target atomically: ${error.message}` };
      }
    }

    const reservationAfterTarget = loadArchive(workspaceRoot, proposalId);
    if (!reservationAfterTarget.ok) return reservationAfterTarget;
    if (!reservationAfterTarget.exists
        || !reservationMatches(reservationAfterTarget.record, record)
        || reservationAfterTarget.record.reservationId !== reservationId) {
      return { ok: false, error: "target persisted but applied archive reservation changed; retry requires operator review", targetPersisted: true };
    }

    const appliedAt = new Date().toISOString();
    const validationSummary = summarizeAmfValidation(recordValidation.validation);
    const archivedRecord = {
      ...record,
      proposalId,
      appliedAt,
      status: "applied",
      reservationId,
      persistedContentSha256: recordSha256(proposedContent),
      validation: validationSummary
    };
    const lockFailure = heartbeatLocks();
    if (lockFailure) return { ...lockFailure, targetPersisted: true };
    try {
      atomicWriteFileSync(workspaceRoot, archivedAbsolute, `${JSON.stringify(archivedRecord, null, 2)}\n`, { mode: 0o600 });
      removeRegularFileNoFollowSync(workspaceRoot, proposalAbsolute);
    } catch (error) {
      return {
        ok: false,
        error: `target persisted with recoverable archive reservation: ${error.message}`,
        targetPersisted: true
      };
    }
    return resultFromArchive(workspaceRoot, archivedRecord);
  } finally {
    try {
      targetLock?.release();
    } catch {}
    try {
      proposalLock.release();
    } catch {}
  }
}

export { applyProposal, proposalArtifactDigest };
