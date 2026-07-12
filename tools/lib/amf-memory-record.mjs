import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { loadGraph, validateGraph } from "../memory-graph.mjs";
import { readFileNoFollowSync } from "./secure-fs.mjs";
import { toPosixPath } from "./workspace.mjs";

const SCHEMA = "amf-memory/v1";
const RECORD_FIELDS = new Set([
  "schema",
  "id",
  "revision",
  "claimType",
  "scope",
  "visibility",
  "confidence",
  "subjects",
  "claim",
  "lifecycle",
  "provenance",
  "createdAt",
  "updatedAt"
]);
const REQUIRED_FIELDS = [...RECORD_FIELDS];
const RESERVED_CLAIM_TYPES = new Set([
  "fact",
  "preference",
  "event",
  "decision",
  "instruction",
  "summary",
  "relationship"
]);
const SCOPE_TYPES = new Set(["agent", "person", "relationship", "room", "domain", "shared"]);
const VISIBILITIES = new Set(["private", "restricted", "shared", "confidential"]);
const CONFIDENCE_BASES = new Set(["observed", "asserted", "inferred", "reviewed"]);
const SUBJECT_ROLES = new Set(["subject", "object", "participant", "owner"]);
const LIFECYCLE_STATUSES = new Set(["active", "superseded", "revoked", "expired"]);
const MEMORY_ID_RE = /^mem_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const OPAQUE_REF_RE = /^(?:agent|person|relationship|room|domain):[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const HASH_RE = /^[0-9a-f]{64}$/i;
const RFC3339_UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const NAMESPACED_TYPE_RE = /^[a-z][a-z0-9_-]{0,31}:[a-z][a-z0-9._-]{0,63}$/;
const CLAIM_FIELDS = {
  plain: new Set(["encoding", "text"]),
  sealed: new Set(["encoding", "alg", "kekId", "keyRef", "iv", "ciphertext", "tag", "aadSha256"])
};
const LIFECYCLE_FIELDS = new Set([
  "status",
  "validFrom",
  "validTo",
  "supersedes",
  "revokedAt",
  "revocationReason"
]);
const PROVENANCE_FIELDS = new Set([
  "sourceType",
  "sourceId",
  "eventId",
  "contentSha256",
  "capturedAt"
]);
const SUBJECT_FIELDS = new Set(["identityId", "role"]);
const CONFIDENCE_FIELDS = new Set(["score", "basis", "assessedAt"]);

function parseScalar(raw, lineNumber, errors) {
  const value = raw.trim();
  if (value === "") return "";
  if (["null", "true", "false"].includes(value)
      || value.startsWith("[")
      || value.startsWith("{")
      || value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch (error) {
      errors.push(`frontmatter line ${lineNumber} has invalid JSON value: ${error.message}`);
      return null;
    }
  }
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseMemoryRecord(content) {
  const errors = [];
  if (typeof content !== "string" || !content.startsWith("---\n")) {
    return { ok: false, errors: ["record must start with a YAML frontmatter delimiter"], metadata: {}, body: "" };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return { ok: false, errors: ["record frontmatter is not terminated"], metadata: {}, body: "" };
  }
  const metadata = {};
  const lines = content.slice(4, end).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) {
      errors.push(`frontmatter line ${index + 2} must use top-level key: value syntax`);
      continue;
    }
    const [, key, raw] = match;
    if (Object.hasOwn(metadata, key)) {
      errors.push(`duplicate frontmatter key: ${key}`);
      continue;
    }
    metadata[key] = parseScalar(raw, index + 2, errors);
  }
  return { ok: errors.length === 0, errors, metadata, body: content.slice(end + 5) };
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function recordSha256(content) {
  return sha256(String(content));
}

function isRfc3339Utc(value) {
  if (typeof value !== "string") return false;
  const match = RFC3339_UTC_RE.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    && date.getUTCHours() === Number(hour)
    && date.getUTCMinutes() === Number(minute)
    && date.getUTCSeconds() === Number(second);
}

function validateExactObject(value, label, allowed, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} contains unknown field: ${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) errors.push(`${label} is missing field: ${key}`);
  }
  return true;
}

