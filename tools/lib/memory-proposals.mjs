import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { validateGraph } from "../memory-graph.mjs";
import {
  isAmfRecordPath,
  recordPathFor,
  recordSha256,
  validateMemoryRecord,
  validateMemoryRecordTransition
} from "./amf-memory-record.mjs";
import {
  assertNoSymlinkPath,
  atomicWriteFileSync,
  readFileNoFollowSync
} from "./secure-fs.mjs";
import {
  isPathProtected,
  resolveInsideWorkspace,
  toPosixPath,
  workspaceRelative
} from "./workspace.mjs";

const MAX_DIFF_BYTES = 64 * 1024;
const PROPOSALS_DIRNAME = path.join("memory", "maintenance", "proposals");

function makeProposalId(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  return `proposal-${stamp}-${rand}`;
}

function safeReadFile(absolute) {
  try {
    return fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}

function validatePathSafety(workspaceRoot, relativePath, config) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    return { ok: false, error: "path is required" };
  }
  let absolute;
  try {
    absolute = resolveInsideWorkspace(workspaceRoot, relativePath);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  try {
    assertNoSymlinkPath(workspaceRoot, absolute);
    if (fs.existsSync(absolute) && !fs.lstatSync(absolute).isFile()) {
      return { ok: false, error: "target path is not a file" };
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const protectedPaths = Array.isArray(config?.protectedPaths) ? config.protectedPaths : [];
  if (isPathProtected(workspaceRoot, relativePath, protectedPaths)) {
    return { ok: false, error: `target path is protected: ${relativePath}` };
  }
  return { ok: true, absolute };
}

function diffByteSize(diff) {
  return Buffer.byteLength(JSON.stringify(diff), "utf8");
}

function applyReplace(currentContent, op) {
  const before = String(op.before ?? "");
  const after = String(op.after ?? "");
  if (op.anchor && typeof op.anchor.headerLine === "string") {
    const idx = currentContent.indexOf(op.anchor.headerLine);
    if (idx === -1) {
      return { ok: false, error: `anchor headerLine not found: ${op.anchor.headerLine}` };
    }
    const segmentStart = idx;
    const segmentEnd = idx + before.length;
    if (currentContent.slice(segmentStart, segmentEnd) !== before) {
      return { ok: false, error: "before content does not match at anchor" };
    }
    const next = currentContent.slice(0, segmentStart) + after + currentContent.slice(segmentEnd);
    return { ok: true, next };
  }
  if (op.anchor && Array.isArray(op.anchor.lineRange) && op.anchor.lineRange.length === 2) {
    const [startLine, endLine] = op.anchor.lineRange;
    const lines = currentContent.split(/\r?\n/);
    if (startLine < 1 || endLine < startLine || endLine > lines.length) {
      return { ok: false, error: "lineRange out of bounds" };
    }
    const sliced = lines.slice(startLine - 1, endLine).join("\n");
    if (sliced !== before) {
      return { ok: false, error: "before content does not match at lineRange" };
    }
    const replacedLines = [
      ...lines.slice(0, startLine - 1),
      ...after.split(/\r?\n/),
      ...lines.slice(endLine)
    ];
    return { ok: true, next: replacedLines.join("\n") };
  }
  if (before === "") {
    return { ok: false, error: "replace op requires either headerLine or lineRange anchor" };
  }
  const occurrences = currentContent.split(before).length - 1;
  if (occurrences === 0) {
    return { ok: false, error: "before content not found" };
  }
  if (occurrences > 1) {
    return { ok: false, error: "before content is not unique (specify anchor)" };
  }
  return { ok: true, next: currentContent.replace(before, after) };
}

function parseUnifiedDiff(patch) {
  const lines = patch.split(/\r?\n/);
  let i = 0;
  let targetPath = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("+++ ")) {
      const stripped = line.slice(4).trim();
      if (stripped === "" || stripped === "/dev/null") {
        targetPath = null;
      } else {
        targetPath = stripped.startsWith("b/") ? stripped.slice(2) : stripped;
      }
    } else if (line.startsWith("--- ")) {
      const stripped = line.slice(4).trim();
      if (stripped !== "" && stripped !== "/dev/null") {
        const candidate = stripped.startsWith("a/") ? stripped.slice(2) : stripped;
        if (!targetPath) targetPath = candidate;
      }
    } else if (line.startsWith("@@")) {
      break;
    }
    i += 1;
  }
  const hunks = [];
  let current = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const hunkHeader = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkHeader) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(hunkHeader[1]),
        oldLines: hunkHeader[2] ? Number(hunkHeader[2]) : 1,
        newStart: Number(hunkHeader[3]),
        newLines: hunkHeader[4] ? Number(hunkHeader[4]) : 1,
        ops: []
      };
    } else if (current) {
      if (line.startsWith("+")) {
        current.ops.push({ kind: "add", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        current.ops.push({ kind: "remove", text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        current.ops.push({ kind: "context", text: line.slice(1) });
      } else if (line === "" || line.startsWith("\\")) {
        // ignore blank trailing lines and "\ No newline at end of file"
      } else {
        return { ok: false, error: `unexpected diff line: ${line}` };
      }
    }
  }
  if (current) hunks.push(current);
  if (!targetPath) return { ok: false, error: "diff missing target path" };
  if (hunks.length === 0) return { ok: false, error: "diff missing hunks" };
  return { ok: true, targetPath, hunks };
}

function applyUnifiedHunk(lines, hunk) {
  const startIndex = hunk.oldStart - 1;
  const expectedOld = hunk.ops.filter((op) => op.kind !== "add").map((op) => op.text);
  const actualOld = lines.slice(startIndex, startIndex + expectedOld.length);
  for (let k = 0; k < expectedOld.length; k += 1) {
    if (actualOld[k] !== expectedOld[k]) {
      return { ok: false, error: `hunk mismatch at line ${startIndex + k + 1}` };
    }
  }
  const newSegment = hunk.ops.filter((op) => op.kind !== "remove").map((op) => op.text);
  const nextLines = [
    ...lines.slice(0, startIndex),
    ...newSegment,
    ...lines.slice(startIndex + expectedOld.length)
  ];
  return { ok: true, lines: nextLines };
}

function applyUnifiedDiff(currentContent, parsed) {
  let lines = currentContent.split(/\r?\n/);
  const trailingNewline = currentContent.endsWith("\n");
  if (trailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines = lines.slice(0, -1);
  }
  const sortedHunks = [...parsed.hunks].sort((a, b) => b.oldStart - a.oldStart);
  for (const hunk of sortedHunks) {
    const applied = applyUnifiedHunk(lines, hunk);
    if (!applied.ok) return applied;
    lines = applied.lines;
  }
  const result = lines.join("\n") + (trailingNewline ? "\n" : "");
  return { ok: true, next: result };
}

function validateGraphJsonl(workspaceRoot, targetRelative, proposedContent) {
  const graphFiles = {
    "memory/graph/nodes.jsonl": "nodes",
    "memory/graph/edges.jsonl": "edges",
    "memory/graph/aliases.jsonl": "aliases"
  };
  const posix = toPosixPath(targetRelative);
  const key = graphFiles[posix];
  if (!key) return { ok: true };
  const graph = { nodes: [], edges: [], aliases: [] };
  for (const [graphPath, graphKey] of Object.entries(graphFiles)) {
    if (graphPath === posix) {
      graph[graphKey] = parseJsonlText(proposedContent, graphPath);
      if (!graph[graphKey].ok) return { ok: false, error: graph[graphKey].error };
      graph[graphKey] = graph[graphKey].rows;
    } else {
      const absolute = path.join(workspaceRoot, graphPath);
      const content = safeReadFile(absolute);
      if (content === null) return { ok: false, error: `missing companion graph file: ${graphPath}` };
      const parsed = parseJsonlText(content, graphPath);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      graph[graphKey] = parsed.rows;
    }
  }
  const result = validateGraph(graph);
  if (!result.ok) {
    return { ok: false, error: `proposed graph fails validation: ${result.errors.join("; ")}` };
  }
  return { ok: true };
}

function validateAmfRecordTarget(targetRelative, proposedContent, options = {}) {
  if (!isAmfRecordPath(targetRelative)) return { ok: true, validation: null };
  const validation = validateMemoryRecord(proposedContent, {
    expectedPath: toPosixPath(targetRelative),
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {})
  });
  if (!validation.ok) {
    return { ok: false, error: `proposed AMF record fails validation: ${validation.errors.join("; ")}`, validation };
  }
  if (options.currentContent !== undefined) {
    const transition = validateMemoryRecordTransition(options.currentContent, proposedContent, {
      expectedPath: toPosixPath(targetRelative),
      workspaceRoot: options.workspaceRoot,
      expectedRevision: options.expectedRevision,
      expectedTargetSha256: options.expectedTargetSha256
    });
    if (!transition.ok) {
      return {
        ok: false,
        error: `proposed AMF revision fails transition validation: ${transition.errors.join("; ")}`,
        validation,
        transition
      };
    }
    return { ok: true, validation, transition };
  }
  if (!options.allowExistingRevision && validation.metadata.revision !== 1) {
    return { ok: false, error: "new AMF records must start at revision 1", validation };
  }
  return { ok: true, validation };
}

function summarizeAmfValidation(validation) {
  if (!validation) return null;
  const warnings = Array.isArray(validation.warnings) ? [...validation.warnings] : [];
  const graphProjectionStale = warnings.some((warning) => /derived graph projection is stale/i.test(String(warning)));
  return {
    schema: validation.metadata.schema,
    projection: validation.projection,
    warnings,
    graphProjectionStale,
    regenerateAfterApply: graphProjectionStale,
    followup: graphProjectionStale
      ? { action: "graph_reindex", command: "npm run memory:graph:index", required: true }
      : null
  };
}

function parseJsonlText(text, label) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      return { ok: false, error: `invalid JSONL in ${label}:${i + 1}: ${error.message}` };
    }
  }
  return { ok: true, rows };
}

