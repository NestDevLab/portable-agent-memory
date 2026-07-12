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
import {
  curatorStatus,
  planCuratorGitWrite,
  recoverCuratorLedger,
  reviewCuratorCandidate,
  submitCuratorCandidate
} from "./memory-curator.mjs";
import { applyDecisionReceipt, deliverAppliedMemoryToGit, verifyFabricApplyReceipt } from "./memory-receipt-applicator.mjs";
import { validateMemoryRecord } from "./amf-memory-record.mjs";
import { runAudit } from "./memory-audit.mjs";
import { memoryList, memoryRead, memorySearch } from "./memory-fs.mjs";
import { proposeEdit, proposeMemoryRecord } from "./memory-proposals.mjs";
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
      name: "memory_record_validate",
      description: "Validates an amf-memory/v1 Markdown record and returns its safe graph projection without decrypting sealed content.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "AMF record path under memory/amf/records/" }
        },
        required: ["path"],
        additionalProperties: false
      },
      handler: async (args) => {
        const record = memoryRead(workspaceRoot, args?.path);
        const validation = validateMemoryRecord(record.content, { expectedPath: record.path, workspaceRoot });
        return jsonResultContent({
          status: validation.ok ? "valid" : "invalid",
          path: record.path,
          errors: validation.errors,
          warnings: validation.warnings,
          metadata: validation.metadata,
          projection: validation.projection
        });
      }
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
      description: "Safely applies a recorded proposal after re-validating path safety, drift, and content. It exclusively reserves <id>.applied.json as status applying, atomically persists the target, finalizes the archive as applied, then removes the live proposal. Retries recover idempotently; archive collisions or identity mismatches fail closed.",
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
      name: "memory_propose_record",
      description: "Validates a complete amf-memory/v1 Markdown record and records a create proposal. It never writes the canonical record directly.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Complete AMF Markdown record including frontmatter" },
          rationale: { type: "string" },
          findingIds: { type: "array", items: { type: "string" } }
        },
        required: ["content", "rationale"],
        additionalProperties: false
      },
      handler: async (args) => {
        const result = proposeMemoryRecord(workspaceRoot, loadConfig(), args ?? {});
        if (!result.ok) {
          return jsonResultContent({
            status: "rejected",
            error: result.error,
            validation: result.validation ?? { ok: false, errors: [result.error] }
          });
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
    },
    {
      name: "memory_curator_submit",
      description: "Validates and queues a complete amf-memory/v1 candidate. It emits only a review_required, rejected, or approved_pending_apply decision receipt and never applies canonical memory.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Complete amf-memory/v1 Markdown record; never a transcript or RAW event" },
          rationale: { type: "string" },
          idempotencyKey: { type: "string", minLength: 8, maxLength: 256 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          source: {
            type: "object",
            properties: { type: { type: "string" }, id: { type: "string" } },
            required: ["type", "id"],
            additionalProperties: false
          },
          fabricProposal: {
            type: "object",
            properties: { proposalId: { type: "string" }, proposalDigest: { type: "string", pattern: "^[a-f0-9]{64}$" } },
            required: ["proposalId", "proposalDigest"],
            additionalProperties: false
          }
        },
        required: ["content", "rationale", "idempotencyKey", "confidence", "source"],
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(submitCuratorCandidate(workspaceRoot, loadConfig(), args ?? {}))
    },
    {
      name: "memory_curator_review",
      description: "Records a versioned approve/reject review and emits a decision receipt. Approval remains approved_pending_apply and cannot write canonical memory.",
      inputSchema: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          action: { type: "string", enum: ["approve", "reject"] },
          rationale: { type: "string" },
          reviewer: { type: "string" },
          idempotencyKey: { type: "string", minLength: 8, maxLength: 256 },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["candidateId", "action", "rationale", "reviewer", "idempotencyKey"],
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(reviewCuratorCandidate(workspaceRoot, loadConfig(), args ?? {}))
    },
    {
      name: "memory_receipt_apply",
      description: "Applicator-only deterministic transition for an approved decision receipt. It verifies policy/revision, uses PAM proposal/apply, queues an apply receipt, and dispatches only through a configured injected sink.",
      inputSchema: {
        type: "object",
        properties: {
          decisionId: { type: "string" },
          idempotencyKey: { type: "string", minLength: 8, maxLength: 256 },
          dispatch: { type: "boolean" }
        },
        required: ["decisionId", "idempotencyKey"],
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(applyDecisionReceipt(workspaceRoot, loadConfig(), args ?? {}))
    },
    {
      name: "memory_verify_apply_receipt",
      description: "Verifier-only check that a Fabric apply receipt matches authenticated applicator state, the applied archive, the canonical target, and the atomic PAM record index.",
      inputSchema: {
        type: "object",
        properties: { receipt: { type: "object" } },
        required: ["receipt"],
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(verifyFabricApplyReceipt(workspaceRoot, loadConfig(), args?.receipt ?? {}))
    },
    {
      name: "memory_git_deliver",
      description: "Applicator-only opt-in scoped Git commit and optional fast-forward push for one applied AMF record plus its canonical index entry.",
      inputSchema: {
        type: "object",
        properties: { decisionId: { type: "string" }, push: { type: "boolean" } },
        required: ["decisionId"],
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(deliverAppliedMemoryToGit(workspaceRoot, loadConfig(), args ?? {}))
    },
    {
      name: "memory_curator_status",
      description: "Returns redacted curator queue/review state and verifies the append-only decision ledger hash chain. It never returns claim content.",
      inputSchema: {
        type: "object",
        properties: { candidateId: { type: "string" } },
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(curatorStatus(workspaceRoot, loadConfig(), args ?? {}))
    },
    {
      name: "memory_curator_git_plan",
      description: "Produces a fail-closed dry-run Git writer plan. The writer is disabled by default and always refuses direct push and protected branches.",
      inputSchema: {
        type: "object",
        properties: {
          branch: { type: "string" },
          baseBranch: { type: "string" },
          remote: { type: "string" },
          dryRun: { type: "boolean" },
          push: { type: "boolean" }
        },
        required: ["branch"],
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(planCuratorGitWrite(loadConfig(), args ?? {}))
    },
    {
      name: "memory_curator_recover",
      description: "Curator-only deterministic recovery for a strict-prefix anchor or one exact review artifact. Apply recovery belongs to memory_receipt_apply.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["advance-anchor", "recover-review"] },
          candidateId: { type: "string" },
          decisionAction: { type: "string", enum: ["approve", "reject"] },
          rationale: { type: "string" },
          reviewer: { type: "string" },
          idempotencyKey: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["action"],
        oneOf: [
          {
            properties: { action: { const: "advance-anchor" } },
            required: ["action"]
          },
          {
            properties: {
              action: { const: "recover-review" }
            },
            required: ["action", "candidateId", "decisionAction", "rationale", "reviewer", "idempotencyKey"]
          }
        ],
        additionalProperties: false
      },
      handler: async (args) => jsonResultContent(recoverCuratorLedger(workspaceRoot, loadConfig(), args ?? {}))
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
