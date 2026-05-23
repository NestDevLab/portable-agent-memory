import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../memory-maintenance.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_WORKSPACE_ROOT = process.cwd();

function resolveWorkspaceRoot(input) {
  if (!input) return DEFAULT_WORKSPACE_ROOT;
  return path.resolve(input);
}

function workspaceConfigPath(workspaceRoot) {
  return path.join(workspaceRoot, "tools", "memory-maintenance.config.json");
}

function loadWorkspaceConfig(workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  const configPath = workspaceConfigPath(workspaceRoot);
  if (fs.existsSync(configPath)) {
    return loadConfig(configPath);
  }
  return loadConfig();
}

function isUnderDir(absolutePath, dirAbsolutePath) {
  const rel = path.relative(dirAbsolutePath, absolutePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveInsideMemory(workspaceRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error("path is required");
  }
  const memoryRoot = path.join(workspaceRoot, "memory");
  const absolute = path.resolve(workspaceRoot, relativePath);
  if (!isUnderDir(absolute, memoryRoot)) {
    throw new Error(`path escapes memory/: ${relativePath}`);
  }
  return absolute;
}

function resolveInsideWorkspace(workspaceRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error("path is required");
  }
  const absolute = path.resolve(workspaceRoot, relativePath);
  if (!isUnderDir(absolute, workspaceRoot)) {
    throw new Error(`path escapes workspace: ${relativePath}`);
  }
  return absolute;
}

function isPathProtected(workspaceRoot, relativePath, protectedPaths) {
  if (!Array.isArray(protectedPaths)) return false;
  const target = path.resolve(workspaceRoot, relativePath);
  for (const protectedEntry of protectedPaths) {
    const protectedAbsolute = path.resolve(workspaceRoot, protectedEntry);
    if (target === protectedAbsolute) return true;
    const rel = path.relative(protectedAbsolute, target);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function workspaceRelative(workspaceRoot, absolutePath) {
  return toPosixPath(path.relative(workspaceRoot, absolutePath));
}

export {
  DEFAULT_WORKSPACE_ROOT,
  isPathProtected,
  isUnderDir,
  loadWorkspaceConfig,
  resolveInsideMemory,
  resolveInsideWorkspace,
  resolveWorkspaceRoot,
  toPosixPath,
  workspaceRelative
};
