#!/usr/bin/env node
import fs from "node:fs";

import {
  curatorStatus,
  planCuratorGitWrite,
  recoverCuratorLedger,
  reviewCuratorCandidate,
  submitCuratorCandidate
} from "./lib/memory-curator.mjs";
import { applyDecisionReceipt } from "./lib/memory-receipt-applicator.mjs";
import { DEFAULT_WORKSPACE_ROOT, loadWorkspaceConfig, resolveWorkspaceRoot } from "./lib/workspace.mjs";

function usage() {
  return `Usage:
  node tools/memory-curator.mjs submit --input <candidate.json> [--workspace <root>]
  node tools/memory-curator.mjs review --input <review.json> [--workspace <root>]
  node tools/memory-curator.mjs apply --input <application.json> [--workspace <root>]
  node tools/memory-curator.mjs status [--candidate-id <id>] [--workspace <root>]
  node tools/memory-curator.mjs recover --input <recovery.json> [--workspace <root>]
  node tools/memory-curator.mjs git-plan --input <plan.json> [--workspace <root>]

Input files contain canonical AMF records or review metadata only. RAW transcripts/events are not accepted.
`;
}

function parseArgs(argv) {
  const result = {
    command: argv[0] ?? null,
    workspace: null,
    input: null,
    candidateId: null,
    help: argv[0] === "--help" || argv[0] === "-h"
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--workspace") { result.workspace = next; index += 1; }
    else if (arg === "--input") { result.input = next; index += 1; }
    else if (arg === "--candidate-id") { result.candidateId = next; index += 1; }
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return result;
}

function readInput(filename) {
  if (!filename) throw new Error("--input is required");
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("input must be a JSON object");
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    process.stdout.write(usage());
    return;
  }
  const root = args.workspace ? resolveWorkspaceRoot(args.workspace) : DEFAULT_WORKSPACE_ROOT;
  const config = loadWorkspaceConfig(root);
  let result;
  if (args.command === "submit") result = submitCuratorCandidate(root, config, readInput(args.input));
  else if (args.command === "review") result = reviewCuratorCandidate(root, config, readInput(args.input));
  else if (args.command === "apply") result = applyDecisionReceipt(root, config, readInput(args.input));
  else if (args.command === "status") result = curatorStatus(root, config, args.candidateId ? { candidateId: args.candidateId } : {});
  else if (args.command === "recover") result = recoverCuratorLedger(root, config, readInput(args.input));
  else if (args.command === "git-plan") result = planCuratorGitWrite(config, readInput(args.input));
  else throw new Error(`unknown command: ${args.command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`memory-curator: ${error.message}\n`);
  process.exitCode = 1;
}
