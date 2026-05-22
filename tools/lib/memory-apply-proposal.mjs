import fs from "node:fs";
import path from "node:path";

import {
  PROPOSALS_DIRNAME,
  applyReplace,
  applyUnifiedDiff,
  parseUnifiedDiff,
  validateGraphJsonl,
  validatePathSafety
} from "./memory-proposals.mjs";
import { toPosixPath, workspaceRelative } from "./workspace.mjs";

function proposalPathFor(workspaceRoot, proposalId) {
  return path.join(workspaceRoot, PROPOSALS_DIRNAME, `${proposalId}.json`);
}

function appliedPathFor(workspaceRoot, proposalId) {
  return path.join(workspaceRoot, PROPOSALS_DIRNAME, `${proposalId}.applied.json`);
}

function loadProposal(workspaceRoot, proposalId) {
  if (typeof proposalId !== "string" || proposalId.trim() === "") {
    return { ok: false, error: "proposalId is required" };
  }
  if (proposalId.includes("/") || proposalId.includes("\\") || proposalId.includes("..")) {
    return { ok: false, error: "proposalId must not contain path separators" };
  }
  const absolute = proposalPathFor(workspaceRoot, proposalId);
  if (!fs.existsSync(absolute)) {
    return { ok: false, error: `proposal not found: ${proposalId}` };
  }
  try {
    return { ok: true, record: JSON.parse(fs.readFileSync(absolute, "utf8")), absolute };
  } catch (error) {
    return { ok: false, error: `proposal is not valid JSON: ${error.message}` };
  }
}

function applyProposal(workspaceRoot, config, input) {
  const { proposalId } = input ?? {};
  const loaded = loadProposal(workspaceRoot, proposalId);
  if (!loaded.ok) return loaded;
  const { record, absolute: proposalAbsolute } = loaded;

  const { targetPath, diff } = record;
  if (typeof targetPath !== "string" || targetPath.trim() === "") {
    return { ok: false, error: "proposal missing targetPath" };
  }
  if (!diff || typeof diff !== "object") {
    return { ok: false, error: "proposal missing diff" };
  }

  const pathCheck = validatePathSafety(workspaceRoot, targetPath, config);
  if (!pathCheck.ok) return { ok: false, error: pathCheck.error };

  const targetAbsolute = pathCheck.absolute;
  if (!fs.existsSync(targetAbsolute)) {
    return { ok: false, error: `target file does not exist: ${targetPath}` };
  }
  const currentContent = fs.readFileSync(targetAbsolute, "utf8");

  let proposedContent;
  if (diff.kind === "replace") {
    const applied = applyReplace(currentContent, diff);
    if (!applied.ok) return { ok: false, error: applied.error };
    proposedContent = applied.next;
  } else if (diff.kind === "unified-diff") {
    if (typeof diff.patch !== "string" || diff.patch.trim() === "") {
      return { ok: false, error: "unified-diff requires a patch string" };
    }
    const parsed = parseUnifiedDiff(diff.patch);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const parsedTargetPosix = toPosixPath(parsed.targetPath);
    if (parsedTargetPosix !== toPosixPath(targetPath)) {
      return { ok: false, error: `diff target mismatch: ${parsed.targetPath} vs ${targetPath}` };
    }
    const applied = applyUnifiedDiff(currentContent, parsed);
    if (!applied.ok) return { ok: false, error: applied.error };
    proposedContent = applied.next;
  } else {
    return { ok: false, error: `unsupported diff kind: ${diff.kind}` };
  }

  const graphValidation = validateGraphJsonl(workspaceRoot, targetPath, proposedContent);
  if (!graphValidation.ok) return { ok: false, error: graphValidation.error };

  const appliedAt = new Date().toISOString();
  const archivedAbsolute = appliedPathFor(workspaceRoot, proposalId);
  const archivedRecord = { ...record, proposalId, appliedAt, status: "applied" };
  fs.writeFileSync(archivedAbsolute, `${JSON.stringify(archivedRecord, null, 2)}\n`, "utf8");
  fs.writeFileSync(targetAbsolute, proposedContent, "utf8");
  fs.rmSync(proposalAbsolute);

  return {
    ok: true,
    status: "applied",
    target: toPosixPath(targetPath),
    proposalArchivedAs: workspaceRelative(workspaceRoot, archivedAbsolute),
    appliedAt
  };
}

export { applyProposal };
