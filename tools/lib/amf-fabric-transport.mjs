import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

import { canonicalize, renderMemoryRecord } from "./amf-memory-record.mjs";
import { submitCuratorCandidate } from "./memory-curator.mjs";
import { loadFabricApplyReceiptForDispatch, recordFabricApplyAck } from "./memory-receipt-applicator.mjs";
import { assertNoSymlinkPath, atomicWriteFileSync, readFileNoFollowSync, readOwnerOnlyFileSync } from "./secure-fs.mjs";

const TRANSPORT_SCHEMA = "amf-fabric-transport/v1";
const HASH_RE = /^[a-f0-9]{64}$/;
const REPLAY_CURSOR_PATH = path.join("memory", "amf", "curator", "fabric-replay-cursor.json");
const DEFAULT_TRANSPORT = Object.freeze({
  version: TRANSPORT_SCHEMA,
  baseUrlEnv: "PAM_FABRIC_BASE_URL",
  curatorTokenFileEnv: "PAM_FABRIC_CURATOR_TOKEN_FILE",
  applicatorTokenFileEnv: "PAM_FABRIC_APPLICATOR_TOKEN_FILE",
  timeoutMs: 10000,
  maxResponseBytes: 1024 * 1024
});

function sha256(value) { return crypto.createHash("sha256").update(String(value), "utf8").digest("hex"); }
function hmac(key, value) { return crypto.createHmac("sha256", key).update(canonicalize(value), "utf8").digest("hex"); }
function artifactMac(key, value) { const copy = { ...value }; delete copy.artifactMac; return hmac(key, copy); }
function object(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields) { return object(value) && Object.keys(value).sort().join("\0") === [...fields].sort().join("\0"); }

function transportPolicy(config = {}) {
  const input = object(config.amfFabricTransport) ? config.amfFabricTransport : {};
  const policy = { ...DEFAULT_TRANSPORT, ...input };
  if (policy.version !== TRANSPORT_SCHEMA) throw new Error(`unsupported Fabric transport: ${policy.version}`);
  for (const field of ["baseUrlEnv", "curatorTokenFileEnv", "applicatorTokenFileEnv"]) {
    if (typeof policy[field] !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(policy[field])) throw new Error(`amfFabricTransport.${field} is invalid`);
  }
  if (!Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs < 100 || policy.timeoutMs > 120000
      || !Number.isSafeInteger(policy.maxResponseBytes) || policy.maxResponseBytes < 1024 || policy.maxResponseBytes > 8 * 1024 * 1024) throw new Error("Fabric transport limits are invalid");
  return policy;
}

function privateTokenFile(filename) {
  const value = readOwnerOnlyFileSync(filename, { label: "Fabric token file", maxBytes: 4096 }).trim();
  if (value.length < 16 || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error("Fabric token file is invalid");
  return value;
}

function endpoint(policy, env) {
  const raw = env[policy.baseUrlEnv];
  const url = new URL(String(raw || ""));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Fabric base URL must be an HTTPS origin");
  return url;
}

function nodeRequestJson({ url, method, pathname, token, body, timeoutMs, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    const succeed = value => { if (!settled) { settled = true; resolve(value); } };
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const request = https.request(new URL(pathname, url), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(encoded ? { "content-type": "application/json", "content-length": String(encoded.length) } : {})
      },
      timeout: timeoutMs
    }, response => {
      const chunks = []; let size = 0;
      if (!String(response.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        response.resume(); fail(new Error("Fabric response content-type is not JSON")); return;
      }
      response.on("data", chunk => {
        size += chunk.length;
        if (size > maxResponseBytes) { request.destroy(new Error("Fabric response exceeds configured limit")); return; }
        chunks.push(chunk);
      });
      response.on("aborted", () => fail(new Error("Fabric response was aborted")));
      response.on("error", fail);
      response.on("close", () => { if (!response.complete) fail(new Error("Fabric response closed before completion")); });
      response.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(new Error("Fabric response is not valid JSON")); return; }
        if (response.statusCode >= 300 && response.statusCode < 400) { fail(new Error("Fabric redirects are forbidden")); return; }
        if (response.statusCode < 200 || response.statusCode >= 300 || parsed?.ok !== true || !object(parsed.data) || typeof parsed.meta?.requestId !== "string") {
          fail(new Error(`Fabric request failed with status ${response.statusCode}`)); return;
        }
        succeed(parsed);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Fabric request timed out")));
    request.on("error", fail);
    if (encoded) request.write(encoded);
    request.end();
  });
}

