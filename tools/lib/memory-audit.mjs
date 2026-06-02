import fs from "node:fs";
import path from "node:path";

import { loadGraph, validateGraph } from "../memory-graph.mjs";
import { parseLogSections } from "../memory-maintenance.mjs";
import { toPosixPath, workspaceRelative } from "./workspace.mjs";

const MAX_NODE_DIGEST_CHARS = 180;
const OVERSIZED_DIGEST_THRESHOLD = Math.floor(MAX_NODE_DIGEST_CHARS * 0.9);
const DEFAULT_STALE_WIKI_DAYS = 180;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

const ALL_CHECKS = [
  "duplicate-knowledge-entry",
  "link-rot",
  "graph-source-link-rot",
  "dangling-alias",
  "stale-wiki-page",
  "rotation-candidate",
  "contradiction",
  "oversized-digest",
  "orphan-source"
];

function makeFindingId(seq, check, runId) {
  const stamp = runId ?? new Date().toISOString().slice(0, 10);
  return `audit-${stamp}-${String(seq).padStart(4, "0")}-${check}`;
}

function normalizeForCompare(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text) {
  const stripped = text.replace(/^#+\s.*$/m, "").trim();
  const sentenceMatch = stripped.match(/[^.!?\n]{8,}[.!?\n]/);
  return sentenceMatch ? sentenceMatch[0] : stripped.slice(0, 200);
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const tokensA = new Set(a.split(" "));
  const tokensB = new Set(b.split(" "));
  let intersect = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersect += 1;
  }
  const union = tokensA.size + tokensB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function checkDuplicateKnowledgeEntry(workspaceRoot, config, ctx) {
  const findings = [];
  const logs = (config.managedLogs ?? []).map((entry) => entry.source);
  for (const relativePath of logs) {
    const absolute = path.join(workspaceRoot, relativePath);
    if (!fs.existsSync(absolute)) continue;
    const content = fs.readFileSync(absolute, "utf8");
    const { sections } = parseLogSections(content);
    const fingerprints = sections.map((section) => ({
      headerLine: section.headerLine,
      dateString: section.dateString,
      fingerprint: normalizeForCompare(firstSentence(section.block))
    }));
    for (let i = 0; i < fingerprints.length; i += 1) {
      for (let j = i + 1; j < fingerprints.length; j += 1) {
        const a = fingerprints[i];
        const b = fingerprints[j];
        if (a.fingerprint === "" || b.fingerprint === "") continue;
        const score = similarity(a.fingerprint, b.fingerprint);
        if (score >= DUPLICATE_SIMILARITY_THRESHOLD) {
          findings.push({
            id: makeFindingId(ctx.nextSeq(), "duplicate-knowledge-entry", ctx.runId),
            check: "duplicate-knowledge-entry",
            severity: "warning",
            paths: [toPosixPath(relativePath)],
            anchors: [
              { path: toPosixPath(relativePath), headerLine: a.headerLine },
              { path: toPosixPath(relativePath), headerLine: b.headerLine }
            ],
            summary: `Near-duplicate log entries (similarity ${score.toFixed(2)}).`,
            evidence: [a.headerLine, b.headerLine],
            suggestedAction: "merge-or-supersede"
          });
        }
      }
    }
  }
  return findings;
}

function extractMarkdownLinks(content) {
  const links = [];
  const linkRe = /\[[^\]]+\]\(([^)\s#]+)(?:#[^)]*)?\)/g;
  let match;
  while ((match = linkRe.exec(content)) !== null) {
    links.push({ target: match[1], offset: match.index });
  }
  return links;
}

function checkLinkRot(workspaceRoot, config, ctx) {
  const findings = [];
  const memoryRoot = path.join(workspaceRoot, "memory");
  if (!fs.existsSync(memoryRoot)) return findings;
  function walk(dir) {
    const names = fs.readdirSync(dir);
    for (const name of names) {
      const child = path.join(dir, name);
      const stats = fs.lstatSync(child);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        walk(child);
      } else if (stats.isFile() && child.endsWith(".md")) {
        const content = fs.readFileSync(child, "utf8");
        const links = extractMarkdownLinks(content);
        for (const link of links) {
          if (/^https?:/i.test(link.target) || link.target.startsWith("mailto:")) continue;
          const linkAbsolute = path.resolve(path.dirname(child), link.target);
          if (!fs.existsSync(linkAbsolute)) {
            findings.push({
              id: makeFindingId(ctx.nextSeq(), "link-rot", ctx.runId),
              check: "link-rot",
              severity: "warning",
              paths: [workspaceRelative(workspaceRoot, child)],
              anchors: [{ path: workspaceRelative(workspaceRoot, child), offset: link.offset }],
              summary: `Broken markdown link to ${link.target}`,
              evidence: [link.target],
              suggestedAction: "fix-or-remove-link"
            });
          }
        }
      }
    }
  }
  walk(memoryRoot);
  return findings;
}

function checkGraphSourceLinkRot(workspaceRoot, _config, ctx) {
  const findings = [];
  let graph;
  try {
    graph = loadGraph(workspaceRoot);
  } catch {
    return findings;
  }
  const checked = new Set();
  function checkSrc(entry, kind) {
    if (!entry || typeof entry.src !== "string" || entry.src.trim() === "") return;
    const src = entry.src.split("#")[0];
    if (checked.has(`${kind}:${src}`)) return;
    checked.add(`${kind}:${src}`);
    const absolute = path.resolve(workspaceRoot, src);
    if (!fs.existsSync(absolute)) {
      findings.push({
        id: makeFindingId(ctx.nextSeq(), "graph-source-link-rot", ctx.runId),
        check: "graph-source-link-rot",
        severity: "warning",
        paths: [src],
        anchors: [{ path: src }],
        summary: `Graph ${kind} references missing source file: ${src}`,
        evidence: [entry.id ?? `${entry.f}->${entry.t}`],
        suggestedAction: "update-or-remove-src"
      });
    }
  }
  for (const node of graph.nodes) checkSrc(node, "node");
  for (const edge of graph.edges) checkSrc(edge, "edge");
  return findings;
}

function checkDanglingAlias(workspaceRoot, _config, ctx) {
  const findings = [];
  let graph;
  try {
    graph = loadGraph(workspaceRoot);
  } catch {
    return findings;
  }
  const result = validateGraph(graph);
  for (const error of result.errors) {
    if (error.startsWith("Alias target missing") || error.startsWith("Dangling edge")) {
      findings.push({
        id: makeFindingId(ctx.nextSeq(), "dangling-alias", ctx.runId),
        check: "dangling-alias",
        severity: "warning",
        paths: ["memory/graph/aliases.jsonl", "memory/graph/edges.jsonl"],
        anchors: [],
        summary: error,
        evidence: [error],
        suggestedAction: "repair-or-remove-graph-entry"
      });
    }
  }
  return findings;
}

function listAgentMemoryFiles(workspaceRoot) {
  const dir = path.join(workspaceRoot, "memory", "agent-memory");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(dir, name));
}

