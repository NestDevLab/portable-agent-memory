#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectPamHealth } from "./lib/pam-health.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = { workspaceRoot: DEFAULT_ROOT };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    const value = () => {
      const next = args.shift();
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--workspace-root") options.workspaceRoot = value();
    else if (arg === "--graph-dir") options.graphDir = value();
    else if (arg === "--version-path") options.versionPath = value();
    else if (arg === "--catalog-path") options.catalogPath = value();
    else if (arg === "--scenario") options.scenario = value();
    else if (arg === "--source-registry") options.sourceRegistry = value();
    else if (arg === "--corpus-root") options.corpusRoots = [...(options.corpusRoots ?? []), value()];
    else if (arg === "--corpus-entrypoint") options.corpusEntrypoints = [...(options.corpusEntrypoints ?? []), value()];
    else if (arg === "--stale-after-days") options.staleAfterDays = Number(value());
    else if (arg === "--json") continue;
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = collectPamHealth(options.workspaceRoot, options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "PASS" ? 0 : report.status === "ATTENTION" ? 1 : 2;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
