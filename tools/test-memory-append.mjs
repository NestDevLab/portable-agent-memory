import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendEntry } from "./lib/memory-append.mjs";
import { parseLogSections } from "./memory-maintenance.mjs";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-append-test-"));
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "memory", "knowledge-log.md"),
    [
      "# Knowledge Log",
      "",
      "Intro paragraph describing the log purpose.",
      "",
      "## 2026-04-12 - Existing entry",
      "",
      "Existing body.",
      ""
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "conversation-log.md"),
    "# Conversation Log\n\nIntro line.\n",
    "utf8"
  );
  return root;
}

function defaultConfig() {
  return {
    managedLogs: [
      { source: "memory/conversation-log.md", archiveKey: "conversation-log", activeEntryLimit: 80 },
      { source: "memory/knowledge-log.md", archiveKey: "knowledge-log", activeEntryLimit: 120 }
    ]
  };
}

test("appendEntry adds a dated section recognized by parseLogSections", () => {
  const root = makeWorkspace();
  const result = appendEntry(root, defaultConfig(), {
    log: "knowledge-log",
    date: "2026-05-21",
    headerTitle: "New durable fact",
    body: "Confirmed facts:\n- example.\n"
  });
  assert.equal(result.ok, true);
  assert.equal(result.anchor, "## 2026-05-21 - New durable fact");
  const content = fs.readFileSync(path.join(root, "memory", "knowledge-log.md"), "utf8");
  const { sections } = parseLogSections(content);
  const newSection = sections.find((s) => s.headerLine === "## 2026-05-21 - New durable fact");
  assert.ok(newSection);
  assert.equal(newSection.kind, "dated");
});

test("appendEntry defaults date to today UTC", () => {
  const root = makeWorkspace();
  const result = appendEntry(root, defaultConfig(), {
    log: "conversation-log",
    headerTitle: "Session",
    body: "Notes."
  });
  assert.equal(result.ok, true);
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(result.anchor.startsWith(`## ${today} - `));
});

test("appendEntry rejects an unknown log", () => {
  const root = makeWorkspace();
  const result = appendEntry(root, defaultConfig(), {
    log: "custom-log",
    headerTitle: "x",
    body: "y"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not declared/i);
});

test("appendEntry rejects empty headerTitle", () => {
  const root = makeWorkspace();
  const result = appendEntry(root, defaultConfig(), {
    log: "knowledge-log",
    headerTitle: "",
    body: "y"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /headerTitle/i);
});

test("appendEntry rejects malformed date", () => {
  const root = makeWorkspace();
  const result = appendEntry(root, defaultConfig(), {
    log: "knowledge-log",
    date: "21-05-2026",
    headerTitle: "x",
    body: "y"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /YYYY-MM-DD/i);
});

test("appendEntry inserts new section between prefix and existing dated section", () => {
  const root = makeWorkspace();
  const result = appendEntry(root, defaultConfig(), {
    log: "knowledge-log",
    date: "2026-05-21",
    headerTitle: "Newer",
    body: "Newer body."
  });
  assert.equal(result.ok, true);
  const content = fs.readFileSync(path.join(root, "memory", "knowledge-log.md"), "utf8");
  const newerIdx = content.indexOf("## 2026-05-21 - Newer");
  const olderIdx = content.indexOf("## 2026-04-12 - Existing entry");
  assert.ok(newerIdx >= 0 && olderIdx > newerIdx, "newer entry should precede older entry");
  assert.ok(content.indexOf("Intro paragraph") < newerIdx, "intro prefix should precede the new entry");
});

test("appendEntry rejects when target file does not exist", () => {
  const root = makeWorkspace();
  fs.rmSync(path.join(root, "memory", "knowledge-log.md"));
  const result = appendEntry(root, defaultConfig(), {
    log: "knowledge-log",
    headerTitle: "x",
    body: "y"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not exist/i);
});

test("appendEntry rejects writes to protected paths", () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n", "utf8");
  const maliciousConfig = {
    managedLogs: [
      { source: "AGENTS.md", archiveKey: "agents", activeEntryLimit: 80 }
    ],
    protectedPaths: ["AGENTS.md", "memory/agent-memory", "memory/sources"]
  };
  const result = appendEntry(root, maliciousConfig, {
    log: "agents",
    headerTitle: "x",
    body: "y"
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /protected/i);
});
