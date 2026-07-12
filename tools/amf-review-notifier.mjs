#!/usr/bin/env node
import path from "node:path";

import { relayReviewNotifications, scanReviewNotifications } from "./lib/amf-review-notifier.mjs";
import { loadWorkspaceConfig } from "./lib/workspace.mjs";
import { readOwnerOnlyFileSync } from "./lib/secure-fs.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
}
function count(name, fallback) {
  const raw = argument(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is invalid`);
  return value;
}

async function main() {
  const command = process.argv[2];
  if (command === "scan") {
    const workspace = path.resolve(argument("--workspace") || process.cwd());
    const result = scanReviewNotifications(workspace, loadWorkspaceConfig(workspace), {
      scope: argument("--scope"), limit: count("--limit", 50)
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "relay") {
    const scan = JSON.parse(readOwnerOnlyFileSync(argument("--input"), { label: "review scan input", maxBytes: 1024 * 1024 }));
    const result = relayReviewNotifications(scan, {
      stateDir: argument("--state-dir"), targetFile: argument("--target-file"),
      openclawBin: argument("--openclaw-bin") || "/usr/local/bin/openclaw",
      dryRun: process.argv.includes("--dry-run")
    }, { execFileSync: (await import("node:child_process")).execFileSync });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("usage: amf-review-notifier.mjs scan|relay");
}

main().catch(error => {
  process.stderr.write(`amf-review-notifier: ${error.message}\n`);
  process.exitCode = 1;
});
