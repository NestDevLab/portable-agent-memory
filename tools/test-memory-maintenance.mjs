import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_ENTRIES_MARKER,
  buildRunManifest,
  diffSnapshots,
  loadConfig,
  regenerateArchiveIndexes,
  renderRunReport,
  rotateManagedLogs,
  runAgentSynthesis,
  runMaintenance
} from "./memory-maintenance.mjs";

const FIXED_NOW = new Date("2026-04-23T00:00:00Z");

function makeTempWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portable-agent-memory-test-"));
  fs.mkdirSync(path.join(workspaceRoot, "memory"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "memory", "agent-memory"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "memory", "sources"), { recursive: true });

  fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Test Agents\n");
  fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Test Workspace\n");
  fs.writeFileSync(path.join(workspaceRoot, "memory", "index.md"), "# Memory Index\n");
  fs.writeFileSync(path.join(workspaceRoot, "memory", "agent-memory", "llm-wiki.md"), "# LLM Wiki\n");
  fs.writeFileSync(path.join(workspaceRoot, "memory", "agent-memory", "pam.md"), "# PAM\n");
  fs.writeFileSync(path.join(workspaceRoot, "memory", "sources", "placeholder.md"), "# Placeholder\n");

  return workspaceRoot;
}

function writeManagedLogs(workspaceRoot) {
  fs.writeFileSync(
    path.join(workspaceRoot, "memory", "conversation-log.md"),
    [
      "# Conversation Log",
      "",
      "Intro",
      "",
      "## 2025-12-01 - Old Item",
      "",
      "Old body",
      "",
      "## 2026-03-01 - New Item",
      "",
      "New body",
      "",
      "## Legacy Section",
      "",
      "Should stay in place",
      ""
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(workspaceRoot, "memory", "knowledge-log.md"),
    [
      "# Knowledge Log",
      "",
      "## 2025-12-15",
      "",
      "Legacy dated section body",
      "",
      "## Not A Date",
      "",
      "Still active",
      ""
    ].join("\n")
  );

  fs.writeFileSync(
    path.join(workspaceRoot, "memory", "unused-log.md"),
    [
      "# Mail Triage Log",
      "",
      "## 2025-11-10 - Old Mail Item",
      "",
      "Mail body",
      "",
      "## 2026-04-20 - Recent Mail Item",
      "",
      "Mail recent body",
      ""
    ].join("\n")
  );
}

test("rotation archives only entries older than 90 days and preserves active non-dated sections", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();

  const result = rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW });
  const conversation = result.find((entry) => entry.source === "memory/conversation-log.md");
  const knowledge = result.find((entry) => entry.source === "memory/knowledge-log.md");

  assert.equal(conversation.rotatedCount, 1);
  assert.match(conversation.archiveWrites[0].archivePath, /2025\/2025-Q4\.md$/);
  assert.ok(
    conversation.warnings.some((warning) => warning.includes("Non-dated top-level section left in place"))
  );

  const conversationActive = fs.readFileSync(path.join(workspaceRoot, "memory", "conversation-log.md"), "utf8");
  assert.ok(!conversationActive.includes("## 2025-12-01 - Old Item"));
  assert.ok(conversationActive.includes("## 2026-03-01 - New Item"));
  assert.ok(conversationActive.includes("## Legacy Section"));

  assert.equal(knowledge.rotatedCount, 1);
  assert.ok(
    knowledge.warnings.some((warning) => warning.includes("Legacy dated header retained for compatibility"))
  );
});

test("archived entry bodies are copied unchanged and archives contain the expected marker", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();

  rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW });

  const archivePath = path.join(
    workspaceRoot,
    "memory",
    "archive",
    "conversation-log",
    "2025",
    "2025-Q4.md"
  );
  const archiveContent = fs.readFileSync(archivePath, "utf8");

  assert.ok(archiveContent.includes(ARCHIVE_ENTRIES_MARKER));
  assert.ok(archiveContent.includes("## 2025-12-01 - Old Item\n\nOld body\n"));
});

