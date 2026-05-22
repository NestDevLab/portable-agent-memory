#!/usr/bin/env node
// install-pam-statusline.mjs
//
// Installs the PAM status line into ~/.claude/ (user scope) or
// <cwd>/.claude/ (project scope). Claude Code requires the statusLine to be
// configured outside of plugins, so this installer remains separate from the
// PAM Claude Code plugin (which ships the MCP server, agents, slash commands,
// and hooks).
//
// Dry-run by default. Pass --apply to actually write files.
//
// Usage:
//   node tools/install-pam-statusline.mjs                  # dry-run, user scope
//   node tools/install-pam-statusline.mjs --apply          # install to ~/.claude/
//   node tools/install-pam-statusline.mjs --scope project --apply
//   node tools/install-pam-statusline.mjs --target /path/to/.claude --apply
//   node tools/install-pam-statusline.mjs --apply --force  # overwrite existing files
//   node tools/install-pam-statusline.mjs --apply --uninstall

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "templates", "pam-claude-layer");

function parseArgs(argv) {
  const out = { apply: false, force: false, scope: "user", target: null, uninstall: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--force") out.force = true;
    else if (a === "--uninstall") out.uninstall = true;
    else if (a === "--scope") {
      out.scope = argv[i + 1];
      i += 1;
    } else if (a === "--target") {
      out.target = argv[i + 1];
      i += 1;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`install-pam-statusline.mjs - install the PAM Claude Code status line.

The MCP server, subagents, slash commands, and hooks ship as a Claude Code
plugin. Install the plugin separately:

  /plugin install stefanoguerrini/portable-agent-memory@github

This script only installs the status line, which Claude Code requires to be
configured outside of plugins.

Options:
  --apply              Actually write files. Without this flag, runs in dry-run mode.
  --scope user|project Where to install. Default: user (~/.claude/).
  --target <path>      Override scope; install into <path>/.claude/ (or <path> if it ends in .claude).
  --force              Overwrite existing files and settings.statusLine.
  --uninstall          Remove the status line (deletes files; cleans matching settings entries).
  -h, --help           Show this help.
`);
}

function resolveClaudeDir({ scope, target }) {
  if (target) {
    const abs = path.resolve(target);
    return path.basename(abs) === ".claude" ? abs : path.join(abs, ".claude");
  }
  if (scope === "project") return path.join(process.cwd(), ".claude");
  return path.join(os.homedir(), ".claude");
}

function loadFragment(layerDir) {
  const raw = fs.readFileSync(path.join(TEMPLATE_ROOT, "settings.fragment.json"), "utf8");
  return JSON.parse(raw.replaceAll("{{LAYER_DIR}}", layerDir));
}

function listCopyOps(claudeDir) {
  const layerDir = path.join(claudeDir, "pam-layer");
  const ops = [
    {
      from: path.join(TEMPLATE_ROOT, "statusline", "pam-statusline.sh"),
      to: path.join(layerDir, "statusline", "pam-statusline.sh"),
      mode: 0o755,
    },
  ];
  return { layerDir, ops };
}

function mergeSettings(existing, fragment, { force }) {
  const next = { ...existing };
  const warnings = [];
  if (fragment.statusLine) {
    if (existing.statusLine && !force) {
      warnings.push(
        `settings.statusLine already set (command: ${existing.statusLine.command ?? "?"}); leaving it untouched. Pass --force to overwrite.`
      );
    } else {
      next.statusLine = fragment.statusLine;
    }
  }
  return { next, warnings };
}

function removeFromSettings(existing, layerDir) {
  const next = { ...existing };
  const removed = [];
  const layerPrefix = layerDir.endsWith("/") ? layerDir : `${layerDir}/`;
  const looksLikeOurs = (cmd) =>
    typeof cmd === "string" && (cmd.startsWith(layerPrefix) || cmd.startsWith(layerDir));
  if (next.statusLine && looksLikeOurs(next.statusLine.command)) {
    delete next.statusLine;
    removed.push("statusLine");
  }
  if (next._pamDisabledStatusLine && looksLikeOurs(next._pamDisabledStatusLine.command)) {
    delete next._pamDisabledStatusLine;
    removed.push("_pamDisabledStatusLine");
  }
  return { next, removed };
}

function planInstall(args) {
  const claudeDir = resolveClaudeDir(args);
  const { layerDir, ops } = listCopyOps(claudeDir);
  const settingsPath = path.join(claudeDir, "settings.json");
  const existing = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
  const fragment = loadFragment(layerDir);
  const { next, warnings } = mergeSettings(existing, fragment, { force: args.force });
  return { claudeDir, layerDir, settingsPath, ops, existing, next, warnings };
}

function planUninstall(args) {
  const claudeDir = resolveClaudeDir(args);
  const { layerDir, ops } = listCopyOps(claudeDir);
  const settingsPath = path.join(claudeDir, "settings.json");
  const existing = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
  const { next, removed } = removeFromSettings(existing, layerDir);
  return { claudeDir, layerDir, settingsPath, ops, existing, next, removed };
}

function doInstall(args) {
  const plan = planInstall(args);
  const { claudeDir, layerDir, settingsPath, ops, existing, next, warnings } = plan;
  const stdout = process.stdout;

  stdout.write(`Install plan (${args.apply ? "apply" : "dry-run"})\n`);
  stdout.write(`  claude dir:   ${claudeDir}\n`);
  stdout.write(`  layer dir:    ${layerDir}\n`);
  stdout.write(`  settings:     ${settingsPath}\n\n`);

  stdout.write("Files:\n");
  for (const op of ops) {
    const exists = fs.existsSync(op.to);
    const tag = exists ? (args.force ? "OVERWRITE" : "SKIP (exists)") : "WRITE";
    stdout.write(`  [${tag}] ${op.to}\n`);
  }
  stdout.write("\n");

  if (warnings.length > 0) {
    stdout.write("Notes:\n");
    for (const w of warnings) stdout.write(`  - ${w}\n`);
    stdout.write("\n");
  }

  if (!args.apply) {
    stdout.write("Re-run with --apply to write these files. Add --force to overwrite existing.\n");
    return;
  }

  for (const op of ops) {
    if (fs.existsSync(op.to) && !args.force) continue;
    fs.mkdirSync(path.dirname(op.to), { recursive: true });
    fs.copyFileSync(op.from, op.to);
    if (op.mode != null) fs.chmodSync(op.to, op.mode);
  }

  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsJson = `${JSON.stringify(next, null, 2)}\n`;
  if (JSON.stringify(existing) !== JSON.stringify(next)) {
    if (fs.existsSync(settingsPath)) {
      fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
      stdout.write(`backed up existing settings.json to ${settingsPath}.bak\n`);
    }
    fs.writeFileSync(settingsPath, settingsJson, "utf8");
    stdout.write(`wrote ${settingsPath}\n`);
  } else {
    stdout.write(`settings.json unchanged (no merges needed)\n`);
  }

  stdout.write("\nDone. Restart Claude Code to pick up the new statusline.\n");
  stdout.write("For the MCP server, agents, slash commands, and hooks, install the plugin:\n");
  stdout.write("  /plugin install stefanoguerrini/portable-agent-memory@github\n");
}

function doUninstall(args) {
  const plan = planUninstall(args);
  const { layerDir, settingsPath, ops, existing, next, removed } = plan;
  const stdout = process.stdout;

  stdout.write(`Uninstall plan (${args.apply ? "apply" : "dry-run"})\n`);
  stdout.write(`  layer dir:    ${layerDir}\n`);
  stdout.write(`  settings:     ${settingsPath}\n\n`);

  stdout.write("Files to remove:\n");
  for (const op of ops) {
    const exists = fs.existsSync(op.to);
    stdout.write(`  [${exists ? "REMOVE" : "skip (missing)"}] ${op.to}\n`);
  }
  stdout.write("\n");
  if (removed.length > 0) {
    stdout.write("Settings entries to clean:\n");
    for (const r of removed) stdout.write(`  - ${r}\n`);
    stdout.write("\n");
  }
  if (!args.apply) {
    stdout.write("Re-run with --apply to perform the uninstall.\n");
    return;
  }

  for (const op of ops) {
    if (fs.existsSync(op.to)) fs.unlinkSync(op.to);
  }
  for (const sub of ["statusline"]) {
    const dir = path.join(layerDir, sub);
    if (fs.existsSync(dir)) {
      try { fs.rmdirSync(dir); } catch { /* not empty - leave it */ }
    }
  }
  if (fs.existsSync(layerDir)) {
    try { fs.rmdirSync(layerDir); } catch { /* not empty - leave it */ }
  }

  if (JSON.stringify(existing) !== JSON.stringify(next)) {
    fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
    fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    stdout.write(`wrote ${settingsPath} (backup: ${settingsPath}.bak)\n`);
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
