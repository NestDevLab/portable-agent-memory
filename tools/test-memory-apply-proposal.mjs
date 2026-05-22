import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyProposal } from "./lib/memory-apply-proposal.mjs";
import { proposeEdit } from "./lib/memory-proposals.mjs";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-apply-test-"));
  fs.mkdirSync(path.join(root, "memory", "graph"), { recursive: true });
  fs.mkdirSync(path.join(root, "memory", "agent-memory"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "memory", "knowledge-log.md"),
    "# Knowledge Log\n\n## 2026-04-12 - Worker retries\n\nFive retries.\n",
    "utf8"
  );
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
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n", "utf8");
  return root;
}

function defaultConfig() {
  return {
    protectedPaths: ["AGENTS.md", "CLAUDE.md", "memory/agent-memory", "memory/sources"]
  };
}

function recordProposal(root, args) {
  const result = proposeEdit(root, defaultConfig(), args);
  if (!result.ok) throw new Error(`could not seed proposal: ${result.error}`);
  return result.proposalId;
}

test("applyProposal applies a recorded replace op and archives the artifact", () => {
  const root = makeWorkspace();
  const proposalId = recordProposal(root, {
    path: "memory/knowledge-log.md",
    rationale: "tighten",
    diff: {
      kind: "replace",
      anchor: { headerLine: "## 2026-04-12 - Worker retries" },
      before: "## 2026-04-12 - Worker retries\n\nFive retries.\n",
      after: "## 2026-04-12 - Worker retries\n\nFive retries per upstream timeout.\n"
    }
  });
  const result = applyProposal(root, defaultConfig(), { proposalId });
  assert.equal(result.ok, true);
  assert.equal(result.status, "applied");
  const target = fs.readFileSync(path.join(root, "memory", "knowledge-log.md"), "utf8");
  assert.ok(target.includes("Five retries per upstream timeout."));
  const archived = JSON.parse(fs.readFileSync(path.join(root, result.proposalArchivedAs), "utf8"));
  assert.equal(archived.status, "applied");
  assert.ok(archived.appliedAt);
  assert.equal(fs.existsSync(path.join(root, "memory", "maintenance", "proposals", `${proposalId}.json`)), false);
});

test("applyProposal rejects when the target has drifted since recording", () => {
  const root = makeWorkspace();
  const proposalId = recordProposal(root, {
    path: "memory/knowledge-log.md",
    rationale: "tighten",
    diff: {
      kind: "replace",
      anchor: { headerLine: "## 2026-04-12 - Worker retries" },
      before: "## 2026-04-12 - Worker retries\n\nFive retries.\n",
      after: "## 2026-04-12 - Worker retries\n\nFive retries per upstream timeout.\n"
    }
  });
  fs.writeFileSync(
    path.join(root, "memory", "knowledge-log.md"),
    "# Knowledge Log\n\n## 2026-04-12 - Worker retries\n\nTotally different content.\n",
    "utf8"
  );
  const result = applyProposal(root, defaultConfig(), { proposalId });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match|not found/i);
  assert.ok(fs.existsSync(path.join(root, "memory", "maintenance", "proposals", `${proposalId}.json`)));
});

test("applyProposal rejects a hand-crafted proposal that targets a protected path", () => {
  const root = makeWorkspace();
  const proposalsDir = path.join(root, "memory", "maintenance", "proposals");
  fs.mkdirSync(proposalsDir, { recursive: true });
  const proposalId = "hand-crafted-1";
  const record = {
    proposalId,
    createdAt: new Date().toISOString(),
    source: "manual",
    targetPath: "AGENTS.md",
    diff: { kind: "replace", before: "# Agents\n", after: "# Hacked\n" },
    rationale: "should be rejected",
    findingIds: []
  };
  fs.writeFileSync(path.join(proposalsDir, `${proposalId}.json`), JSON.stringify(record), "utf8");
  const result = applyProposal(root, defaultConfig(), { proposalId });
  assert.equal(result.ok, false);
  assert.match(result.error, /protected/i);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# Agents\n");
});

test("applyProposal rejects unknown proposal ids", () => {
  const root = makeWorkspace();
  const result = applyProposal(root, defaultConfig(), { proposalId: "does-not-exist" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
});

test("applyProposal rejects proposalId containing path separators", () => {
  const root = makeWorkspace();
  const result = applyProposal(root, defaultConfig(), { proposalId: "../sneaky" });
  assert.equal(result.ok, false);
  assert.match(result.error, /path separator|not found/i);
});

test("applyProposal applies a unified-diff proposal", () => {
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
  const proposalId = recordProposal(root, {
    path: "memory/knowledge-log.md",
    rationale: "tighten",
    diff: { kind: "unified-diff", patch }
  });
  const result = applyProposal(root, defaultConfig(), { proposalId });
  assert.equal(result.ok, true);
  const target = fs.readFileSync(path.join(root, "memory", "knowledge-log.md"), "utf8");
  assert.ok(target.includes("Five retries per upstream timeout."));
});