test("dry-run reports intended moves without changing tracked docs", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();
  const before = fs.readFileSync(path.join(workspaceRoot, "memory", "conversation-log.md"), "utf8");

  const result = rotateManagedLogs(workspaceRoot, config, { dryRun: true, now: FIXED_NOW });
  const after = fs.readFileSync(path.join(workspaceRoot, "memory", "conversation-log.md"), "utf8");

  assert.equal(before, after);
  assert.equal(result.find((entry) => entry.source === "memory/conversation-log.md").rotatedCount, 1);
  assert.equal(fs.existsSync(path.join(workspaceRoot, "memory", "archive")), false);
});

test("rotation also archives dated entries after the active entry limit", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  fs.writeFileSync(
    path.join(workspaceRoot, "memory", "conversation-log.md"),
    [
      "# Conversation Log",
      "",
      "Intro",
      "",
      "## 2026-04-22 - First Recent Item",
      "",
      "First recent body",
      "",
      "## 2026-04-21 - Second Recent Item",
      "",
      "Second recent body",
      ""
    ].join("\n")
  );
  const config = loadConfig();
  config.managedLogs = config.managedLogs.map((entry) =>
    entry.source === "memory/conversation-log.md" ? { ...entry, activeEntryLimit: 1 } : entry
  );

  const result = rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW });
  const conversation = result.find((entry) => entry.source === "memory/conversation-log.md");
  const conversationActive = fs.readFileSync(path.join(workspaceRoot, "memory", "conversation-log.md"), "utf8");

  assert.equal(conversation.activeEntryLimit, 1);
  assert.equal(conversation.datedEntryCount, 2);
  assert.equal(conversation.retainedDatedEntryCount, 1);
  assert.equal(conversation.rotatedCount, 1);
  assert.equal(conversation.rotatedEntries[0].reason, "active entry limit 1");
  assert.ok(conversationActive.includes("## 2026-04-22 - First Recent Item"));
  assert.ok(!conversationActive.includes("## 2026-04-21 - Second Recent Item"));
});

test("archive indexes are regenerated deterministically", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();

  rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW });
  const result = regenerateArchiveIndexes(workspaceRoot, config);

  assert.ok(result.writes.includes("memory/archive/index.md"));
  assert.ok(result.writes.includes("memory/archive/conversation-log/index.md"));

  const globalIndex = fs.readFileSync(path.join(workspaceRoot, "memory", "archive", "index.md"), "utf8");
  const conversationIndex = fs.readFileSync(
    path.join(workspaceRoot, "memory", "archive", "conversation-log", "index.md"),
    "utf8"
  );

  assert.ok(globalIndex.includes("[conversation-log](conversation-log/index.md)"));
  assert.ok(conversationIndex.includes("[2025-Q4.md](2025/2025-Q4.md) - 1 archived entries"));
});

test("missing managed log fails loudly before rotation", () => {
  const workspaceRoot = makeTempWorkspace();
  const config = loadConfig();

  assert.throws(() => rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW }), /Managed log file is missing/);
});

test("malformed archive file stops rotation for that target log", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();
  const malformedArchivePath = path.join(
    workspaceRoot,
    "memory",
    "archive",
    "conversation-log",
    "2025",
    "2025-Q4.md"
  );

  fs.mkdirSync(path.dirname(malformedArchivePath), { recursive: true });
  fs.writeFileSync(malformedArchivePath, "# Broken archive\n", "utf8");

  assert.throws(
    () => rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW }),
    /Malformed archive file missing/
  );

  const conversationActive = fs.readFileSync(path.join(workspaceRoot, "memory", "conversation-log.md"), "utf8");
  assert.ok(conversationActive.includes("## 2025-12-01 - Old Item"));
});

