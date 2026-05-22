import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAudit } from "./lib/memory-audit.mjs";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-audit-test-"));
  fs.mkdirSync(path.join(root, "memory", "graph"), { recursive: true });
  fs.mkdirSync(path.join(root, "memory", "agent-memory"), { recursive: true });
  fs.mkdirSync(path.join(root, "memory", "sources"), { recursive: true });

  fs.writeFileSync(
    path.join(root, "memory", "graph", "nodes.jsonl"),
    [
      '{"id":"project:pam","k":"project","n":"PAM","d":"Memory toolkit.","st":"confirmed","c":"high","u":"2026-05-05","src":"README.md"}',
      '{"id":"doc:runtime","k":"doc","n":"Runtime","d":"Runtime guide.","st":"confirmed","c":"high","u":"2026-05-05","src":"memory/agent-memory/pam-runtime.md"}'
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "edges.jsonl"),
    '{"f":"project:pam","r":"has-doc","t":"doc:runtime","st":"confirmed","c":"high","u":"2026-05-05","src":"README.md"}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "aliases.jsonl"),
    '{"a":"PAM","id":"project:pam"}\n',
    "utf8"
  );
  fs.writeFileSync(path.join(root, "memory", "agent-memory", "pam-runtime.md"), "# Runtime\n\nRuntime guide.\n", "utf8");
  fs.writeFileSync(path.join(root, "memory", "index.md"), "# Index\n\n- [runtime](agent-memory/pam-runtime.md)\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# Project\n", "utf8");
  return root;
}

function defaultConfig() {
  return {
    retentionDays: 90,
    archiveRoot: "memory/archive",
    summariesRoot: "memory/summaries",
    maintenanceRoot: "memory/maintenance",
    managedLogs: [
      { source: "memory/conversation-log.md", archiveKey: "conversation-log", activeEntryLimit: 80 },
      { source: "memory/knowledge-log.md", archiveKey: "knowledge-log", activeEntryLimit: 120 }
    ],
    protectedPaths: ["AGENTS.md", "CLAUDE.md", "memory/agent-memory", "memory/sources"]
  };
}

test("audit returns no findings on a clean workspace", () => {
  const root = makeWorkspace();
  const result = runAudit(root, defaultConfig(), { checks: ["dangling-alias", "graph-source-link-rot", "oversized-digest"] });
  assert.equal(result.findings.length, 0);
});

test("audit flags duplicate-knowledge-entry on near-identical sections", () => {
  const root = makeWorkspace();
  const logPath = path.join(root, "memory", "knowledge-log.md");
  fs.writeFileSync(
    logPath,
    [
      "# Knowledge Log",
      "",
      "## 2026-04-12 - Worker retries",
      "",
      "We confirmed that the worker uses five retries per upstream timeout failure.",
      "",
      "## 2026-04-13 - Worker retries",
      "",
      "We confirmed that the worker uses five retries per upstream timeout failure.",
      ""
    ].join("\n"),
    "utf8"
  );
  const result = runAudit(root, defaultConfig(), { checks: ["duplicate-knowledge-entry"] });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].check, "duplicate-knowledge-entry");
  assert.equal(result.findings[0].severity, "warning");
});

test("audit flags link-rot for missing markdown link targets", () => {
  const root = makeWorkspace();
  fs.writeFileSync(
    path.join(root, "memory", "index.md"),
    "# Index\n\n- [missing](does-not-exist.md)\n",
    "utf8"
  );
  const result = runAudit(root, defaultConfig(), { checks: ["link-rot"] });
  assert.ok(result.findings.some((f) => f.check === "link-rot"));
});

test("audit flags graph-source-link-rot for missing src files", () => {
  const root = makeWorkspace();
  fs.appendFileSync(
    path.join(root, "memory", "graph", "nodes.jsonl"),
    '{"id":"doc:ghost","k":"doc","n":"Ghost","d":"x","st":"confirmed","c":"low","u":"2026-05-05","src":"memory/does-not-exist.md"}\n',
    "utf8"
  );
  const result = runAudit(root, defaultConfig(), { checks: ["graph-source-link-rot"] });
  assert.ok(result.findings.some((f) => f.check === "graph-source-link-rot"));
});

test("audit flags rotation-candidate when activeEntryLimit exceeded", () => {
  const root = makeWorkspace();
  const config = defaultConfig();
  config.managedLogs[0].activeEntryLimit = 2;
  const lines = ["# Conversation Log", ""];
  for (let i = 0; i < 4; i += 1) {
    const day = String(i + 1).padStart(2, "0");
    lines.push(`## 2026-05-${day} - Session ${i}`, "", `Notes from session ${i}.`, "");
  }
  fs.writeFileSync(path.join(root, "memory", "conversation-log.md"), lines.join("\n"), "utf8");
  const result = runAudit(root, config, { checks: ["rotation-candidate"] });
  assert.ok(result.findings.some((f) => f.check === "rotation-candidate"));
});

test("audit flags oversized-digest when within 90-100% of cap", () => {
  const root = makeWorkspace();
  const longDigest = "x".repeat(170);
  fs.appendFileSync(
    path.join(root, "memory", "graph", "nodes.jsonl"),
    `{"id":"doc:long","k":"doc","n":"Long","d":"${longDigest}","st":"confirmed","c":"low","u":"2026-05-05","src":"README.md"}\n`,
    "utf8"
  );
  const result = runAudit(root, defaultConfig(), { checks: ["oversized-digest"] });
  assert.ok(result.findings.some((f) => f.check === "oversized-digest"));
});

test("audit flags orphan-source for files in memory/sources/ not referenced in graph", () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "memory", "sources", "leftover.md"), "stray file\n", "utf8");
  const result = runAudit(root, defaultConfig(), { checks: ["orphan-source"] });
  assert.ok(result.findings.some((f) => f.check === "orphan-source"));
});

test("audit groups findings into summary buckets", () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "memory", "sources", "leftover.md"), "stray\n", "utf8");
  const result = runAudit(root, defaultConfig());
  assert.ok(result.summary.byCheck);
  assert.ok(result.summary.bySeverity);
  assert.equal(typeof result.summary.bySeverity.info, "number");
});