function proposeEdit(workspaceRoot, config, input) {
  const { path: relativePath, diff, rationale, findingIds } = input ?? {};
  if (typeof rationale !== "string" || rationale.trim() === "") {
    return { ok: false, error: "rationale is required" };
  }
  if (!diff || typeof diff !== "object") {
    return { ok: false, error: "diff is required" };
  }
  if (diffByteSize(diff) > MAX_DIFF_BYTES) {
    return { ok: false, error: `diff exceeds ${MAX_DIFF_BYTES} bytes` };
  }

  const pathCheck = validatePathSafety(workspaceRoot, relativePath, config);
  if (!pathCheck.ok) return { ok: false, error: pathCheck.error };

  let currentContent = "";
  if (fs.existsSync(pathCheck.absolute)) {
    try {
      currentContent = readFileNoFollowSync(workspaceRoot, pathCheck.absolute);
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  let proposedContent;
  if (diff.kind === "create") {
    if (!isAmfRecordPath(relativePath)) {
      return { ok: false, error: "create proposals are restricted to memory/amf/records/<id>.md" };
    }
    if (fs.existsSync(pathCheck.absolute)) {
      return { ok: false, error: `create target already exists: ${toPosixPath(relativePath)}` };
    }
    if (typeof diff.content !== "string" || diff.content.trim() === "") {
      return { ok: false, error: "create proposal requires content" };
    }
    proposedContent = diff.content;
  } else if (diff.kind === "replace") {
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
    if (parsedTargetPosix !== toPosixPath(relativePath)) {
      return { ok: false, error: `diff targets a different path: ${parsed.targetPath}` };
    }
    const applied = applyUnifiedDiff(currentContent, parsed);
    if (!applied.ok) return { ok: false, error: applied.error };
    proposedContent = applied.next;
  } else {
    return { ok: false, error: `unsupported diff kind: ${diff.kind}` };
  }

  const graphValidation = validateGraphJsonl(workspaceRoot, relativePath, proposedContent);
  if (!graphValidation.ok) return { ok: false, error: graphValidation.error };
  const recordValidation = validateAmfRecordTarget(relativePath, proposedContent, fs.existsSync(pathCheck.absolute)
    ? { currentContent, workspaceRoot }
    : { workspaceRoot });
  if (!recordValidation.ok) return recordValidation;

  const proposalsDir = path.join(workspaceRoot, PROPOSALS_DIRNAME);
  const proposalId = makeProposalId();
  const proposalRelative = toPosixPath(path.join(PROPOSALS_DIRNAME, `${proposalId}.json`));
  const proposalAbsolute = path.join(workspaceRoot, proposalRelative);
  const amfMemory = summarizeAmfValidation(recordValidation.validation);
  const record = {
    proposalId,
    createdAt: new Date().toISOString(),
    source: input.source ?? "pam-curator",
    targetPath: toPosixPath(relativePath),
    diff,
    rationale,
    findingIds: Array.isArray(findingIds) ? findingIds : [],
    expectedRevision: recordValidation.transition?.current.metadata.revision ?? null,
    expectedTargetSha256: fs.existsSync(pathCheck.absolute) ? recordSha256(currentContent) : null,
    proposedContentSha256: recordSha256(proposedContent),
    validation: {
      ok: true,
      amfMemory,
      warnings: amfMemory?.warnings ?? [],
      graphProjectionStale: amfMemory?.graphProjectionStale ?? false,
      regenerateAfterApply: amfMemory?.regenerateAfterApply ?? false,
      followup: amfMemory?.followup ?? null
    },
    proposedContentLength: proposedContent.length
  };
  try {
    atomicWriteFileSync(workspaceRoot, proposalAbsolute, `${JSON.stringify(record, null, 2)}\n`, {
      exclusive: true,
      mode: 0o600
    });
  } catch (error) {
    return { ok: false, error: `could not record proposal: ${error.message}` };
  }
  return {
    ok: true,
    proposalId,
    proposalPath: workspaceRelative(workspaceRoot, proposalAbsolute),
    status: "recorded",
    validation: record.validation
  };
}

function proposeMemoryRecord(workspaceRoot, config, input) {
  const { content, rationale, findingIds, source } = input ?? {};
  const validation = validateMemoryRecord(content, { workspaceRoot });
  if (!validation.ok) {
    return {
      ok: false,
      error: `AMF record fails validation: ${validation.errors.join("; ")}`,
      validation
    };
  }
  const targetPath = recordPathFor(validation.metadata);
  const result = proposeEdit(workspaceRoot, config, {
    path: targetPath,
    rationale,
    findingIds,
    source: source ?? "pam-memory-record",
    diff: { kind: "create", content }
  });
  if (!result.ok) return result;
  return {
    ...result,
    targetPath,
    projection: validation.projection,
    warnings: result.validation?.warnings ?? [],
    graphProjectionStale: result.validation?.graphProjectionStale ?? false,
    regenerateAfterApply: result.validation?.regenerateAfterApply ?? false,
    followup: result.validation?.followup ?? null
  };
}

export {
  MAX_DIFF_BYTES,
  PROPOSALS_DIRNAME,
  applyReplace,
  applyUnifiedDiff,
  diffByteSize,
  parseUnifiedDiff,
  proposeMemoryRecord,
  proposeEdit,
  summarizeAmfValidation,
  validateAmfRecordTarget,
  validateGraphJsonl,
  validatePathSafety
};
