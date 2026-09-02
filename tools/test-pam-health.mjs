import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCatalog } from "./memory-graph.mjs";
import { collectPamHealth } from "./lib/pam-health.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-agent-memory-health-"));
  fs.mkdirSync(path.join(root, "docs", "agent-memory", "graph"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "benchmarks"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Workspace routing.\n", "utf8");
  fs.writeFileSync(path.join(root, "docs", "daily.md"), "Daily procedure.\n", "utf8");
  fs.writeFileSync(path.join(root, "docs", "unclassified.md"), "Needs registration.\n", "utf8");
  fs.writeFileSync(
    path.join(root, "docs", "agent-memory", "graph", "nodes.jsonl"),
    `${JSON.stringify({ id: "workflow:daily", k: "workflow", n: "Daily", d: "Daily workflow.", st: "confirmed", c: "high", u: "2026-08-21", src: "docs/daily.md" })}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(root, "docs", "agent-memory", "graph", "edges.jsonl"), "", "utf8");
  fs.writeFileSync(
    path.join(root, "docs", "agent-memory", "graph", "aliases.jsonl"),
    `${JSON.stringify({ a: "daily", id: "workflow:daily" })}\n`,
    "utf8"
  );
  const graphDir = "docs/agent-memory/graph";
  fs.writeFileSync(
    path.join(root, graphDir, "catalog.json"),
    `${JSON.stringify(buildCatalog(root, { graphDir, generatedAt: "2026-08-21T00:00:00.000Z" }))}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "docs", "agent-memory", "pam.version.json"),
    JSON.stringify({ pamVersion: "0.6.4", graphSchemaVersion: "pam-graph-v1", updated: "2026-08-21" }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "docs", "benchmarks", "scenarios.json"),
    JSON.stringify({ version: 1, name: "fixture", queries: [{ q: "daily", expectedId: "workflow:daily", domain: "daily" }] }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "docs", "agent-memory", "source-registry.json"),
    JSON.stringify({ version: 1, sources: [{ path: "docs/daily.md" }], scanRoots: ["docs"], excluded: [{ pattern: "docs/agent-memory/**", reason: "PAM control files" }, { pattern: "docs/benchmarks/**", reason: "test data" }] }),
    "utf8"
  );
  return root;
}

function options(root) {
  return {
    graphDir: "docs/agent-memory/graph",
    versionPath: "docs/agent-memory/pam.version.json",
    scenario: "docs/benchmarks/scenarios.json",
    sourceRegistry: "docs/agent-memory/source-registry.json",
    corpusEntrypoints: ["AGENTS.md"],
    corpusRoots: ["docs"],
    now: "2026-08-21T12:00:00.000Z"
  };
}

test("PAM health supports a portable docs/agent-memory layout", () => {
  const root = fixture();
  try {
    const report = collectPamHealth(root, options(root));
    assert.equal(report.status, "ATTENTION");
    assert.equal(report.structural.status, "PASS");
    assert.equal(report.retrieval.status, "PASS");
    assert.equal(report.coverage.status, "ATTENTION");
    assert.equal(report.coverage.unclassifiedSourceCount, 1);
    assert.equal(report.retrieval.scenarioCount, 1);
    assert.equal(JSON.stringify(report).includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PAM health blocks invalid lifecycle values and stale registered-source projections", () => {
  const root = fixture();
  try {
    fs.writeFileSync(
      path.join(root, "docs", "agent-memory", "graph", "nodes.jsonl"),
      `${JSON.stringify({ id: "workflow:daily", k: "workflow", n: "Daily", d: "Daily workflow.", st: "invalid", c: "high", u: "2026-08-01", src: "docs/daily.md" })}\n`,
      "utf8"
    );
    const report = collectPamHealth(root, options(root));
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.structural.status, "BLOCKED");
    assert.ok(report.structural.errors.some((error) => error.includes("invalid lifecycle")));
    assert.equal(report.coverage.changedRegisteredSourceCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PAM health supports explicit age and append-only freshness exemptions", () => {
  const root = fixture();
  try {
    const registryPath = path.join(root, "docs", "agent-memory", "source-registry.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    registry.sources[0].freshness = { maxAgeDays: null, trackSourceChanges: false };
    fs.writeFileSync(registryPath, JSON.stringify(registry), "utf8");
    fs.writeFileSync(
      path.join(root, "docs", "agent-memory", "graph", "nodes.jsonl"),
      `${JSON.stringify({ id: "workflow:daily", k: "workflow", n: "Daily", d: "Daily workflow.", st: "confirmed", c: "high", u: "2020-01-01", src: "docs/daily.md" })}\n`,
      "utf8"
    );
    const report = collectPamHealth(root, options(root));
    assert.equal(report.freshness.staleNodeCount, 0);
    assert.equal(report.freshness.sourceNewerThanNodeCount, 0);
    assert.equal(report.freshness.ageExemptNodeCount, 1);
    assert.equal(report.freshness.mtimeExemptSourceCount, 1);
    assert.equal(report.coverage.changedRegisteredSourceCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PAM health uses a registered source digest instead of filesystem mtime", () => {
  const root = fixture();
  try {
    const sourcePath = path.join(root, "docs", "daily.md");
    const registryPath = path.join(root, "docs", "agent-memory", "source-registry.json");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    registry.sources[0].sha256 = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
    fs.writeFileSync(registryPath, JSON.stringify(registry), "utf8");
    const future = new Date("2026-08-22T00:00:00.000Z");
    fs.utimesSync(sourcePath, future, future);
    let report = collectPamHealth(root, options(root));
    assert.equal(report.freshness.sourceNewerThanNodeCount, 0);
    assert.equal(report.coverage.changedRegisteredSourceCount, 0);

    fs.appendFileSync(sourcePath, "A durable change.\n", "utf8");
    report = collectPamHealth(root, options(root));
    assert.equal(report.freshness.sourceNewerThanNodeCount, 1);
    assert.equal(report.coverage.changedRegisteredSourceCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
