import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMigrationPath,
  checkMigrations,
  incrementIsValid,
  isMigrationSensitive,
  parseSemverMigrations
} from "./check-migrations.mjs";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-agent-memory-migrations-check-"));
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.mkdirSync(path.join(root, "migrations"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "pam-test", version: "0.5.0" }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, "memory", "pam.version.json"),
    `${JSON.stringify({ pamVersion: "0.5.0" }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(root, "migrations", "0.3.0-to-0.4.0-agent-layer.md"), "# 0.4.0\n");
  fs.writeFileSync(
    path.join(root, "migrations", "0.4.0-to-0.4.1-openclaw-daily-maintenance.md"),
    "# 0.4.1\n"
  );
  fs.writeFileSync(path.join(root, "migrations", "0.4.1-to-0.5.0-file-only-coverage.md"), "# 0.5.0\n");
  return root;
}

test("accepts patch, minor, and major one-step semver migrations", () => {
  assert.equal(incrementIsValid("0.4.0", "0.4.1"), true);
  assert.equal(incrementIsValid("0.4.1", "0.5.0"), true);
  assert.equal(incrementIsValid("0.9.1", "1.0.0"), true);
  assert.equal(incrementIsValid("0.3.0", "0.5.0"), false);
  assert.equal(incrementIsValid("0.4.1", "0.5.1"), false);
});

test("parses only semver-to-semver migration guides", () => {
  const migrations = parseSemverMigrations([
    "0.3.0-to-0.4.0-agent-layer.md",
    "markdown-v0-to-graph-v1.md"
  ]);
  assert.deepEqual(migrations, [
    {
      name: "0.3.0-to-0.4.0-agent-layer.md",
      from: "0.3.0",
      to: "0.4.0"
    }
  ]);
});

test("builds a contiguous semantic migration path", () => {
  const migrations = parseSemverMigrations([
    "0.3.0-to-0.4.0-agent-layer.md",
    "0.4.0-to-0.4.1-openclaw-daily-maintenance.md",
    "0.4.1-to-0.5.0-file-only-coverage.md"
  ]);
  assert.deepEqual(
    buildMigrationPath(migrations, "0.3.0", "0.5.0").map((migration) => migration.name),
    [
      "0.3.0-to-0.4.0-agent-layer.md",
      "0.4.0-to-0.4.1-openclaw-daily-maintenance.md",
      "0.4.1-to-0.5.0-file-only-coverage.md"
    ]
  );
});

test("marks agent instructions, graph, tools, and OpenClaw docs as migration-sensitive", () => {
  assert.equal(isMigrationSensitive("memory/agent-memory/pam-openclaw.md"), true);
  assert.equal(isMigrationSensitive("memory/graph/nodes.jsonl"), true);
  assert.equal(isMigrationSensitive("tools/pam-mcp-server.mjs"), true);
  assert.equal(isMigrationSensitive("docs/openclaw-daily-graph-maintenance.md"), true);
  assert.equal(isMigrationSensitive("README.md"), false);
  assert.equal(isMigrationSensitive("migrations/0.4.0-to-0.4.1-example.md"), false);
});

test("fails when migration-sensitive changes do not bump PAM version", () => {
  const root = makeWorkspace();
  const result = checkMigrations(root, {
    baseRef: "test-base",
    basePamVersion: { pamVersion: "0.5.0" },
    basePackage: { version: "0.5.0" },
    changedFiles: ["docs/openclaw-daily-graph-maintenance.md"]
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /without a PAM version bump/);
});

test("fails when a version bump skips an intermediate migration", () => {
  const root = makeWorkspace();
  fs.rmSync(path.join(root, "migrations", "0.4.0-to-0.4.1-openclaw-daily-maintenance.md"));
  const result = checkMigrations(root, {
    baseRef: "test-base",
    basePamVersion: { pamVersion: "0.3.0" },
    basePackage: { version: "0.3.0" },
    changedFiles: ["memory/pam.version.json", "tools/memory-graph.mjs"]
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing contiguous migration path/);
});

test("passes when a version bump has a complete migration chain", () => {
  const root = makeWorkspace();
  const result = checkMigrations(root, {
    baseRef: "test-base",
    basePamVersion: { pamVersion: "0.3.0" },
    basePackage: { version: "0.3.0" },
    changedFiles: ["memory/pam.version.json", "tools/memory-graph.mjs"]
  });
  assert.equal(result.ok, true);
});
