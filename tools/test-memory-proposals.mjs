import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { proposeEdit } from "./lib/memory-proposals.mjs";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-proposals-test-"));
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
  fs.writeFileSync(
    path.join(root, "memory", "knowledge-log.md"),
    "# Knowledge Log\n\n## 2026-04-12 - Worker retries\n\nFive retries.\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n", "utf8");
  fs.writeFileSync(path.join(root, "memory", "agent-memory", "pam.md"), "# PAM\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# Project\n", "utf8");
  return root;
}

function defaultConfig() {
  return {
    protectedPaths: ["AGENTS.md", "CLAUDE.md", "memory/agent-memory", "memory/sources"]
  };
}

test("proposeEdit records a valid replace op against a managed log", () => {
  const root = makeWorkspace();
  const result = proposeEdit(root, defaultConfig(), {
    path: "memory/knowledge-log.md",
    rationale: "Tighten phrasing.",
    findingIds: ["audit-2026-05-21-0001-duplicate-knowledge-entry"],
    diff: {
      kind: "replace",
      anchor: { headerLine: "## 2026-04-12 - Worker retries" },
      before: "## 2026-04-12 - Worker retries\n\nFive retries.\n",
      after: "## 2026-04-12 - Worker retries\n\nFive retries per upstream timeout.\n"
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "recorded");
  assert.ok(fs.existsSync(path.join(root, result.proposalPath)));
  const original = fs.readFileSync(path.join(root, "memory", "knowledge-log.md"), "utf8");
  assert.ok(original.includes("Five retries.\n"), "original file is not mutated");
});

test("proposeEdit rejects edits to AGENTS.md (protected)", () => {
  const root = makeWorkspace();
  const result = proposeEdit(root, defaultConfig(), {
    path: "AGENTS.md",
    rationale: "should be rejected",
    diff: { kind: "replace", before: "# Agents\n", after: "# Different\n" }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /protected/i);
});

test("proposeEdit rejects edits inside memory/agent-memory/", () => {
  const root = makeWorkspace();
  const result = proposeEdit(root, defaultConfig(), {
    path: "memory/agent-memory/pam.md",
    rationale: "should be rejected",
    diff: { kind: "replace", before: "# PAM\n", after: "# Different\n" }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /protected/i);
});

test("proposeEdit rejects path escapes outside workspace", () => {
  const root = makeWorkspace();
  const result = proposeEdit(root, defaultConfig(), {
    path: "../etc/passwd",
    rationale: "no",
    diff: { kind: "replace", before: "x", after: "y" }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /escape|protected/i);
});

test("proposeEdit rejects when before content does not match", () => {
  const root = makeWorkspace();
  const result = proposeEdit(root, defaultConfig(), {
    path: "memory/knowledge-log.md",
    rationale: "stale before",
    diff: {
      kind: "replace",
      anchor: { headerLine: "## 2026-04-12 - Worker retries" },
      before: "wrong content",
      after: "right content"
    }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found|does not match/i);
});

test("proposeEdit rejects JSONL edits that produce dangling edges", () => {
  const root = makeWorkspace();
  const original = fs.readFileSync(path.join(root, "memory", "graph", "edges.jsonl"), "utf8");
  const broken = original.replace("doc:runtime", "doc:missing");
  const result = proposeEdit(root, defaultConfig(), {
    path: "memory/graph/edges.jsonl",
    rationale: "stale ref",
    diff: { kind: "replace", before: original, after: broken }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Dangling edge|validation/i);
});

test("proposeEdit accepts a well-formed unified diff", () => {
  const root = makeWorkspace();
  const patch = [
    "--- a/memory/knowledge-log.md",
    "+++ b/memory/knowledge-log.md",
    "@@ -3,3 +3,3 @@",
    " ## 2026-04-12 - Worker retries",
    " ",
    "-Five retries.",
    "+Five retries per upstream timeout."
  ].join("\n") + "\n";
  const result = proposeEdit(root, defaultConfig(), {
    path: "memory/knowledge-log.md",
    rationale: "tighten",
    diff: { kind: "unified-diff", patch }
  });
  assert.equal(result.ok, true);
});

test("proposeEdit rejects diffs over the size cap", () => {
  const root = makeWorkspace();
  const huge = "x".repeat(70_000);
  const result = proposeEdit(root, defaultConfig(), {
    path: "memory/knowledge-log.md",
    rationale: "oversized",
    diff: { kind: "replace", before: "Five retries.", after: huge }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeds/i);
});
