import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCatalog,
  loadGraph,
  queryGraph,
  validateGraph
} from "./memory-graph.mjs";

function makeGraphWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-agent-memory-graph-test-"));
  fs.mkdirSync(path.join(root, "memory", "graph"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "memory", "graph", "nodes.jsonl"),
    [
      '{"id":"project:pam","k":"project","n":"Portable Agent Memory","d":"Compact memory toolkit.","st":"confirmed","c":"high","u":"2026-05-05","src":"README.md"}',
      '{"id":"tool:graph","k":"tool","n":"Graph CLI","d":"Validates and queries graph memory.","st":"confirmed","c":"high","u":"2026-05-05","src":"tools/memory-graph.mjs"}'
    ].join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "edges.jsonl"),
    '{"f":"project:pam","r":"has-tool","t":"tool:graph","st":"confirmed","c":"high","u":"2026-05-05","src":"package.json"}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "aliases.jsonl"),
    '{"a":"PAM","id":"project:pam"}\n',
    "utf8"
  );
  return root;
}

test("graph validates canonical JSONL records", () => {
  const root = makeGraphWorkspace();
  const result = validateGraph(loadGraph(root));
  assert.equal(result.ok, true);
});

test("graph validation catches duplicate node ids", () => {
  const root = makeGraphWorkspace();
  fs.appendFileSync(
    path.join(root, "memory", "graph", "nodes.jsonl"),
    '{"id":"project:pam","k":"project","n":"Duplicate","d":"Duplicate id.","st":"confirmed","c":"high","u":"2026-05-05","src":"README.md"}\n'
  );
  const result = validateGraph(loadGraph(root));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("Duplicate node id")));
});

test("graph validation catches dangling edges and aliases", () => {
  const root = makeGraphWorkspace();
  fs.writeFileSync(
    path.join(root, "memory", "graph", "edges.jsonl"),
    '{"f":"project:pam","r":"missing","t":"missing:node","st":"confirmed","c":"high","u":"2026-05-05","src":"README.md"}\n'
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "aliases.jsonl"),
    '{"a":"missing","id":"missing:node"}\n'
  );
  const result = validateGraph(loadGraph(root));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("Dangling edge target")));
  assert.ok(result.errors.some((error) => error.includes("Alias target missing")));
});

test("graph query resolves aliases and returns one-hop relations", () => {
  const root = makeGraphWorkspace();
  const result = queryGraph(loadGraph(root), { query: "PAM" });
  assert.equal(result.aliasResolvedTo, "project:pam");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].edges[0].r, "has-tool");
});

test("graph catalog reports counts and health", () => {
  const root = makeGraphWorkspace();
  const catalog = buildCatalog(root, { generatedAt: "2026-05-05T00:00:00.000Z" });
  assert.equal(catalog.nodeCount, 2);
  assert.equal(catalog.edgeCount, 1);
  assert.equal(catalog.aliasCount, 1);
  assert.equal(catalog.health.status, "valid");
});
