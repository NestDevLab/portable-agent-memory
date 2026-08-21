import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TYPES = new Set(["fact", "decision", "procedure", "troubleshooting", "relationship", "obsolete", "conflict"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const SENSITIVITY = new Set(["none", "unknown", "sensitive"]);
const SENSITIVE_RE = /(secret|cookie|credential|private[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token)/i;

function inside(workspaceRoot, candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") return null;
  const absolute = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return { absolute, relative: relative.split(path.sep).join("/") };
}

function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function allowedTarget(relative, allowedPaths) {
  return allowedPaths.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));
}

function validateCandidate(workspaceRoot, candidate, allowedPaths) {
  const errors = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(candidate?.id ?? ""))) errors.push("invalid candidate id");
  if (!TYPES.has(candidate?.type)) errors.push("invalid candidate type");
  if (typeof candidate?.claim !== "string" || candidate.claim.trim() === "" || candidate.claim.length > 600) errors.push("claim must be 1-600 characters");
  if (SENSITIVE_RE.test(String(candidate?.claim ?? ""))) errors.push("claim contains sensitive-looking content");
  if (!CONFIDENCES.has(candidate?.confidence)) errors.push("invalid confidence");
  if (!SENSITIVITY.has(candidate?.sensitivity)) errors.push("invalid sensitivity");
  if (!Number.isFinite(Date.parse(candidate?.evidenceDate))) errors.push("invalid evidence date");

  const source = inside(workspaceRoot, candidate?.source?.path);
  if (!source || !fs.existsSync(source.absolute)) {
    errors.push("source path is missing, unsafe, or unavailable");
  } else {
    const expectedDigest = String(candidate?.source?.sha256 ?? "");
    if (!/^[0-9a-f]{64}$/i.test(expectedDigest)) errors.push("source digest must be SHA-256");
    else if (sha256(fs.readFileSync(source.absolute, "utf8")) !== expectedDigest) errors.push("source digest changed");
  }

  const target = inside(workspaceRoot, candidate?.targetPath);
  if (!target || !allowedTarget(target.relative, allowedPaths)) errors.push("target path is outside the allowed workspace policy");
  const disposition = errors.length > 0 ? "BLOCKED" : candidate.sensitivity === "sensitive" || candidate.type === "conflict" ? "REVIEW_REQUIRED" : "REVIEW_REQUIRED";
  return { id: candidate?.id ?? null, type: candidate?.type ?? null, disposition, errors };
}

export function validateCaptureProposal(workspaceRoot, proposal, options = {}) {
  const errors = [];
  if (proposal?.schemaVersion !== "pam-capture/v1") errors.push("unsupported proposal schema");
  if (!Array.isArray(proposal?.candidates)) errors.push("proposal requires candidates array");
  const allowedPaths = options.allowedPaths ?? [];
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0 || allowedPaths.some((entry) => !inside(workspaceRoot, entry))) {
    errors.push("explicit allowed workspace paths are required");
  }
  const seen = new Set();
  const candidates = Array.isArray(proposal?.candidates)
    ? proposal.candidates.map((candidate) => {
      const result = validateCandidate(workspaceRoot, candidate, allowedPaths);
      if (seen.has(candidate?.id)) result.errors.push("duplicate candidate id");
      seen.add(candidate?.id);
      return result;
    })
    : [];
  const blockedCount = candidates.filter((candidate) => candidate.disposition === "BLOCKED").length;
  const status = errors.length > 0 || blockedCount > 0
    ? "BLOCKED"
    : candidates.length === 0
      ? "PASS"
      : "REVIEW_REQUIRED";
  return {
    schemaVersion: "pam-capture-plan/v1",
    status,
    candidateCount: candidates.length,
    reviewRequiredCount: candidates.filter((candidate) => candidate.disposition === "REVIEW_REQUIRED").length,
    blockedCount,
    errors,
    candidates
  };
}

export function readProposal(workspaceRoot, proposalPath) {
  const resolved = inside(workspaceRoot, proposalPath);
  if (!resolved) throw new Error("proposal path must stay inside workspace");
  return JSON.parse(fs.readFileSync(resolved.absolute, "utf8"));
}
