#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { readProposal, validateCaptureProposal } from "./lib/pam-capture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = [...argv];
  const options = { command: args.shift() ?? "plan", workspaceRoot: DEFAULT_ROOT, allowedPaths: [] };
  while (args.length > 0) {
    const arg = args.shift();
    const value = () => {
      const next = args.shift();
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--workspace-root") options.workspaceRoot = value();
    else if (arg === "--proposal") options.proposal = value();
    else if (arg === "--allow-path") options.allowedPaths.push(value());
    else if (arg === "--json") continue;
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  if (!options.proposal) throw new Error("--proposal is required");
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (!new Set(["validate", "plan"]).has(options.command)) throw new Error("Capture apply is disabled during shadow mode; use validate or plan.");
  const proposal = readProposal(options.workspaceRoot, options.proposal);
  const report = validateCaptureProposal(options.workspaceRoot, proposal, options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "BLOCKED" ? 2 : 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