function decodeBase64(value, label, errors) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 === 1
      || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    errors.push(`${label} must be non-empty base64`);
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 0 || decoded.toString("base64url") !== value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")) {
      errors.push(`${label} must be canonical base64 or base64url`);
      return null;
    }
    return decoded;
  } catch {
    errors.push(`${label} must be valid base64`);
    return null;
  }
}

function aadObjectFor(metadata) {
  const aad = {
    schema: metadata.schema,
    id: metadata.id,
    revision: metadata.revision,
    claimType: metadata.claimType,
    scope: metadata.scope,
    visibility: metadata.visibility,
    confidence: metadata.confidence,
    subjects: metadata.subjects
  };
  if (metadata.claim?.encoding === "sealed") {
    aad.envelope = {
      alg: metadata.claim.alg,
      kekId: metadata.claim.kekId,
      keyRef: metadata.claim.keyRef
    };
  }
  return aad;
}

function aadSha256For(metadata) {
  return sha256(canonicalize(aadObjectFor(metadata)));
}

function isScopeId(type, id) {
  if (type === "shared") return id === "shared:global";
  return typeof id === "string" && id.startsWith(`${type}:`) && OPAQUE_REF_RE.test(id);
}

function isIdentityRef(value) {
  return typeof value === "string" && /^(?:agent|person|relationship):/.test(value) && OPAQUE_REF_RE.test(value);
}

function validateSubjects(subjects, errors) {
  if (!Array.isArray(subjects) || subjects.length === 0) {
    errors.push("subjects must be a non-empty array");
    return;
  }
  const seen = new Set();
  for (let index = 0; index < subjects.length; index += 1) {
    const subject = subjects[index];
    const label = `subjects[${index}]`;
    if (!validateExactObject(subject, label, SUBJECT_FIELDS, errors)) continue;
    if (!isIdentityRef(subject.identityId)) errors.push(`${label}.identityId must be an opaque canonical identity`);
    if (!SUBJECT_ROLES.has(subject.role)) errors.push(`${label}.role is invalid`);
    const key = `${subject.identityId}\0${subject.role}`;
    if (seen.has(key)) errors.push("subjects must not contain duplicates");
    seen.add(key);
  }
}

function validateProvenance(metadata, errors) {
  const provenance = metadata.provenance;
  if (!Array.isArray(provenance) || provenance.length === 0) {
    errors.push("provenance must be a non-empty array");
    return;
  }
  const seenEvents = new Set();
  let previousCapturedAt = -Infinity;
  for (let index = 0; index < provenance.length; index += 1) {
    const item = provenance[index];
    const label = `provenance[${index}]`;
    if (!validateExactObject(item, label, PROVENANCE_FIELDS, errors)) continue;
    if (typeof item.sourceType !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/.test(item.sourceType)) {
      errors.push(`${label}.sourceType is invalid`);
    }
    if (typeof item.sourceId !== "string" || item.sourceId.length < 1 || item.sourceId.length > 256) {
      errors.push(`${label}.sourceId must be a stable pointer of at most 256 characters`);
    }
    if (typeof item.eventId !== "string" || item.eventId.length < 8 || item.eventId.length > 256) {
      errors.push(`${label}.eventId must be a stable idempotency key`);
    } else if (seenEvents.has(item.eventId)) {
      errors.push("provenance eventId values must be unique");
    }
    seenEvents.add(item.eventId);
    if (!HASH_RE.test(String(item.contentSha256 ?? ""))) errors.push(`${label}.contentSha256 must be a SHA-256 digest`);
    if (!isRfc3339Utc(item.capturedAt)) {
      errors.push(`${label}.capturedAt must be RFC 3339 UTC`);
    } else {
      const capturedAt = Date.parse(item.capturedAt);
      if (capturedAt < previousCapturedAt) errors.push("provenance must be ordered by capturedAt ascending");
      if (isRfc3339Utc(metadata.updatedAt) && capturedAt > Date.parse(metadata.updatedAt)) {
        errors.push(`${label}.capturedAt must not be later than updatedAt`);
      }
      previousCapturedAt = capturedAt;
    }
  }
}