function collectInboundLinkTargets(workspaceRoot) {
  const targets = new Set();
  const indexPath = path.join(workspaceRoot, "memory", "index.md");
  if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, "utf8");
    for (const link of extractMarkdownLinks(content)) {
      const resolved = path.resolve(path.dirname(indexPath), link.target);
      targets.add(resolved);
    }
  }
  try {
    const graph = loadGraph(workspaceRoot);
    for (const node of graph.nodes) {
      if (typeof node.src === "string") {
        const src = node.src.split("#")[0];
        targets.add(path.resolve(workspaceRoot, src));
      }
    }
    for (const edge of graph.edges) {
      if (typeof edge.src === "string") {
        const src = edge.src.split("#")[0];
        targets.add(path.resolve(workspaceRoot, src));
      }
    }
  } catch {
    // ignore
  }
  return targets;
}

function checkStaleWikiPage(workspaceRoot, _config, ctx, options = {}) {
  const findings = [];
  const days = Number.isInteger(options.staleDays) && options.staleDays > 0
    ? options.staleDays
    : DEFAULT_STALE_WIKI_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inbound = collectInboundLinkTargets(workspaceRoot);
  const files = listAgentMemoryFiles(workspaceRoot);
  for (const file of files) {
    const stats = fs.statSync(file);
    if (stats.mtimeMs >= cutoff) continue;
    if (inbound.has(file)) continue;
    findings.push({
      id: makeFindingId(ctx.nextSeq(), "stale-wiki-page", ctx.runId),
      check: "stale-wiki-page",
      severity: "info",
      paths: [workspaceRelative(workspaceRoot, file)],
      anchors: [{ path: workspaceRelative(workspaceRoot, file) }],
      summary: `Agent-memory page is older than ${days}d and has no inbound link.`,
      evidence: [`mtime: ${stats.mtime.toISOString()}`],
      suggestedAction: "review-or-link-or-retire"
    });
  }
  return findings;
}