async function requestFabric(config, role, request, runtime = {}) {
  const policy = transportPolicy(config);
  const env = runtime.env || process.env;
  const tokenFileEnv = role === "curator" ? policy.curatorTokenFileEnv : policy.applicatorTokenFileEnv;
  const token = privateTokenFile(env[tokenFileEnv]);
  const send = runtime.requestJson || nodeRequestJson;
  return send({ url: endpoint(policy, env), token, timeoutMs: policy.timeoutMs, maxResponseBytes: policy.maxResponseBytes, ...request });
}

async function listFabricProposals(config, input = {}, runtime = {}) {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (input.cursor != null && typeof input.cursor !== "string")) throw new Error("Fabric poll input is invalid");
  const query = new URLSearchParams({ status: "queued", limit: String(limit) });
  if (input.cursor) query.set("cursor", input.cursor);
  const response = await requestFabric(config, "curator", { method: "GET", pathname: `/v2/internal/curation/proposals?${query}` }, runtime);
  if (!Array.isArray(response.data.items) || response.data.items.length > limit) throw new Error("Fabric proposal page is invalid");
  return response.data;
}

async function readFabricProposal(config, proposalId, runtime = {}) {
  if (typeof proposalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(proposalId)) throw new Error("Fabric proposalId is invalid");
  const response = await requestFabric(config, "curator", { method: "GET", pathname: `/v2/internal/curation/proposals/${encodeURIComponent(proposalId)}` }, runtime);
  const data = response.data;
  if (data.proposalId !== proposalId || !["queued", "review", "promoted"].includes(data.status) || !object(data.payload) || !HASH_RE.test(String(data.proposalDigest ?? ""))
      || sha256(canonicalize(data.payload)) !== data.proposalDigest) throw new Error("Fabric proposal payload binding is invalid");
  return data;
}

function outboxKey(config, runtime = {}) {
  const envName = config.amfCurator?.ledgerKeyEnv || "PAM_CURATOR_LEDGER_KEY";
  const value = runtime.ledgerKey ?? (runtime.env || process.env)[envName];
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) throw new Error("curator ledger key is unavailable for Fabric outbox");
  return Buffer.from(value, "utf8");
}

