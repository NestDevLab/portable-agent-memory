#!/usr/bin/env node
// install-mcp.mjs
//
// Registers the PAM MCP server with Kimi Code CLI.
// Writes an absolute-path entry into ~/.kimi/mcp.json so Kimi can discover
// PAM tools (memory_*, graph_*, maintenance_*, etc.) in any session.
//
// Dry-run by default. Pass --apply to write.
//
// Usage:
//   node tools/kimi/install-mcp.mjs                  # dry-run
//   node tools/kimi/install-mcp.mjs --apply          # write ~/.kimi/mcp.json
//   node tools/kimi/install-mcp.mjs --apply --force  # overwrite existing pam entry
//   node tools/kimi/install-mcp.mjs --apply --uninstall

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "tools", "kimi", "templates");
const KIMI_DIR = path.join(os.homedir(), ".kimi");
const MCP_CONFIG_PATH = path.join(KIMI_DIR, "mcp.json");

function parseArgs(argv) {
  const out = { apply: false, force: false, uninstall: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--force") out.force = true;
    else if (a === "--uninstall") out.uninstall = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`install-mcp.mjs - register PAM with Kimi Code CLI.

Registers the PAM stdio MCP server so Kimi can use PAM tools in any session.
The config is written to ~/.kimi/mcp.json with absolute paths.

Options:
  --apply     Actually write the config. Without this flag, runs in dry-run mode.
  --force     Overwrite an existing pam MCP entry.
  --uninstall Remove the pam MCP entry and restore the backup.
  -h, --help  Show this help.
`);
}

function resolveWorkspaceRoot() {
  let dir = REPO_ROOT;
  while (dir !== "/" && dir !== "" && dir !== ".") {
    if (fs.existsSync(path.join(dir, "memory", "pam.version.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function loadMcpConfig() {
  if (fs.existsSync(MCP_CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, "utf8"));
  }
  return {};
}

function buildFragment(workspaceRoot) {
  const serverPath = path.join(workspaceRoot, "tools", "pam-mcp-server.mjs");
  const raw = fs.readFileSync(path.join(TEMPLATE_ROOT, "mcp.fragment.json"), "utf8");
  return JSON.parse(
    raw
      .replaceAll("{{SERVER_PATH}}", serverPath)
      .replaceAll("{{WORKSPACE_PATH}}", workspaceRoot)
  );
}

function mergeMcpConfig(existing, fragment, { force }) {
  const next = { ...existing };
  const warnings = [];
  if (!next.mcpServers) next.mcpServers = {};

  if (next.mcpServers.pam && !force) {
    warnings.push(
      `mcpServers.pam already configured (command: ${next.mcpServers.pam.command ?? "?"}); leaving it untouched. Pass --force to overwrite.`
    );
  } else {
    next.mcpServers = { ...next.mcpServers, ...fragment.mcpServers };
  }
  return { next, warnings };
}

function removeMcpConfig(existing) {
  const next = { ...existing };
  const removed = [];
  if (next.mcpServers && next.mcpServers.pam) {
    delete next.mcpServers.pam;
    removed.push("mcpServers.pam");
    if (Object.keys(next.mcpServers).length === 0) {
      delete next.mcpServers;
    }
  }
  return { next, removed };
}

function planInstall(args) {
  const workspaceRoot = resolveWorkspaceRoot();
  const existing = loadMcpConfig();
  const fragment = buildFragment(workspaceRoot);
  const { next, warnings } = mergeMcpConfig(existing, fragment, { force: args.force });
  return { workspaceRoot, existing, next, warnings };
}

function planUninstall() {
  const existing = loadMcpConfig();
  const { next, removed } = removeMcpConfig(existing);
  return { existing, next, removed };
}

function doInstall(args) {
  const plan = planInstall(args);
  const { workspaceRoot, existing, next, warnings } = plan;
  const stdout = process.stdout;

  stdout.write(`Install plan (${args.apply ? "apply" : "dry-run"})\n`);
  stdout.write(`  workspace:    ${workspaceRoot}\n`);
  stdout.write(`  config:       ${MCP_CONFIG_PATH}\n\n`);

  if (warnings.length > 0) {
    stdout.write("Notes:\n");
    for (const w of warnings) stdout.write(`  - ${w}\n`);
    stdout.write("\n");
  }

  stdout.write("Config diff:\n");
  const beforeKeys = Object.keys(existing.mcpServers ?? {});
  const afterKeys = Object.keys(next.mcpServers ?? {});
  stdout.write(`  mcpServers before: [${beforeKeys.join(", ") || "(none)"}]\n`);
  stdout.write(`  mcpServers after:  [${afterKeys.join(", ") || "(none)"}]\n\n`);

  if (!args.apply) {
    stdout.write("Re-run with --apply to write the config. Add --force to overwrite existing.\n");
    return;
  }

  fs.mkdirSync(KIMI_DIR, { recursive: true });
  const configJson = `${JSON.stringify(next, null, 2)}\n`;
  if (JSON.stringify(existing) !== JSON.stringify(next)) {
    if (fs.existsSync(MCP_CONFIG_PATH)) {
      fs.copyFileSync(MCP_CONFIG_PATH, `${MCP_CONFIG_PATH}.bak`);
      stdout.write(`backed up existing mcp.json to ${MCP_CONFIG_PATH}.bak\n`);
    }
    fs.writeFileSync(MCP_CONFIG_PATH, configJson, "utf8");
    stdout.write(`wrote ${MCP_CONFIG_PATH}\n`);
  } else {
    stdout.write(`mcp.json unchanged (no merges needed)\n`);
  }

  stdout.write("\nDone. Run `kimi mcp test pam` to verify the server starts.\n");
}

function doUninstall(args) {
  const plan = planUninstall();
  const { existing, next, removed } = plan;
  const stdout = process.stdout;

  stdout.write(`Uninstall plan (${args.apply ? "apply" : "dry-run"})\n`);
  stdout.write(`  config:       ${MCP_CONFIG_PATH}\n\n`);

  if (removed.length > 0) {
    stdout.write("Entries to remove:\n");
    for (const r of removed) stdout.write(`  - ${r}\n`);
    stdout.write("\n");
  } else {
    stdout.write("Nothing to remove (mcpServers.pam not found).\n\n");
  }

  if (!args.apply) {
    stdout.write("Re-run with --apply to perform the uninstall.\n");
    return;
  }

  if (JSON.stringify(existing) !== JSON.stringify(next)) {
    fs.copyFileSync(MCP_CONFIG_PATH, `${MCP_CONFIG_PATH}.bak`);
    fs.writeFileSync(MCP_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    stdout.write(`wrote ${MCP_CONFIG_PATH} (backup: ${MCP_CONFIG_PATH}.bak)\n`);
  } else {
    stdout.write("mcp.json unchanged (nothing to remove)\n");
  }
  stdout.write("\nDone.\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.uninstall) doUninstall(args);
  else doInstall(args);
}

if (process.argv[1] === __filename) {
  main();
}
