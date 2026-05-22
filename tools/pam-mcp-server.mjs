#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildToolRegistry } from "./lib/mcp-tools.mjs";
import {
  MCP_PROTOCOL_VERSION,
  dispatch,
  encodeFrame,
  runStdioServer
} from "./lib/mcp-transport.mjs";
import { DEFAULT_WORKSPACE_ROOT, resolveWorkspaceRoot } from "./lib/workspace.mjs";

const __filename = fileURLToPath(import.meta.url);

function readServerVersion() {
  const pkgPath = path.resolve(path.dirname(__filename), "..", "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function parseArgs(argv) {
  const result = { smoke: false, workspace: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--smoke") result.smoke = true;
    else if (arg === "--workspace") {
      result.workspace = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--workspace=")) {
      result.workspace = arg.slice("--workspace=".length);
    }
  }
  return result;
}

function makeServer(workspaceRoot) {
  const serverVersion = readServerVersion();
  const registry = buildToolRegistry({ workspaceRoot, serverVersion });
  return {
    name: "pam",
    version: serverVersion,
    listTools: registry.listTools,
    callTool: registry.callTool
  };
}

async function runSmoke(server) {
  const initResponse = await dispatch(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } },
    server
  );
  process.stdout.write(encodeFrame(initResponse));
  const listResponse = await dispatch(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    server
  );
  process.stdout.write(encodeFrame(listResponse));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceRoot = args.workspace
    ? resolveWorkspaceRoot(args.workspace)
    : DEFAULT_WORKSPACE_ROOT;
  const server = makeServer(workspaceRoot);

  if (args.smoke) {
    await runSmoke(server);
    return;
  }

  const shutdown = () => {
    process.stdin.pause();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runStdioServer(server);
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    process.stderr.write(`pam-mcp-server fatal: ${error.message ?? String(error)}\n`);
    process.exit(1);
  });
}

export { makeServer };