function checkRotationCandidate(workspaceRoot, config, ctx) {
  const findings = [];
  const retentionDays = Number.isInteger(config.retentionDays) ? config.retentionDays : 90;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const logConfig of config.managedLogs ?? []) {
    const absolute = path.join(workspaceRoot, logConfig.source);
    if (!fs.existsSync(absolute)) continue;
    const content = fs.readFileSync(absolute, "utf8");
    const { sections } = parseLogSections(content);
    const dated = sections.filter((section) => section.kind === "dated" && section.date instanceof Date);
    const overLimit = Number.isInteger(logConfig.activeEntryLimit)
      && logConfig.activeEntryLimit > 0
      && dated.length > logConfig.activeEntryLimit;
    const past = dated.filter((section) => section.date.getTime() < cutoffMs);
    if (overLimit || past.length > 0) {
      findings.push({
        id: makeFindingId(ctx.nextSeq(), "rotation-candidate", ctx.runId),
        check: "rotation-candidate",
        severity: "info",
        paths: [toPosixPath(logConfig.source)],
        anchors: [{ path: toPosixPath(logConfig.source) }],
        summary: `Log has ${dated.length} dated entries (limit ${logConfig.activeEntryLimit ?? "n/a"}, ${past.length} past retention).`,
        evidence: [
          `activeEntryLimit=${logConfig.activeEntryLimit ?? "n/a"}`,
          `retentionDays=${retentionDays}`,
          `entries=${dated.length}`,
          `past=${past.length}`
        ],
        suggestedAction: "run-maintenance-rotate"
      });
    }
  }
  return findings;
}

function checkContradiction(workspaceRoot, _config, ctx) {
  const findings = [];
  let graph;
  try {
    graph = loadGraph(workspaceRoot);
  } catch {
    return findings;
  }
  const aliasIndex = new Map();
  for (const alias of graph.aliases) {
    if (typeof alias.a !== "string") continue;
    const key = alias.a.toLowerCase();
    if (!aliasIndex.has(key)) aliasIndex.set(key, new Set());
    aliasIndex.get(key).add(alias.id);
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const [aliasKey, idSet] of aliasIndex.entries()) {
    if (idSet.size < 2) continue;
    const ids = [...idSet];
    const digests = ids
      .map((id) => nodeById.get(id))
      .filter((node) => node && node.st === "confirmed");
    if (digests.length < 2) continue;
    const unique = new Set(digests.map((node) => normalizeForCompare(node.d ?? "")));
    if (unique.size <= 1) continue;
    findings.push({
      id: makeFindingId(ctx.nextSeq(), "contradiction", ctx.runId),
      check: "contradiction",
      severity: "info",
      paths: ["memory/graph/nodes.jsonl"],
      anchors: digests.map((node) => ({ path: "memory/graph/nodes.jsonl", id: node.id })),
      summary: `Alias "${aliasKey}" resolves to multiple confirmed nodes with conflicting digests.`,
      evidence: digests.map((node) => `${node.id}: ${node.d}`),
      suggestedAction: "reconcile-confirmed-claims"
    });
  }
  return findings;
}

