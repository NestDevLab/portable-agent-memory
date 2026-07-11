import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_PATH = path.join(__dirname, "pam-mcp-server.mjs");

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-mcp-e2e-"));
  fs.mkdirSync(path.join(root, "memory", "graph"), { recursive: true });
  fs.mkdirSync(path.join(root, "memory", "agent-memory"), { recursive: true });
  fs.mkdirSync(path.join(root, "tools"), { recursive: true });

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
  fs.writeFileSync(path.join(root, "README.md"), "# Project\n", "utf8");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n", "utf8");
  fs.writeFileSync(
    path.join(root, "memory", "agent-memory", "pam-runtime.md"),
    "# Runtime\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "conversation-log.md"),
    "# Conversation Log\n\nIntro.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "memory", "pam.version.json"),
    JSON.stringify({ pamVersion: "0.4.0", memoryFormat: "graph-v1" }, null, 2) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "tools", "memory-maintenance.config.json"),
    JSON.stringify({
      retentionDays: 90,
      archiveRoot: "memory/archive",
      summariesRoot: "memory/summaries",
      maintenanceRoot: "memory/maintenance",
      graph: { enabled: true, root: "memory/graph", versionPath: "memory/pam.version.json", catalogPath: "memory/graph/catalog.json" },
      synthesis: { enabled: false, provider: "none", command: "", args: [], stdin: "none", examples: {} },
      workspace: { name: "test", description: "test", indexPath: "memory/index.md", runtimePath: "memory/agent-memory/pam-runtime.md", llmWikiPath: "memory/agent-memory/llm-wiki.md", policyPaths: [] },
      managedLogs: [
        { source: "memory/conversation-log.md", archiveKey: "conversation-log", activeEntryLimit: 80 }
      ],
      readContextPaths: [],
      protectedPaths: ["AGENTS.md", "CLAUDE.md", "memory/agent-memory", "memory/sources"]
    }, null, 2) + "\n",
    "utf8"
  );
  return root;
}

function amfRecordContent() {
  const values = {
    schema: "amf-memory/v1",
    id: "mem_11111111-1111-4111-8111-111111111111",
    revision: 1,
    claimType: "decision",
    scope: { type: "shared", id: "shared:global" },
    visibility: "shared",
    subjects: [{ identityId: "agent:22222222-2222-4222-8222-222222222222", role: "owner" }],
    claim: { encoding: "plain", text: "A portable, source-backed memory record." },
    lifecycle: {
      status: "active",
      validFrom: "2026-07-11T10:00:00Z",
      validTo: null,
      supersedes: [],
      revokedAt: null,
      revocationReason: null
    },
    provenance: [{
      sourceType: "test-session",
      sourceId: "session-stable-0001",
      eventId: "event-stable-0001",
      contentSha256: "a".repeat(64),
      capturedAt: "2026-07-11T10:00:00Z"
    }],
    createdAt: "2026-07-11T10:00:00Z",
    updatedAt: "2026-07-11T10:00:00Z"
  };
  const metadata = Object.entries(values).map(([key, value]) => {
    const rendered = value !== null && typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
    return `${key}: ${rendered}`;
  }).join("\n");
  return `---\n${metadata}\n---\nNon-claim commentary.\n`;
}

function driveServer(workspaceRoot, requests, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH, "--workspace", workspaceRoot], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const responses = [];
    let buffer = "";
    const expected = requests.filter((r) => r.id !== undefined).length;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout after ${timeoutMs}ms; received ${responses.length}/${expected}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() !== "") {
          try {
            responses.push(JSON.parse(line));
          } catch (error) {
            clearTimeout(timer);
            child.kill();
            reject(new Error(`invalid JSON from server: ${line}`));
            return;
          }
          if (responses.length === expected) {
            clearTimeout(timer);
            child.stdin.end();
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      if (responses.length < expected) {
        reject(new Error(`server exited early; stderr: ${stderr}`));
        return;
      }
      resolve(responses);
    });
    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
  });
}

test("server responds to initialize + tools/list", async () => {
  const root = makeWorkspace();
  const responses = await driveServer(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list" }
  ]);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].result.serverInfo.name, "pam");
  const toolNames = responses[1].result.tools.map((t) => t.name);
  assert.ok(toolNames.includes("memory_audit"));
  assert.ok(toolNames.includes("memory_propose_edit"));
  assert.ok(toolNames.includes("memory_record_validate"));
  assert.ok(toolNames.includes("memory_propose_record"));
  assert.ok(toolNames.includes("graph_validate"));
});

test("server runs graph_validate over the workspace", async () => {
  const root = makeWorkspace();
  const responses = await driveServer(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_validate", arguments: {} } }
  ]);
  const callResponse = responses[1];
  assert.ok(callResponse.result);
  const payload = JSON.parse(callResponse.result.content[0].text);
  assert.equal(payload.ok, true);
});

test("server appends a dated section via memory_append", async () => {
  const root = makeWorkspace();
  const responses = await driveServer(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "memory_append",
        arguments: {
          log: "conversation-log",
          date: "2026-05-21",
          headerTitle: "End to end test",
          body: "Notes from the e2e test."
        }
      }
    }
  ]);
  const payload = JSON.parse(responses[1].result.content[0].text);
  assert.equal(payload.status, "appended");
  const onDisk = fs.readFileSync(path.join(root, "memory", "conversation-log.md"), "utf8");
  assert.ok(onDisk.includes("## 2026-05-21 - End to end test"));
});

test("server rejects memory_propose_edit on protected path", async () => {
  const root = makeWorkspace();
  const responses = await driveServer(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "memory_propose_edit",
        arguments: {
          path: "AGENTS.md",
          rationale: "should be rejected",
          diff: { kind: "replace", before: "# Agents\n", after: "# Hacked\n" }
        }
      }
    }
  ]);
  const callResponse = responses[1];
  const payload = JSON.parse(callResponse.result.content[0].text);
  assert.equal(payload.status, "rejected");
  assert.match(payload.error, /protected/i);
});

test("server validates and records an AMF record proposal without applying it", async () => {
  const root = makeWorkspace();
  const content = amfRecordContent();
  const responses = await driveServer(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "memory_propose_record",
        arguments: { content, rationale: "Record reviewed portable memory." }
      }
    }
  ]);
  const payload = JSON.parse(responses[1].result.content[0].text);
  assert.equal(payload.status, "recorded");
  assert.equal(payload.projection.k, "memory-record");
  assert.equal(fs.existsSync(path.join(root, payload.targetPath)), false);
  assert.equal(fs.existsSync(path.join(root, payload.proposalPath)), true);
});

test("server returns a safe projection for a canonical AMF record", async () => {
  const root = makeWorkspace();
  const relative = "memory/amf/records/mem_11111111-1111-4111-8111-111111111111.md";
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), amfRecordContent(), "utf8");
  const responses = await driveServer(root, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "memory_record_validate", arguments: { path: relative } }
    }
  ]);
  const payload = JSON.parse(responses[1].result.content[0].text);
  assert.equal(payload.status, "valid");
  assert.equal(payload.projection.k, "memory-record");
  assert.equal(payload.projection.src, relative);
});