test("agent synthesis copy-back rejects out-of-scope changes", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();
  const mocksynthesisPath = path.join(workspaceRoot, "mock-agent.sh");
  config.synthesis = {
    args: ["-C", "{workspace}", "-o", "{output}", "{prompt}"],
    command: mocksynthesisPath,
    enabled: true,
    provider: "mock-agent",
    stdin: "none"
  };
  const rotation = rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW });
  const archiveIndexing = regenerateArchiveIndexes(workspaceRoot, config);
  const manifest = buildRunManifest(workspaceRoot, config, rotation, archiveIndexing, { now: FIXED_NOW, runId: "test-run" });

  fs.writeFileSync(
    mocksynthesisPath,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "workspace=''",
      "output=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in",
      "    -C)",
      "      workspace=\"$2\"",
      "      shift 2",
      "      ;;",
      "    -o)",
      "      output=\"$2\"",
      "      shift 2",
      "      ;;",
      "    *)",
      "      shift",
      "      ;;",
      "  esac",
      "done",
      "printf '# Illegal\\n' > \"$workspace/memory/sources/illegal.md\"",
      "printf 'done\\n' > \"$output\"",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(mocksynthesisPath, 0o755);

  const result = runAgentSynthesis(workspaceRoot, config, manifest);

  assert.equal(result.status, "rejected");
  assert.deepEqual(result.invalidPaths, ["memory/sources/illegal.md"]);
  assert.equal(fs.existsSync(path.join(workspaceRoot, "memory", "sources", "illegal.md")), false);
});

test("agent synthesis can update only allowed targets and copy them back", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();
  const mocksynthesisPath = path.join(workspaceRoot, "mock-agent-allowed.sh");
  config.synthesis = {
    args: ["-C", "{workspace}", "-o", "{output}", "{prompt}"],
    command: mocksynthesisPath,
    enabled: true,
    provider: "mock-agent",
    stdin: "none"
  };
  const rotation = rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW });
  const archiveIndexing = regenerateArchiveIndexes(workspaceRoot, config);
  const manifest = buildRunManifest(workspaceRoot, config, rotation, archiveIndexing, { now: FIXED_NOW, runId: "allowed-run" });

  fs.writeFileSync(
    mocksynthesisPath,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "workspace=''",
      "output=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in",
      "    -C)",
      "      workspace=\"$2\"",
      "      shift 2",
      "      ;;",
      "    -o)",
      "      output=\"$2\"",
      "      shift 2",
      "      ;;",
      "    *)",
      "      shift",
      "      ;;",
      "  esac",
      "done",
      "mkdir -p \"$workspace/memory/summaries/2026\"",
      "printf '# Index\\n' > \"$workspace/memory/index.md\"",
      "printf '# Summary\\n' > \"$workspace/memory/summaries/2026/2026-Q2.md\"",
      "printf 'done\\n' > \"$output\"",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(mocksynthesisPath, 0o755);

  const result = runAgentSynthesis(workspaceRoot, config, manifest);

  assert.equal(result.status, "applied");
  assert.deepEqual(result.changedPaths.sort(), ["memory/index.md", "memory/summaries/2026/2026-Q2.md"]);
  assert.equal(fs.readFileSync(path.join(workspaceRoot, "memory", "index.md"), "utf8"), "# Index\n");
  assert.equal(
    fs.readFileSync(path.join(workspaceRoot, "memory", "summaries", "2026", "2026-Q2.md"), "utf8"),
    "# Summary\n"
  );
});

