import fs from "node:fs";
import path from "node:path";

import {
  buildCatalog,
  graphStats,
  loadGraph,
  queryGraph,
  validateGraph
} from "../memory-graph.mjs";
import { runMaintenance } from "../memory-maintenance.mjs";
import { detectMemoryState } from "../memory-migration.mjs";

import { appendEntry } from "./memory-append.mjs";
import { applyProposal } from "./memory-apply-proposal.mjs";
import { runAudit } from "./memory-audit.mjs";
import { memoryList, memoryRead, memorySearch } from "./memory-fs.mjs";
import { proposeEdit } from "./memory-proposals.mjs";
import { loadWorkspaceConfig, toPosixPath } from "./workspace.mjs";

function readPamVersion(workspaceRoot) {
  const p = path.join(workspaceRoot, "memory", "pam.version.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (error) {
    return { parseError: error.message };
  }
}

function jsonResultContent(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError: false
  };
}

function errorContent(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}

function buildToolRegistry({ workspaceRoot, serverVersion }) {
  const loadConfig = () => loadWorkspaceConfig(workspaceRoot);

  const tools = [
    {
      name: "pam_version",
      description: "Returns memory/pam.version.json and the MCP server version.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => jsonResultContent({
        pam: readPamVersion(workspaceRoot),
        server: { name: "pam", version: serverVersion }
      })
    },
    {
      name: "memory_state",
      description: "Detects whether the workspace is graph-v1, markdown-v0, partial, or unknown.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => jsonResultContent(detectMemoryState(workspaceRoot))
    },
    {
      name: "memory_list",
      description: "Lists files under a memory/ subdirectory (depth-limited, no symlinks).",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "relative path under memory/ (default 'memory')" },
          depth: { type: "integer", minimum: 1, maximum: 6, description: "max recursion depth (default 3)" }
        },
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(memoryList(workspaceRoot, args ?? {}))
    },
    {
      name: "memory_read",
      description: "Reads a text file under memory/. Rejects symlinks, non-text extensions, and oversize files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "path relative to workspace root, must be under memory/" }
        },
        required: ["path"],
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(memoryRead(workspaceRoot, args?.path))
    },
    {
      name: "memory_search",
      description: "Substring or regex search across memory/ markdown and JSONL files.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          regex: { type: "boolean" },
          paths: { type: "array", items: { type: "string" } },
          maxResults: { type: "integer", minimum: 1, maximum: 1000 }
        },
        required: ["query"],
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(memorySearch(workspaceRoot, args ?? {}))
    },
    {
      name: "graph_query",
      description: "Resolves aliases and one-hop neighbors. Wraps queryGraph(loadGraph()).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string" },
          relation: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 }
        },
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(queryGraph(loadGraph(workspaceRoot), args ?? {}))
    },
    {
      name: "graph_stats",
      description: "Returns node/edge/alias counts and file sizes for memory/graph/.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => jsonResultContent(graphStats(workspaceRoot))
    },
    {
      name: "graph_validate",
      description: "Validates memory/graph/*.jsonl integrity. Read-only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => jsonResultContent(validateGraph(loadGraph(workspaceRoot)))
    },
    {
      name: "graph_reindex",
      description: "Rebuilds memory/graph/catalog.json from the JSONL sources. Writes only the derived catalog.",
      inputSchema: {
        type: "object",
        properties: { dryRun: { type: "boolean" } },
        additionalProperties: false
      },
      handler: async (args) => {
        const catalog = buildCatalog(workspaceRoot);
        const dryRun = Boolean(args?.dryRun);
        const catalogPath = path.join(workspaceRoot, "memory", "graph", "catalog.json");
        if (!dryRun) {
          fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
        }
        return jsonResultContent({
          wrote: dryRun ? null : toPosixPath(path.relative(workspaceRoot, catalogPath)),
          dryRun,
          health: catalog.health
        });
      }
    },
    {
      name: "maintenance_config",
      description: "Returns the parsed memory-maintenance.config.json so callers can self-check scope and protected paths.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => jsonResultContent(loadConfig())
    },
    {
      name: "maintenance_run",
      description: "Runs memory maintenance (rotate/index/synthesis/maintain). Defaults to dry-run.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", enum: ["rotate", "index", "synthesis", "maintain"] },
          dryRun: { type: "boolean" }
        },
        additionalProperties: false
      },
      handler: async (args) => {
        const command = args?.command ?? "maintain";
        const dryRun = args?.dryRun !== false;
        const result = runMaintenance(workspaceRoot, loadConfig(), command, { dryRun });
        return jsonResultContent(result);
      }
    },
    {
      name: "memory_audit",
      description: "Runs hygiene checks (duplicates, link rot, rotation candidates, etc.). Returns Finding[]. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          checks: { type: "array", items: { type: "string" } },
          staleDays: { type: "integer", minimum: 1 }
        },
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(runAudit(workspaceRoot, loadConfig(), args ?? {}))
    },
    {
      name: "memory_append",
      description: "Appends a dated section to a managed log (config.managedLogs). Validates the header against ## YYYY-MM-DD - <title> so parseLogSections recognizes it as kind: 'dated'. Refuses paths not in managedLogs. Newest-first insertion (after the file's intro prefix, before the first existing dated section).",
      inputSchema: {
        type: "object",
        properties: {
          log: { type: "string", description: "managed log archiveKey (preferred) or source path" },
          headerTitle: { type: "string", description: "title portion of the header, after the date" },
          body: { type: "string", description: "markdown body of the new section" },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "ISO date (defaults to today UTC)" }
        },
        required: ["log", "headerTitle", "body"],
        additionalProperties: false
      },
      handler: async (args) => {
        const result = appendEntry(workspaceRoot, loadConfig(), args ?? {});
        if (!result.ok) {
          return jsonResultContent({ status: "rejected", error: result.error });
        }
        return jsonResultContent({ status: "appended", ...result });
      }
    },
    {
      name: "memory_apply_proposal",
      description: "Applies a previously-recorded proposal (memory/maintenance/proposals/<id>.json) to its target file. Re-validates path safety and re-applies the diff against current content (drift detection). On success, archives the artifact as <id>.applied.json with appliedAt added.",
      inputSchema: {
        type: "object",
        properties: {
          proposalId: { type: "string" }
        },
        required: ["proposalId"],
        additionalProperties: false
      },
      handler: async (args) => {
        const result = applyProposal(workspaceRoot, loadConfig(), args ?? {});
        if (!result.ok) {
          return jsonResultContent({ status: "rejected", error: result.error });
        }
        return jsonResultContent(result);
      }
    },
    {
      name: "memory_propose_edit",
      description: "Records a proposed edit as a JSON artifact under memory/maintenance/proposals/. Never mutates the target file. Rejects protected paths, escapes, oversize diffs, and JSONL edits that would invalidate the graph.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          rationale: { type: "string" },
          findingIds: { type: "array", items: { type: "string" } },
          diff: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["replace", "unified-diff"] },
              anchor: { type: "object" },
              before: { type: "string" },
              after: { type: "string" },
              patch: { type: "string" }
            },
            required: ["kind"]
          }
        },
        required: ["path", "rationale", "diff"],
        additionalProperties: false
      },
      handler: async (args) => {
        const result = proposeEdit(workspaceRoot, loadConfig(), args ?? {});
        if (!result.ok) {
          return jsonResultContent({ status: "rejected", error: result.error, validation: { ok: false, errors: [result.error] } });
        }
        return jsonResultContent(result);
      }
    }
  ];

  const byName = new Map();
  for (const tool of tools) byName.set(tool.name, tool);

  function listTools() {
    return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async function callTool(name, args) {
    const tool = byName.get(name);
    if (!tool) {
      return errorContent(`Unknown tool: ${name}`);
    }
    try {
      return await tool.handler(args);
    } catch (error) {
      return errorContent(error.message ?? String(error));
    }
  }

  return { listTools, callTool };
}

export { buildToolRegistry };
