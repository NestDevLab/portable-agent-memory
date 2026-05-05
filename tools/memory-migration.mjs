import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGraph, validateGraph } from "./memory-graph.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");

function exists(workspaceRoot, relativePath) {
  return fs.existsSync(path.join(workspaceRoot, relativePath));
}

function readJsonIfPresent(workspaceRoot, relativePath) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    return { parseError: error.message };
  }
}

function detectMemoryState(workspaceRoot = WORKSPACE_ROOT) {
  const version = readJsonIfPresent(workspaceRoot, "memory/pam.version.json");
  const hasGraphCatalog = exists(workspaceRoot, "memory/graph/catalog.json");
  const hasGraphFiles =
    exists(workspaceRoot, "memory/graph/nodes.jsonl") &&
    exists(workspaceRoot, "memory/graph/edges.jsonl") &&
    exists(workspaceRoot, "memory/graph/aliases.jsonl");
  const hasMarkdownMemory =
    exists(workspaceRoot, "memory/index.md") &&
    exists(workspaceRoot, "memory/conversation-log.md") &&
    exists(workspaceRoot, "memory/knowledge-log.md") &&
    exists(workspaceRoot, "memory/agent-memory/pam.md");
  let graphValidation = null;

  if (hasGraphFiles) {
    try {
      graphValidation = validateGraph(loadGraph(workspaceRoot));
    } catch (error) {
      graphValidation = { ok: false, errors: [error.message], warnings: [] };
    }
  }

  let state = "unknown";
  if (version?.memoryFormat === "graph-v1" && hasGraphCatalog && graphValidation?.ok) {
    state = "graph-v1";
  } else if (version?.memoryFormat === "graph-v1" || hasGraphCatalog || hasGraphFiles) {
    state = "partial";
  } else if (!version && hasMarkdownMemory) {
    state = "markdown-v0";
  }

  return {
    state,
    version: version?.parseError ? null : version,
    versionError: version?.parseError ?? null,
    detected: {
      hasGraphCatalog,
      hasGraphFiles,
      hasMarkdownMemory
    },
    graphValidation
  };
}

function parseArgs(argv) {
  return {
    command: argv[0] ?? "detect",
    json: argv.includes("--json")
  };
}

export {
  detectMemoryState
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command !== "detect") {
    throw new Error(`Unsupported memory-migration command: ${options.command}`);
  }
  const result = detectMemoryState();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === __filename) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