test("agent synthesis run uses configured command arguments", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();
  const mocksynthesisPath = path.join(workspaceRoot, "mock-agent-args.sh");
  config.synthesis = {
    args: ["-C", "{workspace}", "-o", "{output}", "--prompt", "{prompt}"],
    command: mocksynthesisPath,
    enabled: true,
    provider: "mock-agent",
    stdin: "none"
  };
  const rotation = rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW });
  const archiveIndexing = regenerateArchiveIndexes(workspaceRoot, config);
  const manifest = buildRunManifest(workspaceRoot, config, rotation, archiveIndexing, {
    now: FIXED_NOW,
    runId: "args-run"
  });
  fs.writeFileSync(
    mocksynthesisPath,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      "script_dir=\"$(cd \"$(dirname \"$0\")\" && pwd)\"",
      "printf '%s\\n' \"$@\" > \"$script_dir/mock-agent-args.txt\"",
      "workspace=''",
      "output=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  case \"$1\" in",
      "    -C)",
      "      workspace=\"$2\"",
      "      shift 2",
      "      ;;",
      "    -o)",
      "      output=\"$2\"",
      "      shift 2",
      "      ;;",
      "    *)",
      "      shift",
      "      ;;",
      "  esac",
      "done",
      "mkdir -p \"$workspace/memory/summaries/2026\"",
      "printf '# Index\\n' > \"$workspace/memory/index.md\"",
      "printf '# Summary\\n' > \"$workspace/memory/summaries/2026/2026-Q2.md\"",
      "printf 'done\\n' > \"$output\"",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(mocksynthesisPath, 0o755);

  const result = runAgentSynthesis(workspaceRoot, config, manifest);
  const argvLog = fs.readFileSync(path.join(workspaceRoot, "mock-agent-args.txt"), "utf8");

  assert.equal(result.status, "applied");
  assert.equal(result.metrics.provider, "mock-agent");
  assert.equal(result.metrics.command, mocksynthesisPath);
  assert.equal(result.metrics.tokenUsage.status, "unavailable");
  assert.equal(typeof result.metrics.durationMs, "number");
  assert.ok(result.metrics.promptChars > 0);
  assert.ok(result.metrics.promptWords > 0);
  assert.ok(argvLog.includes("-C\n"));
  assert.ok(argvLog.includes("-o\n"));
  assert.ok(argvLog.includes("--prompt\n"));
});

test("maintenance manifest and report include performance metrics", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();

  const result = runMaintenance(workspaceRoot, config, "maintain", {
    dryRun: true,
    now: FIXED_NOW,
    startedAt: "2026-04-23T00:00:00.000Z"
  });
  const report = renderRunReport(result.manifest, result.synthesisStatus, true);

  assert.equal(result.manifest.performance.startedAt, "2026-04-23T00:00:00.000Z");
  assert.equal(result.manifest.performance.synthesis.provider, "none");
  assert.equal(result.manifest.performance.synthesis.tokenUsage.status, "unavailable");
  assert.match(report, /## Performance/);
  assert.match(report, /Synthesis provider: `none`/);
  assert.match(report, /Token usage: unavailable/);
});

test("missing synthesis binary fails with a clear error", () => {
  const workspaceRoot = makeTempWorkspace();
  writeManagedLogs(workspaceRoot);
  const config = loadConfig();
  config.synthesis = {
    args: [],
    command: "definitely-missing-synthesis-binary",
    enabled: true,
    provider: "missing-agent",
    stdin: "none"
  };
  const rotation = rotateManagedLogs(workspaceRoot, config, { now: FIXED_NOW });
  const archiveIndexing = regenerateArchiveIndexes(workspaceRoot, config);
  const manifest = buildRunManifest(workspaceRoot, config, rotation, archiveIndexing, {
    now: FIXED_NOW,
    runId: "missing-synthesis"
  });

  assert.throws(
    () => runAgentSynthesis(workspaceRoot, config, manifest),
    /Synthesis command failed to start/
  );
});

test("diffSnapshots reports created modified and deleted files", () => {
  const before = new Map([
    ["a.md", "before"],
    ["b.md", "same"]
  ]);
  const after = new Map([
    ["b.md", "same"],
    ["c.md", "after"]
  ]);

  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff, [
    { path: "a.md", type: "deleted" },
    { path: "c.md", type: "created" }
  ]);
});
