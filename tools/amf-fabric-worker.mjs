#!/usr/bin/env node
import {
  dispatchFabricApplyReceipt,
  drainFabricProposals,
  intakeFabricProposal,
  replayFabricDecisionOutbox
} from "./lib/amf-fabric-transport.mjs";
import { deliverAppliedMemoryToGit } from "./lib/memory-receipt-applicator.mjs";
import { loadWorkspaceConfig, resolveWorkspaceRoot } from "./lib/workspace.mjs";

function args(argv) {
  const result = { command: argv[0], workspace: process.cwd(), proposalId: null, decisionId: null, cursor: null, limit: 50, maxPages: 10, dispatch: false, push: false };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index]; const value = argv[index + 1];
    if (key === "--workspace") { result.workspace = value; index += 1; }
    else if (key === "--proposal-id") { result.proposalId = value; index += 1; }
    else if (key === "--decision-id") { result.decisionId = value; index += 1; }
    else if (key === "--cursor") { result.cursor = value; index += 1; }
    else if (key === "--limit") { result.limit = Number(value); index += 1; }
    else if (key === "--max-pages") { result.maxPages = Number(value); index += 1; }
    else if (key === "--dispatch") result.dispatch = true;
    else if (key === "--push") result.push = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  return result;
}

async function main() {
  const input = args(process.argv.slice(2));
  const root = resolveWorkspaceRoot(input.workspace);
  const config = loadWorkspaceConfig(root);
  let result;
  if (input.command === "drain") result = await drainFabricProposals(root, config, { limit: input.limit, maxPages: input.maxPages, cursor: input.cursor, dispatch: input.dispatch });
  else if (input.command === "intake") result = await intakeFabricProposal(root, config, { proposalId: input.proposalId, dispatch: input.dispatch });
  else if (input.command === "dispatch-apply") result = await dispatchFabricApplyReceipt(root, config, { decisionId: input.decisionId });
  else if (input.command === "replay-decisions") result = await replayFabricDecisionOutbox(root, config, { limit: input.limit, maxPages: input.maxPages, cursor: input.cursor });
  else if (input.command === "git-deliver") result = deliverAppliedMemoryToGit(root, config, { decisionId: input.decisionId, push: input.push });
  else throw new Error("command must be drain, intake, replay-decisions, dispatch-apply, or git-deliver");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`amf-fabric-worker: ${error.message}\n`); process.exitCode = 1; });