function validateLifecycle(metadata, errors) {
  const lifecycle = metadata.lifecycle;
  if (!validateExactObject(lifecycle, "lifecycle", LIFECYCLE_FIELDS, errors)) return;
  if (!LIFECYCLE_STATUSES.has(lifecycle.status)) errors.push("lifecycle.status is invalid");
  for (const key of ["validFrom", "validTo", "revokedAt"]) {
    if (lifecycle[key] !== null && !isRfc3339Utc(lifecycle[key])) errors.push(`lifecycle.${key} must be null or RFC 3339 UTC`);
  }
  if (!Array.isArray(lifecycle.supersedes)) {
    errors.push("lifecycle.supersedes must be an array");
  } else {
    if (lifecycle.supersedes.some((id) => !MEMORY_ID_RE.test(String(id)))) errors.push("lifecycle.supersedes contains an invalid memory id");
    if (lifecycle.supersedes.includes(metadata.id)) errors.push("lifecycle.supersedes must not reference the record itself");
    if (new Set(lifecycle.supersedes).size !== lifecycle.supersedes.length) errors.push("lifecycle.supersedes must not contain duplicates");
  }
  if (lifecycle.revocationReason !== null
      && (typeof lifecycle.revocationReason !== "string" || lifecycle.revocationReason.trim() === "" || lifecycle.revocationReason.length > 512)) {
    errors.push("lifecycle.revocationReason must be null or a non-empty string of at most 512 characters");
  }
  if (lifecycle.status === "revoked") {
    if (!isRfc3339Utc(lifecycle.revokedAt)) errors.push("revoked lifecycle requires revokedAt");
    if (typeof lifecycle.revocationReason !== "string" || lifecycle.revocationReason.trim() === "") {
      errors.push("revoked lifecycle requires revocationReason");
    }
  } else if (lifecycle.revokedAt !== null || lifecycle.revocationReason !== null) {
    errors.push("only revoked lifecycle may set revokedAt or revocationReason");
  }
  if (lifecycle.status === "expired" && !isRfc3339Utc(lifecycle.validTo)) {
    errors.push("expired lifecycle requires validTo");
  }
  if (isRfc3339Utc(lifecycle.validFrom) && isRfc3339Utc(lifecycle.validTo)
      && Date.parse(lifecycle.validTo) < Date.parse(lifecycle.validFrom)) {
    errors.push("lifecycle.validTo must not be earlier than validFrom");
  }
  if (lifecycle.status === "expired" && isRfc3339Utc(lifecycle.validTo) && isRfc3339Utc(metadata.updatedAt)
      && Date.parse(lifecycle.validTo) > Date.parse(metadata.updatedAt)) {
    errors.push("expired lifecycle.validTo must not be later than updatedAt");
  }
  if (lifecycle.status === "revoked" && isRfc3339Utc(lifecycle.revokedAt) && isRfc3339Utc(metadata.updatedAt)
      && Date.parse(lifecycle.revokedAt) > Date.parse(metadata.updatedAt)) {
    errors.push("lifecycle.revokedAt must not be later than updatedAt");
  }
}

function validateConfidence(metadata, errors) {
  const confidence = metadata.confidence;
  if (!validateExactObject(confidence, "confidence", CONFIDENCE_FIELDS, errors)) return;
  if (typeof confidence.score !== "number" || !Number.isFinite(confidence.score)
      || confidence.score < 0 || confidence.score > 1) {
    errors.push("confidence.score must be a finite number between 0 and 1");
  }
  if (!CONFIDENCE_BASES.has(confidence.basis)) {
    errors.push("confidence.basis must be observed, asserted, inferred, or reviewed");
  }
  if (!isRfc3339Utc(confidence.assessedAt)) {
    errors.push("confidence.assessedAt must be RFC 3339 UTC");
  } else {
    if (isRfc3339Utc(metadata.createdAt) && Date.parse(confidence.assessedAt) < Date.parse(metadata.createdAt)) {
      errors.push("confidence.assessedAt must not be earlier than createdAt");
    }
    if (isRfc3339Utc(metadata.updatedAt) && Date.parse(confidence.assessedAt) > Date.parse(metadata.updatedAt)) {
      errors.push("confidence.assessedAt must not be later than updatedAt");
    }
  }
}

