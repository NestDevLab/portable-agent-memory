import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCatalog,
  collectFileOnlyCoverage,
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

test("file-only coverage measures graph-first read volume without raw source text", () => {
  const root = makeGraphWorkspace();
  fs.mkdirSync(path.join(root, "benchmarks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "memory", "pam.version.json"),
    '{"pamVersion":"0.4.0","memoryFormat":"graph-v1","graphSchemaVersion":"pam-graph-v1"}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "catalog.json"),
    JSON.stringify(buildCatalog(root, { generatedAt: "2026-05-05T00:00:00.000Z" })) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "README.md"),
    "Portable Agent Memory test corpus.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "AGENT_BOOTSTRAP.md"),
    "Bootstrap instructions for tests.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "benchmarks", "file-only-coverage.json"),
    JSON.stringify({
      queries: [
        {
          q: "PAM",
          expectedId: "project:pam"
        }
      ]
    }) + "\n",
    "utf8"
  );

  const coverage = collectFileOnlyCoverage(root, {
    scenario: "benchmarks/file-only-coverage.json",
    generatedAt: "2026-05-05T00:00:00.000Z"
  });
  const serialized = JSON.stringify(coverage);

  assert.equal(coverage.summary.ok, true);
  assert.equal(coverage.summary.blockedCount, 0);
  assert.equal(coverage.privacy.rawTextIncluded, false);
  assert.equal(coverage.readVolume.pamFirstCore.fileCount, 5);
  assert.ok(coverage.readVolume.pamFirstCore.bytes > 0);
  assert.ok(!serialized.includes(root));
  assert.ok(!serialized.includes("Portable Agent Memory test corpus."));
});

test("file-only coverage classifies missing expected nodes as blocked", () => {
  const root = makeGraphWorkspace();
  fs.mkdirSync(path.join(root, "benchmarks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "memory", "pam.version.json"),
    '{"pamVersion":"0.4.0","memoryFormat":"graph-v1","graphSchemaVersion":"pam-graph-v1"}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "catalog.json"),
    JSON.stringify(buildCatalog(root, { generatedAt: "2026-05-05T00:00:00.000Z" })) + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "README.md"), "Portable Agent Memory test corpus.\n", "utf8");
  fs.writeFileSync(path.join(root, "AGENT_BOOTSTRAP.md"), "Bootstrap instructions for tests.\n", "utf8");
  fs.writeFileSync(
    path.join(root, "benchmarks", "file-only-coverage.json"),
    JSON.stringify({
      queries: [
        {
          q: "unknown operational state",
          expectedId: "state:missing"
        }
      ]
    }) + "\n",
    "utf8"
  );

  const coverage = collectFileOnlyCoverage(root, {
    scenario: "benchmarks/file-only-coverage.json",
    generatedAt: "2026-05-05T00:00:00.000Z"
  });

  assert.equal(coverage.summary.ok, false);
  assert.equal(coverage.summary.blockedCount, 1);
  assert.equal(coverage.results[0].status, "BLOCKED");
});

test("file-only coverage blocks matched nodes with missing source files", () => {
  const root = makeGraphWorkspace();
  fs.mkdirSync(path.join(root, "benchmarks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "memory", "pam.version.json"),
    '{"pamVersion":"0.4.0","memoryFormat":"graph-v1","graphSchemaVersion":"pam-graph-v1"}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "catalog.json"),
    JSON.stringify(buildCatalog(root, { generatedAt: "2026-05-05T00:00:00.000Z" })) + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "README.md"), "Portable Agent Memory test corpus.\n", "utf8");
  fs.writeFileSync(path.join(root, "AGENT_BOOTSTRAP.md"), "Bootstrap instructions for tests.\n", "utf8");
  fs.writeFileSync(
    path.join(root, "benchmarks", "file-only-coverage.json"),
    JSON.stringify({
      queries: [
        {
          q: "graph cli",
          expectedId: "tool:graph"
        }
      ]
    }) + "\n",
    "utf8"
  );

  const coverage = collectFileOnlyCoverage(root, {
    scenario: "benchmarks/file-only-coverage.json",
    generatedAt: "2026-05-05T00:00:00.000Z"
  });

  assert.equal(coverage.summary.ok, false);
  assert.equal(coverage.summary.blockedCount, 1);
  assert.equal(coverage.summary.missingSourceCount, 1);
  assert.equal(coverage.summary.sourceFilesOk, false);
  assert.equal(coverage.results[0].status, "BLOCKED");
  assert.deepEqual(coverage.results[0].sourceRead.missingFiles, ["tools/memory-graph.mjs"]);
});

test("file-only coverage reads returned candidate sources instead of expected target sources", () => {
  const root = makeGraphWorkspace();
  fs.mkdirSync(path.join(root, "benchmarks"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "memory", "pam.version.json"),
    '{"pamVersion":"0.4.0","memoryFormat":"graph-v1","graphSchemaVersion":"pam-graph-v1"}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "catalog.json"),
    JSON.stringify(buildCatalog(root, { generatedAt: "2026-05-05T00:00:00.000Z" })) + "\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "README.md"), "Portable Agent Memory test corpus.\n", "utf8");
  fs.writeFileSync(path.join(root, "AGENT_BOOTSTRAP.md"), "Bootstrap instructions for tests.\n", "utf8");
  fs.writeFileSync(path.join(root, "tools", "memory-graph.mjs"), "console.log('graph cli');\n", "utf8");
  fs.writeFileSync(
    path.join(root, "benchmarks", "file-only-coverage.json"),
    JSON.stringify({
      queries: [
        {
          q: "graph cli",
          expectedId: "project:pam"
        }
      ]
    }) + "\n",
    "utf8"
  );

  const coverage = collectFileOnlyCoverage(root, {
    scenario: "benchmarks/file-only-coverage.json",
    generatedAt: "2026-05-05T00:00:00.000Z"
  });

  assert.equal(coverage.summary.ok, false);
  assert.equal(coverage.results[0].status, "BLOCKED");
  assert.equal(coverage.results[0].topId, "tool:graph");
  assert.equal(coverage.results[0].sourceRead.files[0].path, "tools/memory-graph.mjs");
});
