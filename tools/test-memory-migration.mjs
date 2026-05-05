import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectMemoryState } from "./memory-migration.mjs";

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portable-agent-memory-migration-test-"));
}

function writeMarkdownMemory(root) {
  fs.mkdirSync(path.join(root, "memory", "agent-memory"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory", "index.md"), "# Memory Index\n");
  fs.writeFileSync(path.join(root, "memory", "conversation-log.md"), "# Conversation Log\n");
  fs.writeFileSync(path.join(root, "memory", "knowledge-log.md"), "# Knowledge Log\n");
  fs.writeFileSync(path.join(root, "memory", "agent-memory", "pam.md"), "# PAM\n");
}

function writeValidGraph(root) {
  fs.mkdirSync(path.join(root, "memory", "graph"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory", "pam.version.json"), '{"memoryFormat":"graph-v1"}\n');
  fs.writeFileSync(path.join(root, "memory", "graph", "catalog.json"), '{"schemaVersion":"pam-graph-v1"}\n');
  fs.writeFileSync(
    path.join(root, "memory", "graph", "nodes.jsonl"),
    '{"id":"project:pam","k":"project","n":"PAM","d":"Memory toolkit.","st":"confirmed","c":"high","u":"2026-05-05","src":"README.md"}\n'
  );
  fs.writeFileSync(path.join(root, "memory", "graph", "edges.jsonl"), "");
  fs.writeFileSync(path.join(root, "memory", "graph", "aliases.jsonl"), '{"a":"PAM","id":"project:pam"}\n');
}

test("detects explicit graph-v1 state when metadata and graph validate", () => {
  const root = makeWorkspace();
  writeMarkdownMemory(root);
  writeValidGraph(root);
  assert.equal(detectMemoryState(root).state, "graph-v1");
});

test("detects markdown-v0 when legacy markdown exists without explicit version", () => {
  const root = makeWorkspace();
  writeMarkdownMemory(root);
  assert.equal(detectMemoryState(root).state, "markdown-v0");
});

test("detects partial state when graph metadata exists but graph is incomplete", () => {
  const root = makeWorkspace();
  writeMarkdownMemory(root);
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, "memory", "pam.version.json"), '{"memoryFormat":"graph-v1"}\n');
  assert.equal(detectMemoryState(root).state, "partial");
});

test("detects unknown state for unrelated workspaces", () => {
  const root = makeWorkspace();
  assert.equal(detectMemoryState(root).state, "unknown");
});