function validateClaim(metadata, body, errors) {
  const claim = metadata.claim;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    errors.push("claim must be an object");
    return;
  }
  const fields = CLAIM_FIELDS[claim.encoding];
  if (!fields) {
    errors.push("claim.encoding must be plain or sealed");
    return;
  }
  validateExactObject(claim, "claim", fields, errors);
  const subjectRequiresSealing = Array.isArray(metadata.subjects)
    && metadata.subjects.some((subject) => /^(?:person|relationship):/.test(String(subject?.identityId ?? "")));
  const mustBeSealed = ["person", "relationship"].includes(metadata.scope?.type)
    || metadata.claimType === "relationship"
    || ["confidential", "restricted"].includes(metadata.visibility)
    || subjectRequiresSealing;
  if (mustBeSealed && claim.encoding !== "sealed") {
    errors.push("person/relationship scope or subject, relationship claimType, and confidential/restricted visibility require a sealed claim");
  }
  if (claim.encoding === "plain") {
    if (typeof claim.text !== "string" || claim.text.trim() === "") errors.push("plain claim.text must not be empty");
    if (body.includes("```amf-sealed")) errors.push("plain record body must not contain a sealed envelope");
    return;
  }
  if (body.trim() !== "") errors.push("sealed record body must be empty");
  if (claim.alg !== "AES-256-GCM") errors.push("sealed claim.alg must be AES-256-GCM");
  if (typeof claim.kekId !== "string" || !/^kek:[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(claim.kekId)) {
    errors.push("sealed claim.kekId must be an opaque versioned KEK id");
  }
  if (typeof claim.keyRef !== "string" || !/^key:[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(claim.keyRef)) {
    errors.push("sealed claim.keyRef must be an opaque external key reference");
  }
  const iv = decodeBase64(claim.iv, "sealed claim.iv", errors);
  const ciphertext = decodeBase64(claim.ciphertext, "sealed claim.ciphertext", errors);
  const tag = decodeBase64(claim.tag, "sealed claim.tag", errors);
  if (iv && iv.length !== 12) errors.push("sealed claim.iv must decode to 12 bytes");
  if (ciphertext && ciphertext.length === 0) errors.push("sealed claim.ciphertext must not be empty");
  if (tag && tag.length !== 16) errors.push("sealed claim.tag must decode to 16 bytes");
  if (!HASH_RE.test(String(claim.aadSha256 ?? ""))) {
    errors.push("sealed claim.aadSha256 must be a SHA-256 digest");
  } else {
    const expected = aadSha256For(metadata);
    if (claim.aadSha256.toLowerCase() !== expected) errors.push(`sealed claim.aadSha256 must match canonical AAD (${expected})`);
  }
}

function statusForProjection(metadata) {
  return metadata.lifecycle.status === "active" ? "confirmed" : "obsolete";
}

function plainDigest(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/[`*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function recordPathFor(metadata) {
  if (!MEMORY_ID_RE.test(String(metadata?.id ?? ""))) return null;
  return toPosixPath(path.join("memory", "amf", "records", `${metadata.id}.md`));
}

function projectMemoryRecord(metadata, sourcePath = null) {
  const mayProjectClaim = metadata.claim.encoding === "plain"
    && metadata.scope.type === "shared"
    && metadata.visibility === "shared";
  const digest = mayProjectClaim ? plainDigest(metadata.claim.text) : `Protected ${metadata.claimType} memory.`;
  return {
    id: metadata.id,
    k: "memory-record",
    n: mayProjectClaim ? (digest.slice(0, 80) || `${metadata.claimType} memory`) : "Protected memory record",
    d: digest,
    st: statusForProjection(metadata),
    c: metadata.confidence.score >= 0.8 ? "high" : metadata.confidence.score >= 0.5 ? "medium" : "low",
    u: metadata.updatedAt.slice(0, 10),
    src: sourcePath ?? recordPathFor(metadata),
    tags: [SCHEMA, metadata.claimType, metadata.scope.type, metadata.lifecycle.status, metadata.claim.encoding]
  };
}

function validateSupersedesInWorkspace(metadata, options, errors) {
  const supersedes = Array.isArray(metadata.lifecycle?.supersedes) ? metadata.lifecycle.supersedes : [];
  if (supersedes.length === 0 || options.resolveSupersedes === false) return;
  if (!options.workspaceRoot) {
    errors.push("workspaceRoot is required to resolve lifecycle.supersedes targets");
    return;
  }
  for (const memoryId of supersedes) {
    if (!MEMORY_ID_RE.test(String(memoryId))) continue;
    const targetPath = toPosixPath(path.join("memory", "amf", "records", `${memoryId}.md`));
    const absolute = path.join(options.workspaceRoot, targetPath);
    if (!fs.existsSync(absolute)) {
      errors.push(`lifecycle.supersedes target does not exist: ${memoryId}`);
      continue;
    }
    try {
      const targetContent = readFileNoFollowSync(options.workspaceRoot, absolute);
      const target = validateMemoryRecord(targetContent, {
        expectedPath: targetPath,
        workspaceRoot: options.workspaceRoot,
        resolveSupersedes: false,
        checkWorkspaceGraph: false
      });
      if (!target.ok) {
        errors.push(`lifecycle.supersedes target is invalid (${memoryId}): ${target.errors.join("; ")}`);
      } else if (isRfc3339Utc(metadata.updatedAt) && Date.parse(target.metadata.updatedAt) > Date.parse(metadata.updatedAt)) {
        errors.push(`lifecycle.supersedes target is newer than this record: ${memoryId}`);
      }
    } catch (error) {
      errors.push(`could not safely resolve lifecycle.supersedes target ${memoryId}: ${error.message}`);
    }
  }
}

function validateProjectionInWorkspace(projection, options, errors, warnings) {
  if (!options.workspaceRoot || options.checkWorkspaceGraph === false) return;
  try {
    const graph = loadGraph(options.workspaceRoot);
    const baseline = validateGraph(graph);
    if (!baseline.ok) {
      errors.push(`workspace graph is invalid: ${baseline.errors.join("; ")}`);
      return;
    }
    const existing = graph.nodes.find((node) => node.id === projection.id);
    if (existing && existing.k !== "memory-record") {
      errors.push(`graph id collision with non-memory-record node: ${projection.id}`);
      return;
    }
    const candidateNodes = existing
      ? graph.nodes.map((node) => node.id === projection.id ? projection : node)
      : [...graph.nodes, projection];
    const candidate = validateGraph({ ...graph, nodes: candidateNodes });
    if (!candidate.ok) errors.push(`projected workspace graph is invalid: ${candidate.errors.join("; ")}`);
    if (existing && canonicalize(existing) !== canonicalize(projection)) {
      warnings.push(`derived graph projection is stale for ${projection.id}; regenerate it after apply`);
    }
  } catch (error) {
    errors.push(`could not validate projection against workspace graph: ${error.message}`);
  }
}

function validateMemoryRecord(content, options = {}) {
  const parsed = parseMemoryRecord(content);
  const errors = [...parsed.errors];
  const warnings = [];
  const metadata = parsed.metadata;

  for (const key of Object.keys(metadata)) {
    if (!RECORD_FIELDS.has(key)) errors.push(`unknown frontmatter key: ${key}`);
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(metadata, key)) errors.push(`missing frontmatter key: ${key}`);
  }
  if (metadata.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
  if (!MEMORY_ID_RE.test(String(metadata.id ?? ""))) errors.push("id must be an opaque mem_<id>");
  if (!Number.isInteger(metadata.revision) || metadata.revision < 1) errors.push("revision must be a positive integer");
  if (!RESERVED_CLAIM_TYPES.has(metadata.claimType) && !NAMESPACED_TYPE_RE.test(String(metadata.claimType ?? ""))) {
    errors.push("claimType must be a v1 reserved value or a namespaced stable string");
  }
  if (!metadata.scope || typeof metadata.scope !== "object" || Array.isArray(metadata.scope)
      || Object.keys(metadata.scope).sort().join(",") !== "id,type") {
    errors.push("scope must contain exactly type and id");
  } else {
    if (!SCOPE_TYPES.has(metadata.scope.type)) errors.push("scope.type is invalid");
    if (!isScopeId(metadata.scope.type, metadata.scope.id)) errors.push("scope.id must be canonical and match scope.type");
  }
  if (!VISIBILITIES.has(metadata.visibility)) errors.push("visibility is invalid");
  validateConfidence(metadata, errors);
  validateSubjects(metadata.subjects, errors);
  validateClaim(metadata, parsed.body, errors);
  validateLifecycle(metadata, errors);
  validateProvenance(metadata, errors);
  for (const key of ["createdAt", "updatedAt"]) {
    if (!isRfc3339Utc(metadata[key])) errors.push(`${key} must be RFC 3339 UTC`);
  }
  if (isRfc3339Utc(metadata.createdAt) && isRfc3339Utc(metadata.updatedAt)
      && Date.parse(metadata.updatedAt) < Date.parse(metadata.createdAt)) {
    errors.push("updatedAt must not be earlier than createdAt");
  }
  if (metadata.revision === 1 && isRfc3339Utc(metadata.createdAt) && isRfc3339Utc(metadata.updatedAt)
      && metadata.createdAt !== metadata.updatedAt) {
    errors.push("revision 1 must have identical createdAt and updatedAt");
  }
  validateSupersedesInWorkspace(metadata, options, errors);

  const expectedPath = recordPathFor(metadata);
  if (options.expectedPath && expectedPath && toPosixPath(options.expectedPath) !== expectedPath) {
    errors.push(`record path must be ${expectedPath}`);
  }

  let projection = null;
  if (errors.length === 0) {
    projection = projectMemoryRecord(metadata, expectedPath);
    const graphValidation = validateGraph({ nodes: [projection], edges: [], aliases: [] });
    if (!graphValidation.ok) errors.push(`graph projection is invalid: ${graphValidation.errors.join("; ")}`);
    else validateProjectionInWorkspace(projection, options, errors, warnings);
  }
  if (metadata.claim?.encoding === "plain" && !(metadata.scope?.type === "shared" && metadata.visibility === "shared")) {
    warnings.push("non-shared plaintext claim is omitted from the graph projection");
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    metadata,
    body: parsed.body,
    expectedPath,
    projection: errors.length === 0 ? projection : null,
    aadSha256: errors.length === 0 && metadata.claim?.encoding === "sealed" ? aadSha256For(metadata) : null
  };
}

function visibilityCanNarrow(from, to) {
  const allowed = {
    shared: new Set(["shared", "restricted", "confidential", "private"]),
    restricted: new Set(["restricted", "confidential", "private"]),
    confidential: new Set(["confidential", "private"]),
    private: new Set(["private"])
  };
  return allowed[from]?.has(to) ?? false;
}

function validateMemoryRecordTransition(currentContent, proposedContent, options = {}) {
  const validationOptions = {
    ...(options.expectedPath ? { expectedPath: options.expectedPath } : {}),
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {})
  };
  const current = validateMemoryRecord(currentContent, validationOptions);
  const proposed = validateMemoryRecord(proposedContent, validationOptions);
  const errors = [];
  if (!current.ok) errors.push(`current AMF record is invalid: ${current.errors.join("; ")}`);
  if (!proposed.ok) errors.push(`proposed AMF record is invalid: ${proposed.errors.join("; ")}`);
  if (errors.length > 0) return { ok: false, errors, current, proposed };

  const oldRecord = current.metadata;
  const newRecord = proposed.metadata;
  if (newRecord.id !== oldRecord.id) errors.push("record id is immutable");
  if (newRecord.revision !== oldRecord.revision + 1) errors.push(`revision must increment exactly from ${oldRecord.revision} to ${oldRecord.revision + 1}`);
  if (newRecord.createdAt !== oldRecord.createdAt) errors.push("createdAt is immutable");
  if (Date.parse(newRecord.updatedAt) <= Date.parse(oldRecord.updatedAt)) errors.push("updatedAt must increase on every revision");
  for (const key of ["claimType", "scope", "subjects"]) {
    if (canonicalize(newRecord[key]) !== canonicalize(oldRecord[key])) errors.push(`${key} is immutable within a record; create a superseding record to correct the claim`);
  }
  if (oldRecord.claim.encoding === "plain" && canonicalize(newRecord.claim) !== canonicalize(oldRecord.claim)) {
    errors.push("claim is immutable within a record; create a superseding record to correct the claim");
  }
  if (oldRecord.claim.encoding === "sealed") {
    if (newRecord.claim.encoding !== "sealed") errors.push("sealed claim must not be downgraded");
    if (newRecord.claim.iv === oldRecord.claim.iv) errors.push("sealed claim must use a new IV for every revision");
  }
  if (!visibilityCanNarrow(oldRecord.visibility, newRecord.visibility)) errors.push("visibility must not widen across revisions");
  const confidenceChanged = canonicalize(oldRecord.confidence) !== canonicalize(newRecord.confidence);
  if (Date.parse(newRecord.confidence.assessedAt) < Date.parse(oldRecord.confidence.assessedAt)) {
    errors.push("confidence.assessedAt must not move backwards across revisions");
  }
  if (confidenceChanged && Date.parse(newRecord.confidence.assessedAt) <= Date.parse(oldRecord.confidence.assessedAt)) {
    errors.push("a confidence change requires a strictly newer confidence.assessedAt");
  }
  if (newRecord.provenance.length < oldRecord.provenance.length
      || oldRecord.provenance.some((item, index) => canonicalize(item) !== canonicalize(newRecord.provenance[index]))) {
    errors.push("provenance is append-only and existing entries must remain unchanged and ordered");
  }
  const oldSupersedes = oldRecord.lifecycle.supersedes;
  const newSupersedes = newRecord.lifecycle.supersedes;
  if (newSupersedes.length < oldSupersedes.length
      || oldSupersedes.some((id, index) => id !== newSupersedes[index])) {
    errors.push("lifecycle.supersedes is append-only");
  }
  const allowedTransitions = oldRecord.lifecycle.status === "active"
    ? new Set(["active", "superseded", "revoked", "expired"])
    : new Set([oldRecord.lifecycle.status]);
  if (!allowedTransitions.has(newRecord.lifecycle.status)) {
    errors.push(`invalid lifecycle transition ${oldRecord.lifecycle.status} -> ${newRecord.lifecycle.status}`);
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== oldRecord.revision) {
    errors.push(`expectedRevision ${options.expectedRevision} does not match current revision ${oldRecord.revision}`);
  }
  const currentHash = recordSha256(currentContent);
  if (options.expectedTargetSha256 !== undefined && options.expectedTargetSha256 !== currentHash) {
    errors.push("current record SHA-256 does not match proposal base hash");
  }
  return { ok: errors.length === 0, errors, current, proposed, currentHash };
}

function isAmfRecordPath(relativePath) {
  return /^memory\/amf\/records\/mem_[A-Za-z0-9][A-Za-z0-9_-]{7,127}\.md$/.test(toPosixPath(String(relativePath ?? "")));
}

export {
  SCHEMA,
  aadSha256For,
  canonicalize,
  isAmfRecordPath,
  isRfc3339Utc,
  parseMemoryRecord,
  projectMemoryRecord,
  recordPathFor,
  recordSha256,
  validateMemoryRecord,
  validateMemoryRecordTransition
};
