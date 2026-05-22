import fs from "node:fs";
import path from "node:path";

import { resolveInsideMemory, toPosixPath, workspaceRelative } from "./workspace.mjs";

const MAX_READ_BYTES = 1_000_000;
const DEFAULT_LIST_DEPTH = 3;
const DEFAULT_SEARCH_RESULTS = 200;
const MAX_SEARCH_RESULTS = 1000;
const TEXT_FILE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".jsonl", ".yml", ".yaml", ".mjs", ".js", ".ts"
]);

function assertNotSymlink(absolutePath) {
  const stats = fs.lstatSync(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error("symlinks are not allowed");
  }
  return stats;
}

function memoryRead(workspaceRoot, relativePath) {
  const absolute = resolveInsideMemory(workspaceRoot, relativePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`not found: ${relativePath}`);
  }
  const stats = assertNotSymlink(absolute);
  if (!stats.isFile()) {
    throw new Error(`not a file: ${relativePath}`);
  }
  if (stats.size > MAX_READ_BYTES) {
    throw new Error(`file too large (${stats.size} > ${MAX_READ_BYTES}): ${relativePath}`);
  }
  const ext = path.extname(absolute).toLowerCase();
  if (ext !== "" && !TEXT_FILE_EXTENSIONS.has(ext)) {
    throw new Error(`refusing non-text extension: ${ext}`);
  }
  const content = fs.readFileSync(absolute, "utf8");
  return {
    path: workspaceRelative(workspaceRoot, absolute),
    bytes: stats.size,
    mtime: stats.mtime.toISOString(),
    content
  };
}

function memoryList(workspaceRoot, options = {}) {
  const relativeDir = options.dir ?? "memory";
  const depth = Number.isInteger(options.depth) && options.depth > 0
    ? Math.min(options.depth, 6)
    : DEFAULT_LIST_DEPTH;
  const absoluteDir = resolveInsideMemory(workspaceRoot, relativeDir);
  if (!fs.existsSync(absoluteDir)) {
    return { dir: toPosixPath(relativeDir), entries: [] };
  }
  const dirStats = assertNotSymlink(absoluteDir);
  if (!dirStats.isDirectory()) {
    throw new Error(`not a directory: ${relativeDir}`);
  }

  const entries = [];
  function walk(currentDir, currentDepth) {
    let names;
    try {
      names = fs.readdirSync(currentDir);
    } catch {
      return;
    }
    for (const name of names) {
      const childAbsolute = path.join(currentDir, name);
      let childStats;
      try {
        childStats = fs.lstatSync(childAbsolute);
      } catch {
        continue;
      }
      if (childStats.isSymbolicLink()) continue;
      const entry = {
        path: workspaceRelative(workspaceRoot, childAbsolute),
        type: childStats.isDirectory() ? "dir" : "file",
        bytes: childStats.isFile() ? childStats.size : null,
        mtime: childStats.mtime.toISOString()
      };
      entries.push(entry);
      if (childStats.isDirectory() && currentDepth + 1 < depth) {
        walk(childAbsolute, currentDepth + 1);
      }
    }
  }
  walk(absoluteDir, 0);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { dir: workspaceRelative(workspaceRoot, absoluteDir), entries };
}

function compileMatcher(query, regex) {
  if (regex) {
    return new RegExp(query, "i");
  }
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "i");
}

function memorySearch(workspaceRoot, options = {}) {
  const query = options.query ?? "";
  if (typeof query !== "string" || query === "") {
    throw new Error("query is required");
  }
  const limit = Number.isInteger(options.maxResults) && options.maxResults > 0
    ? Math.min(options.maxResults, MAX_SEARCH_RESULTS)
    : DEFAULT_SEARCH_RESULTS;
  const matcher = compileMatcher(query, Boolean(options.regex));
  const candidateRoots = Array.isArray(options.paths) && options.paths.length > 0
    ? options.paths
    : ["memory"];

  const matches = [];
  for (const candidate of candidateRoots) {
    let absoluteRoot;
    try {
      absoluteRoot = resolveInsideMemory(workspaceRoot, candidate);
    } catch (error) {
      throw error;
    }
    if (!fs.existsSync(absoluteRoot)) continue;
    const stats = assertNotSymlink(absoluteRoot);
    const files = stats.isFile() ? [absoluteRoot] : collectFiles(absoluteRoot);
    for (const fileAbsolute of files) {
      const ext = path.extname(fileAbsolute).toLowerCase();
      if (ext !== "" && !TEXT_FILE_EXTENSIONS.has(ext)) continue;
      let content;
      try {
        content = fs.readFileSync(fileAbsolute, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (matcher.test(lines[i])) {
          matches.push({
            path: workspaceRelative(workspaceRoot, fileAbsolute),
            line: i + 1,
            snippet: lines[i].slice(0, 240)
          });
          if (matches.length >= limit) {
            return { query, matches, truncated: true };
          }
        }
      }
    }
  }
  return { query, matches, truncated: false };
}

function collectFiles(rootDir) {
  const result = [];
  function walk(dir) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const child = path.join(dir, name);
      let stats;
      try {
        stats = fs.lstatSync(child);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        walk(child);
      } else if (stats.isFile()) {
        result.push(child);
      }
    }
  }
  walk(rootDir);
  return result;
}

export {
  MAX_READ_BYTES,
  memoryList,
  memoryRead,
  memorySearch
};