function writeDecisionOutbox(workspaceRoot, config, receipt, ack, runtime = {}) {
  const directory = path.join(workspaceRoot, "memory/amf/curator/fabric-outbox");
  assertNoSymlinkPath(workspaceRoot, directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const absolute = path.join(directory, `${receipt.decisionId}.json`);
  const value = { schema: `${TRANSPORT_SCHEMA}/decision-outbox`, phase: ack ? "fabric_acked" : "queued", receipt, ack: ack || null };
  const key = outboxKey(config, runtime);
  value.artifactMac = artifactMac(key, value);
  if (fs.existsSync(absolute)) {
    const current = JSON.parse(readFileNoFollowSync(workspaceRoot, absolute));
    if (!HASH_RE.test(String(current.artifactMac ?? "")) || artifactMac(key, current) !== current.artifactMac) throw new Error("Fabric decision outbox authentication failed");
    if (current.phase === "fabric_acked" && canonicalize(current.receipt) === canonicalize(receipt)) return current;
    if (current.phase !== "queued" || canonicalize(current.receipt) !== canonicalize(receipt)) throw new Error("Fabric decision outbox conflict");
  }
  atomicWriteFileSync(workspaceRoot, absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return value;
}

async function postReceipt(config, role, receipt, runtime = {}) {
  const response = await requestFabric(config, role, { method: "POST", pathname: "/v2/internal/curation/receipts", body: receipt }, runtime);
  const exactStatus = receipt.kind === "apply" ? response.data.status === "promoted" : response.data.status === receipt.status;
  const alreadyPromoted = receipt.kind === "decision" && response.data.status === "promoted"
    && response.data.decision?.decisionId === receipt.decisionId && response.data.apply?.decisionId === receipt.decisionId;
  if (response.data.proposalId !== receipt.proposalId || (!exactStatus && !alreadyPromoted)) throw new Error("Fabric receipt ACK does not match the submitted transition");
  return { ackId: response.meta.requestId, acknowledgedAt: new Date().toISOString() };
}

function readReplayCursor(workspaceRoot, config, runtime = {}) {
  const absolute = path.join(workspaceRoot, REPLAY_CURSOR_PATH);
  if (!fs.existsSync(absolute)) return null;
  const current = JSON.parse(readFileNoFollowSync(workspaceRoot, absolute));
  const key = outboxKey(config, runtime);
  if (!exact(current, new Set(["schema", "cursor", "artifactMac"]))
      || current.schema !== `${TRANSPORT_SCHEMA}/replay-cursor`
      || !/^decision-[0-9a-f]{40}$/.test(String(current.cursor ?? ""))
      || !HASH_RE.test(String(current.artifactMac ?? ""))
      || artifactMac(key, current) !== current.artifactMac) throw new Error("Fabric replay cursor authentication failed");
  return current.cursor;
}

function writeReplayCursor(workspaceRoot, config, cursor, runtime = {}) {
  const absolute = path.join(workspaceRoot, REPLAY_CURSOR_PATH);
  const value = { schema: `${TRANSPORT_SCHEMA}/replay-cursor`, cursor };
  value.artifactMac = artifactMac(outboxKey(config, runtime), value);
  atomicWriteFileSync(workspaceRoot, absolute, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function replayFabricDecisionOutbox(workspaceRoot, config, input = {}, runtime = {}) {
  const limit = input.limit ?? 50;
  const maxPages = input.maxPages ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20
      || (input.cursor != null && !/^decision-[0-9a-f]{40}$/.test(input.cursor))) throw new Error("decision replay bounds are invalid");
  const directory = path.join(workspaceRoot, "memory/amf/curator/fabric-outbox");
  if (!fs.existsSync(directory)) return { ok: true, processed: 0, results: [] };
  assertNoSymlinkPath(workspaceRoot, directory, { allowMissing: false });
  const key = outboxKey(config, runtime); const results = [];
  const names = fs.readdirSync(directory).filter(name => /^decision-[0-9a-f]{40}\.json$/.test(name)).sort();
  if (!names.length) return { ok: true, processed: 0, scanned: 0, results: [], nextCursor: null };
  const cursor = input.cursor ?? readReplayCursor(workspaceRoot, config, runtime);
  let start = cursor ? names.findIndex(name => name > `${cursor}.json`) : 0;
  if (start < 0) start = 0;
  const scanBudget = Math.min(names.length, limit * maxPages);
  let scanned = 0; let lastCursor = cursor;
  while (scanned < scanBudget && results.length < limit) {
    const name = names[(start + scanned) % names.length];
    const current = JSON.parse(readFileNoFollowSync(workspaceRoot, path.join(directory, name)));
    if (!HASH_RE.test(String(current.artifactMac ?? "")) || artifactMac(key, current) !== current.artifactMac) throw new Error("Fabric decision outbox authentication failed");
    if (current.phase === "queued") {
      const ack = await postReceipt(config, "curator", current.receipt, runtime);
      writeDecisionOutbox(workspaceRoot, config, current.receipt, ack, runtime);
      results.push({ decisionId: current.receipt.decisionId, status: "fabric_acked", duplicate: false });
    } else if (current.phase !== "fabric_acked") throw new Error("Fabric decision outbox phase is invalid");
    scanned += 1;
    lastCursor = name.slice(0, -5);
    writeReplayCursor(workspaceRoot, config, lastCursor, runtime);
  }
  return { ok: true, processed: results.length, scanned, results, nextCursor: lastCursor };
}

async function intakeFabricProposal(workspaceRoot, config, input, runtime = {}) {
  if (!exact(input, new Set(["proposalId", "dispatch"]))) throw new Error("Fabric intake input is invalid");
  const remote = await readFabricProposal(config, input.proposalId, runtime);
  if (remote.payload.type !== "canonical-memory-proposal" || !object(remote.payload.record)
      || typeof remote.payload.rationale !== "string") throw new Error("Fabric proposal is not a canonical memory candidate");
  const result = submitCuratorCandidate(workspaceRoot, config, {
    content: renderMemoryRecord(remote.payload.record),
    rationale: remote.payload.rationale,
    idempotencyKey: `fabric-proposal:${remote.proposalId}`,
    confidence: remote.payload.record.confidence?.score,
    source: { type: "fabric", id: remote.proposalId },
    fabricProposal: { proposalId: remote.proposalId, proposalDigest: remote.proposalDigest }
  }, runtime);
  if (!result.ok || !result.fabricReceipt) return { ok: false, status: result.status || "rejected", error: result.error || "curator intake failed" };
  writeDecisionOutbox(workspaceRoot, config, result.fabricReceipt, null, runtime);
  const safe = { ok: true, status: result.status, candidateId: result.candidateId, decisionId: result.decisionId, decisionDigest: result.decisionDigest, duplicateSubmission: result.duplicateSubmission, fabricReceipt: result.fabricReceipt };
  if (input.dispatch !== true) return { ...safe, transportStatus: "queued" };
  const ack = await postReceipt(config, "curator", result.fabricReceipt, runtime);
  if (runtime.faultAt === "after-decision-ack") throw new Error("injected transport fault after decision ACK");
  writeDecisionOutbox(workspaceRoot, config, result.fabricReceipt, ack, runtime);
  return { ...safe, transportStatus: "fabric_acked", ack };
}

async function drainFabricProposals(workspaceRoot, config, input = {}, runtime = {}) {
  const maxPages = input.maxPages ?? 10;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error("Fabric drain maxPages is invalid");
  const results = []; let cursor = input.cursor || null; let pages = 0;
  do {
    const page = await listFabricProposals(config, { limit: input.limit ?? 50, cursor }, runtime); pages += 1;
    for (const item of page.items) results.push(await intakeFabricProposal(workspaceRoot, config, { proposalId: item.proposalId, dispatch: input.dispatch === true }, runtime));
    cursor = page.nextCursor || null;
  } while (cursor && pages < maxPages);
  return { ok: results.every(item => item.ok), processed: results.length, pages, results, nextCursor: cursor };
}

async function dispatchFabricApplyReceipt(workspaceRoot, config, input, runtime = {}) {
  const loaded = loadFabricApplyReceiptForDispatch(workspaceRoot, config, { decisionId: input.decisionId }, runtime);
  if (!loaded.ok) return loaded;
  if (loaded.status === "fabric_acked") return { ok: true, duplicate: true, status: "fabric_acked" };
  const ack = await postReceipt(config, "applicator", loaded.receipt, runtime);
  if (runtime.faultAt === "after-apply-ack") throw new Error("injected transport fault after apply ACK");
  return recordFabricApplyAck(workspaceRoot, config, { decisionId: input.decisionId, receipt: loaded.receipt, ...ack }, runtime);
}

export {
  DEFAULT_TRANSPORT,
  TRANSPORT_SCHEMA,
  dispatchFabricApplyReceipt,
  drainFabricProposals,
  intakeFabricProposal,
  listFabricProposals,
  readFabricProposal,
  replayFabricDecisionOutbox,
  transportPolicy
};
