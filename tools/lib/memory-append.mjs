import fs from "node:fs";
import path from "node:path";

import { isPathProtected, resolveInsideWorkspace, toPosixPath, workspaceRelative } from "./workspace.mjs";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TITLE_RE = /^## \d{4}-\d{2}-\d{2} - .+$/;
const SECTION_HEADER_RE = /^## /m;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function resolveManagedLog(config, log) {
  if (typeof log !== "string" || log.trim() === "") {
    return { ok: false, error: "log is required" };
  }
  const managedLogs = Array.isArray(config?.managedLogs) ? config.managedLogs : [];
  for (const entry of managedLogs) {
    if (entry.archiveKey === log || entry.source === log) {
      return { ok: true, logConfig: entry };
    }
  }
  return { ok: false, error: `log not declared in config.managedLogs: ${log}` };
}

function findInsertOffset(content) {
  const match = content.search(SECTION_HEADER_RE);
  if (match === -1) return content.length;
  return match;
}

function appendEntry(workspaceRoot, config, input) {
  const { log, headerTitle, body, date } = input ?? {};
  if (typeof headerTitle !== "string" || headerTitle.trim() === "") {
    return { ok: false, error: "headerTitle is required" };
  }
  if (typeof body !== "string" || body.trim() === "") {
    return { ok: false, error: "body is required" };
  }
  const entryDate = typeof date === "string" && date.trim() !== "" ? date.trim() : todayUtc();
  if (!ISO_DATE_RE.test(entryDate)) {
    return { ok: false, error: `date must be YYYY-MM-DD: ${entryDate}` };
  }
  const resolved = resolveManagedLog(config, log);
  if (!resolved.ok) return resolved;

  const headerLine = `## ${entryDate} - ${headerTitle.trim()}`;
  if (!ISO_DATE_TITLE_RE.test(headerLine)) {
    return { ok: false, error: `header does not match ## YYYY-MM-DD - <title>: ${headerLine}` };
  }

  let absolute;
  try {
    absolute = resolveInsideWorkspace(workspaceRoot, resolved.logConfig.source);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const protectedPaths = Array.isArray(config?.protectedPaths) ? config.protectedPaths : [];
  if (isPathProtected(workspaceRoot, resolved.logConfig.source, protectedPaths)) {
    return { ok: false, error: `target path is protected: ${toPosixPath(resolved.logConfig.source)}` };
  }
  if (!fs.existsSync(absolute)) {
    return { ok: false, error: `target log does not exist: ${toPosixPath(resolved.logConfig.source)}` };
  }
  const stats = fs.lstatSync(absolute);
  if (stats.isSymbolicLink()) {
    return { ok: false, error: "target log is a symlink" };
  }
  if (!stats.isFile()) {
    return { ok: false, error: "target log is not a file" };
  }

  const original = fs.readFileSync(absolute, "utf8");
  const insertAt = findInsertOffset(original);
  const prefix = original.slice(0, insertAt);
  const suffix = original.slice(insertAt);
  const normalizedPrefix = prefix.endsWith("\n") || prefix === "" ? prefix : `${prefix}\n`;
  const prefixNeedsBlank = normalizedPrefix !== "" && !normalizedPrefix.endsWith("\n\n");
  const leading = prefixNeedsBlank ? `${normalizedPrefix}\n` : normalizedPrefix;
  const bodyTrimmed = body.replace(/\s+$/, "");
  const section = `${headerLine}\n\n${bodyTrimmed}\n\n`;
  const next = `${leading}${section}${suffix}`;

  fs.writeFileSync(absolute, next, "utf8");

  return {
    ok: true,
    path: workspaceRelative(workspaceRoot, absolute),
    anchor: headerLine,
    bytesWritten: Buffer.byteLength(next, "utf8") - Buffer.byteLength(original, "utf8")
  };
}

export {
  ISO_DATE_RE,
  ISO_DATE_TITLE_RE,
  appendEntry
};
