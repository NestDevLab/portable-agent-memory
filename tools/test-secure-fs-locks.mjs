import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { applyProposal } from "./lib/memory-apply-proposal.mjs";
import { proposeEdit } from "./lib/memory-proposals.mjs";
import { acquireExclusiveLock } from "./lib/secure-fs.mjs";

const PROPOSALS_DIR = path.join("memory", "maintenance", "proposals");
const SHORT_LOCK_OPTIONS = { staleMs: 120, heartbeatMs: 0 };

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-lock-test-"));
  fs.mkdirSync(path.join(root, "memory", "graph"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "memory", "knowledge-log.md"),
    "# Knowledge Log\n\n## 2026-04-12 - Worker retries\n\nFive retries.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "graph", "nodes.jsonl"),
    '{"id":"project:pam","k":"project","n":"PAM","d":"Memory toolkit.","st":"confirmed","c":"high","u":"2026-05-05","src":"README.md"}\n',
    "utf8"
  );
  fs.writeFileSync(path.join(root, "memory", "graph", "edges.jsonl"), "", "utf8");
  fs.writeFileSync(path.join(root, "memory", "graph", "aliases.jsonl"), '{"a":"PAM","id":"project:pam"}\n', "utf8");
  return root;
}

function defaultConfig() {
  return {
    protectedPaths: ["AGENTS.md", "CLAUDE.md", "memory/agent-memory", "memory/sources"]
  };
}

function recordProposal(root) {
  const result = proposeEdit(root, defaultConfig(), {
    path: "memory/knowledge-log.md",
    rationale: "exercise lock recovery",
    diff: {
      kind: "replace",
      anchor: { headerLine: "## 2026-04-12 - Worker retries" },
      before: "## 2026-04-12 - Worker retries\n\nFive retries.\n",
      after: "## 2026-04-12 - Worker retries\n\nFive retries after lock recovery.\n"
    }
  });
  assert.equal(result.ok, true, result.error);
  return result.proposalId;
}

async function spawnLockHolder(root, lockPath, lockOptions) {
  const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "lib", "secure-fs.mjs")).href;
  const source = `
    import { acquireExclusiveLock } from ${JSON.stringify(moduleUrl)};
    acquireExclusiveLock(
      process.env.PAM_TEST_ROOT,
      process.env.PAM_TEST_LOCK,
      JSON.parse(process.env.PAM_TEST_OPTIONS)
    );
    process.stdout.write("LOCKED\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      PAM_TEST_ROOT: root,
      PAM_TEST_LOCK: lockPath,
      PAM_TEST_OPTIONS: JSON.stringify(lockOptions)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`lock holder startup timed out: ${stderr}`)), 5000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("LOCKED\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`lock holder exited before ready (${code ?? signal}): ${stderr}`));
    });
  });
  return child;
}

async function crash(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

test("exclusive lock records owner identity and refuses to release a replacement inode/token", () => {
  const root = makeWorkspace();
  const lockPath = path.join(root, PROPOSALS_DIR, "owner-safe.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lock = acquireExclusiveLock(root, lockPath, SHORT_LOCK_OPTIONS);
  const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(owner.version, 1);
  assert.equal(owner.pid, process.pid);
  assert.equal(typeof owner.host, "string");
  assert.match(owner.nonce, /^[a-f0-9]{48}$/);
  assert.ok(Date.parse(owner.acquiredAt));
  assert.ok(Date.parse(owner.heartbeatAt));

  fs.rmSync(lockPath);
  const replacement = { ...owner, nonce: crypto.randomBytes(24).toString("hex") };
  fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  assert.throws(() => lock.release(), /ownership changed/i);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).nonce, replacement.nonce);
});

test("proposal lock takeover requires a stale lock whose subprocess owner is dead", async (t) => {
  const root = makeWorkspace();
  const proposalId = recordProposal(root);
  const lockPath = path.join(root, PROPOSALS_DIR, `${proposalId}.lock`);
  const child = await spawnLockHolder(root, lockPath, SHORT_LOCK_OPTIONS);
  t.after(() => crash(child));

  await delay(180);
  const whileAlive = applyProposal(root, defaultConfig(), { proposalId }, { lockOptions: SHORT_LOCK_OPTIONS });
  assert.equal(whileAlive.ok, false);
  assert.match(whileAlive.error, /already being applied/i);

  await crash(child);
  const afterCrash = applyProposal(root, defaultConfig(), { proposalId }, { lockOptions: SHORT_LOCK_OPTIONS });
  assert.equal(afterCrash.ok, true, afterCrash.error);
  assert.equal(afterCrash.status, "applied");
  assert.equal(fs.existsSync(lockPath), false);
});

test("target lock heartbeat prevents takeover; dead fresh lock waits until stale before retry", async (t) => {
  const root = makeWorkspace();
  const proposalId = recordProposal(root);
  const targetPath = "memory/knowledge-log.md";
  const targetLockId = crypto.createHash("sha256").update(targetPath).digest("hex");
  const lockPath = path.join(root, PROPOSALS_DIR, `target-${targetLockId}.lock`);
  const heartbeatOptions = { staleMs: 120, heartbeatMs: 20 };
  const child = await spawnLockHolder(root, lockPath, heartbeatOptions);
  t.after(() => crash(child));

  await delay(220);
  const whileAlive = applyProposal(root, defaultConfig(), { proposalId }, { lockOptions: heartbeatOptions });
  assert.equal(whileAlive.ok, false);
  assert.match(whileAlive.error, /target is already being modified/i);

  await crash(child);
  const whileFresh = applyProposal(root, defaultConfig(), { proposalId }, { lockOptions: heartbeatOptions });
  assert.equal(whileFresh.ok, false);
  assert.match(whileFresh.error, /target is already being modified/i);

  await delay(160);
  const afterStale = applyProposal(root, defaultConfig(), { proposalId }, { lockOptions: heartbeatOptions });
  assert.equal(afterStale.ok, true, afterStale.error);
  assert.equal(afterStale.status, "applied");
  assert.equal(fs.existsSync(lockPath), false);
});