function checkOversizedDigest(workspaceRoot, _config, ctx) {
  const findings = [];
  let graph;
  try {
    graph = loadGraph(workspaceRoot);
  } catch {
    return findings;
  }
  for (const node of graph.nodes) {
    if (typeof node.d !== "string") continue;
    if (node.d.length >= OVERSIZED_DIGEST_THRESHOLD && node.d.length <= MAX_NODE_DIGEST_CHARS) {
      findings.push({
        id: makeFindingId(ctx.nextSeq(), "oversized-digest", ctx.runId),
        check: "oversized-digest",
        severity: "info",
        paths: ["memory/graph/nodes.jsonl"],
        anchors: [{ path: "memory/graph/nodes.jsonl", id: node.id }],
        summary: `Node digest is ${node.d.length}/${MAX_NODE_DIGEST_CHARS} chars; pre-warning before validation breaks.`,
        evidence: [`${node.id}: ${node.d.length} chars`],
        suggestedAction: "tighten-digest"
      });
    }
  }
  return findings;
}

function checkOrphanSource(workspaceRoot, _config, ctx) {
  const findings = [];
  const sourcesDir = path.join(workspaceRoot, "memory", "sources");
  if (!fs.existsSync(sourcesDir)) return findings;
  let graph;
  try {
    graph = loadGraph(workspaceRoot);
  } catch {
    return findings;
  }
  const referenced = new Set();
  function recordSrc(src) {
    if (typeof src !== "string") return;
    const head = src.split("#")[0];
    referenced.add(path.resolve(workspaceRoot, head));
  }
  for (const node of graph.nodes) recordSrc(node.src);
  for (const edge of graph.edges) recordSrc(edge.src);

  function walk(dir) {
    const names = fs.readdirSync(dir);
    for (const name of names) {
      const child = path.join(dir, name);
      const stats = fs.lstatSync(child);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        walk(child);
      } else if (stats.isFile()) {
        if (referenced.has(child)) continue;
        findings.push({
          id: makeFindingId(ctx.nextSeq(), "orphan-source", ctx.runId),
          check: "orphan-source",
          severity: "info",
          paths: [workspaceRelative(workspaceRoot, child)],
          anchors: [{ path: workspaceRelative(workspaceRoot, child) }],
          summary: "Source file is not referenced from the graph.",
          evidence: [workspaceRelative(workspaceRoot, child)],
          suggestedAction: "link-or-leave-as-archive"
        });
      }
    }
  }
  walk(sourcesDir);
  return findings;
}

const CHECK_IMPLEMENTATIONS = {
  "duplicate-knowledge-entry": checkDuplicateKnowledgeEntry,
  "link-rot": checkLinkRot,
  "graph-source-link-rot": checkGraphSourceLinkRot,
  "dangling-alias": checkDanglingAlias,
  "stale-wiki-page": checkStaleWikiPage,
  "rotation-candidate": checkRotationCandidate,
  "contradiction": checkContradiction,
  "oversized-digest": checkOversizedDigest,
  "orphan-source": checkOrphanSource
};

function runAudit(workspaceRoot, config, options = {}) {
  const requested = Array.isArray(options.checks) && options.checks.length > 0
    ? options.checks.filter((name) => ALL_CHECKS.includes(name))
    : ALL_CHECKS;
  let seq = 0;
  const ctx = {
    runId: options.runId ?? new Date().toISOString().slice(0, 10),
    nextSeq: () => {
      seq += 1;
      return seq;
    }
  };
  const findings = [];
  for (const check of requested) {
    const fn = CHECK_IMPLEMENTATIONS[check];
    try {
      const checkFindings = fn(workspaceRoot, config, ctx, options);
      findings.push(...checkFindings);
    } catch (error) {
      findings.push({
        id: makeFindingId(ctx.nextSeq(), check, ctx.runId),
        check,
        severity: "error",
        paths: [],
        anchors: [],
        summary: `Check ${check} failed: ${error.message}`,
        evidence: [error.message],
        suggestedAction: "investigate-audit-failure"
      });
    }
  }
  const summary = {
    byCheck: {},
    bySeverity: {}
  };
  for (const finding of findings) {
    summary.byCheck[finding.check] = (summary.byCheck[finding.check] ?? 0) + 1;
    summary.bySeverity[finding.severity] = (summary.bySeverity[finding.severity] ?? 0) + 1;
  }
  return { checks: requested, findings, summary };
}

export {
  ALL_CHECKS,
  MAX_NODE_DIGEST_CHARS,
  OVERSIZED_DIGEST_THRESHOLD,
  runAudit
};
