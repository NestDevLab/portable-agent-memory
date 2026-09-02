import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  collectFileOnlyCoverage,
  graphStats,
  loadGraph,
  validateGraph
} from "../memory-graph.mjs";

const DEFAULTS = {
  graphDir: "memory/graph",
  versionPath: "memory/pam.version.json",
  scenario: "benchmarks/file-only-coverage.json",
  staleAfterDays: 30
};
const LIFECYCLES = new Set(["confirmed", "inferred", "uncertain", "obsolete", "conflicting"]);
const CONFIDENCES = new Set(["high", "medium", "low", "unknown"]);

function posix(value) {
  return value.split(path.sep).join("/");
}

function relativePath(workspaceRoot, candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "") return null;
  const absolute = path.resolve(workspaceRoot, candidate);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return posix(relative);
}

function absolutePath(workspaceRoot, candidate) {
  const relative = relativePath(workspaceRoot, candidate);
  return relative ? path.join(workspaceRoot, relative) : null;
}

function readJson(workspaceRoot, candidate) {
  const absolute = absolutePath(workspaceRoot, candidate);
  if (!absolute) return { ok: false, error: "path must stay inside workspace" };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(absolute, "utf8")) };
  } catch (error) {
    return { ok: false, error: `cannot read JSON: ${error.message}` };
  }
}

function dateMs(value) {
  if (typeof value !== "string") return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageDays(value, nowMs) {
  const timestamp = dateMs(value);
  return timestamp === null ? null : Math.max(0, Math.floor((nowMs - timestamp) / 86_400_000));
}

function fileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function statusOf(...statuses) {
  if (statuses.includes("BLOCKED")) return "BLOCKED";
  if (statuses.includes("ATTENTION")) return "ATTENTION";
  if (statuses.includes("NONE")) return "NONE";
  return "PASS";
}

function nodeIntegrity(graph, workspaceRoot) {
  const errors = [...validateGraph(graph).errors];
  const sourceErrors = [];
  for (const node of graph.nodes) {
    if (!LIFECYCLES.has(node.st)) errors.push(`invalid lifecycle: ${node.id}`);
    if (!CONFIDENCES.has(node.c)) errors.push(`invalid confidence: ${node.id}`);
    const source = absolutePath(workspaceRoot, node.src);
    if (!source || !fs.existsSync(source)) sourceErrors.push(node.id);
  }
  if (sourceErrors.length > 0) errors.push(`missing or unsafe node sources: ${sourceErrors.length}`);

  const neighbours = new Map(graph.nodes.map((node) => [node.id, new Set()]));
  for (const edge of graph.edges) {
    neighbours.get(edge.f)?.add(edge.t);
    neighbours.get(edge.t)?.add(edge.f);
  }
  const orphanCount = [...neighbours.values()].filter((neighboursForNode) => neighboursForNode.size === 0).length;
  const unseen = new Set(neighbours.keys());
  let componentCount = 0;
  while (unseen.size > 0) {
    componentCount += 1;
    const [first] = unseen;
    const stack = [first];
    unseen.delete(first);
    while (stack.length > 0) {
      const current = stack.pop();
      for (const next of neighbours.get(current) ?? []) {
        if (unseen.delete(next)) stack.push(next);
      }
    }
  }
  return {
    status: errors.length === 0 ? "PASS" : "BLOCKED",
    errors,
    missingSourceCount: sourceErrors.length,
    orphanCount,
    disconnectedComponentCount: componentCount
  };
}

function catalogIntegrity(workspaceRoot, graphDir, graph) {
  const catalogPath = `${graphDir}/catalog.json`;
  const catalog = readJson(workspaceRoot, catalogPath);
  const errors = [];
  if (!catalog.ok) {
    errors.push("catalog is missing or invalid");
  } else {
    const expected = { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, aliasCount: graph.aliases.length };
    for (const [key, value] of Object.entries(expected)) {
      if (catalog.value[key] !== value) errors.push(`catalog ${key} does not match graph`);
    }
    if (catalog.value.schemaVersion !== "pam-graph-v1") errors.push("catalog schema is not pam-graph-v1");
  }
  return { status: errors.length === 0 ? "PASS" : "BLOCKED", errors, catalog: catalog.ok ? catalog.value : null };
}

function sourceFreshnessPolicies(workspaceRoot, registryPath, staleAfterDays) {
  const policies = new Map();
  if (!registryPath) return policies;
  const registry = readJson(workspaceRoot, registryPath);
  if (!registry.ok || !Array.isArray(registry.value.sources)) return policies;
  for (const entry of registry.value.sources) {
    const sourcePath = relativePath(workspaceRoot, entry?.path);
    if (!sourcePath || (!entry?.freshness && !entry?.sha256)) continue;
    policies.set(sourcePath, {
      maxAgeDays: entry.freshness?.maxAgeDays === null
        ? null
        : Number.isFinite(entry.freshness?.maxAgeDays)
          ? entry.freshness.maxAgeDays
          : staleAfterDays,
      trackSourceChanges: entry.freshness?.trackSourceChanges !== false,
      sha256: typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : null
    });
  }
  return policies;
}

function freshness(graph, workspaceRoot, version, catalog, nowMs, staleAfterDays, registryPath) {
  const policies = sourceFreshnessPolicies(workspaceRoot, registryPath, staleAfterDays);
  const ages = graph.nodes.map((node) => ageDays(node.u, nowMs)).filter((value) => value !== null);
  const staleNodeCount = graph.nodes.filter((node) => {
    const age = ageDays(node.u, nowMs);
    const policy = policies.get(posix(node.src));
    const maxAgeDays = policy ? policy.maxAgeDays : staleAfterDays;
    return age !== null && maxAgeDays !== null && age > maxAgeDays;
  }).length;
  const ageExemptNodeCount = graph.nodes.filter((node) => policies.get(posix(node.src))?.maxAgeDays === null).length;
  const latestNodeBySource = new Map();
  for (const node of graph.nodes) {
    const existing = latestNodeBySource.get(node.src);
    if (!existing || dateMs(node.u) > dateMs(existing.u)) latestNodeBySource.set(node.src, node);
  }
  let sourceNewerThanNodeCount = 0;
  for (const [sourcePath, node] of latestNodeBySource) {
    const policy = policies.get(posix(sourcePath));
    if (policy?.trackSourceChanges === false) continue;
    const source = absolutePath(workspaceRoot, sourcePath);
    if (!source || !fs.existsSync(source)) continue;
    const updated = dateMs(node.u);
    const changed = policy?.sha256
      ? fileSha256(source) !== policy.sha256
      : updated !== null && fs.statSync(source).mtimeMs > updated;
    if (changed) sourceNewerThanNodeCount += 1;
  }
  const unresolvedObsoleteCount = graph.nodes.filter((node) => node.st === "obsolete").length;
  const unresolvedConflictCount = graph.nodes.filter((node) => node.st === "conflicting").length;
  const catalogAgeDays = catalog?.generatedAt ? ageDays(catalog.generatedAt, nowMs) : null;
  const graphAgeDays = version?.updated ? ageDays(version.updated, nowMs) : null;
  const status = staleNodeCount > 0 || sourceNewerThanNodeCount > 0 || unresolvedObsoleteCount > 0 || unresolvedConflictCount > 0
    ? "ATTENTION"
    : "PASS";
  return {
    status,
    graphAgeDays,
    catalogAgeDays,
    updatedLast7Days: ages.filter((value) => value <= 7).length,
    updatedLast30Days: ages.filter((value) => value <= 30).length,
    staleNodeCount,
    ageExemptNodeCount,
    sourceNewerThanNodeCount,
    mtimeExemptSourceCount: [...policies.values()].filter((policy) => policy.trackSourceChanges === false).length,
    oldestNodeAgeDays: ages.length ? Math.max(...ages) : null,
    medianNodeAgeDays: percentile(ages, 0.5),
    p95NodeAgeDays: percentile(ages, 0.95),
    unresolvedObsoleteCount,
    unresolvedConflictCount
  };
}

function globToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "@@GLOBSTAR@@")
    .replace(/\*/g, "[^/]*")
    .replace(/@@GLOBSTAR@@/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function listMarkdown(workspaceRoot, rootPath) {
  const absolute = absolutePath(workspaceRoot, rootPath);
  if (!absolute || !fs.existsSync(absolute)) return [];
  const output = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const nested = path.join(current, entry.name);
      if (entry.isDirectory()) visit(nested);
      if (entry.isFile() && /\.md$/i.test(entry.name)) output.push(posix(path.relative(workspaceRoot, nested)));
    }
  }
  visit(absolute);
  return output;
}

function coverageHealth(workspaceRoot, registryPath, graph, nowMs) {
  if (!registryPath) return { status: "NONE", registeredSourceCount: 0 };
  const registry = readJson(workspaceRoot, registryPath);
  if (!registry.ok || !Array.isArray(registry.value.sources)) {
    return { status: "BLOCKED", error: registry.ok ? "registry requires sources array" : registry.error };
  }
  const sourceEntries = registry.value.sources;
  const errors = [];
  const nodeSources = new Map();
  for (const node of graph.nodes) {
    const key = posix(node.src);
    nodeSources.set(key, [...(nodeSources.get(key) ?? []), node]);
  }
  let registeredWithNodeCount = 0;
  let missingRegisteredSourceCount = 0;
  let changedRegisteredSourceCount = 0;
  const registeredPaths = new Set();
  for (const entry of sourceEntries) {
    const sourcePath = relativePath(workspaceRoot, entry?.path);
    if (!sourcePath) {
      errors.push("registry source escapes workspace");
      continue;
    }
    registeredPaths.add(sourcePath);
    const nodes = nodeSources.get(sourcePath) ?? [];
    if (nodes.length > 0) registeredWithNodeCount += 1;
    const source = path.join(workspaceRoot, sourcePath);
    if (!fs.existsSync(source)) {
      missingRegisteredSourceCount += 1;
      continue;
    }
    const latestNodeUpdate = Math.max(...nodes.map((node) => dateMs(node.u) ?? 0), 0);
    const trackSourceChanges = entry?.freshness?.trackSourceChanges !== false;
    const expectedSha256 = typeof entry?.sha256 === "string" ? entry.sha256.toLowerCase() : null;
    const changed = expectedSha256
      ? fileSha256(source) !== expectedSha256
      : fs.statSync(source).mtimeMs > latestNodeUpdate;
    if (nodes.length === 0 || (trackSourceChanges && changed)) {
      changedRegisteredSourceCount += 1;
    }
    if (entry?.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      errors.push(`registry source sha256 must be a 64-character hexadecimal digest: ${sourcePath}`);
    }
    if (entry?.freshness) {
      const maxAgeDays = entry.freshness.maxAgeDays;
      if (maxAgeDays !== undefined && maxAgeDays !== null && (!Number.isFinite(maxAgeDays) || maxAgeDays < 0)) {
        errors.push(`registry freshness maxAgeDays must be null or a non-negative number: ${sourcePath}`);
      }
      if (entry.freshness.trackSourceChanges !== undefined && typeof entry.freshness.trackSourceChanges !== "boolean") {
        errors.push(`registry freshness trackSourceChanges must be boolean: ${sourcePath}`);
      }
    }
  }
  const excluded = Array.isArray(registry.value.excluded) ? registry.value.excluded : [];
  const excludedPatterns = excluded
    .filter((entry) => typeof entry?.pattern === "string" && typeof entry?.reason === "string" && entry.reason.trim() !== "")
    .map((entry) => globToRegex(entry.pattern));
  if (excludedPatterns.length !== excluded.length) errors.push("registry exclusions require pattern and reason");
  const scanned = new Set((registry.value.scanRoots ?? []).flatMap((root) => listMarkdown(workspaceRoot, root)));
  const unclassified = [...scanned].filter((sourcePath) => !registeredPaths.has(sourcePath) && !excludedPatterns.some((pattern) => pattern.test(sourcePath)));
  const status = errors.length > 0 || missingRegisteredSourceCount > 0
    ? "BLOCKED"
    : changedRegisteredSourceCount > 0 || unclassified.length > 0
      ? "ATTENTION"
      : "PASS";
  return {
    status,
    registryVersion: registry.value.version ?? null,
    registeredSourceCount: sourceEntries.length,
    registeredWithNodeCount,
    missingRegisteredSourceCount,
    changedRegisteredSourceCount,
    excludedSourceCount: excluded.length,
    unclassifiedSourceCount: unclassified.length,
    unclassifiedSamples: unclassified.slice(0, 10),
    sourceToNodeCardinality: graph.nodes.length === 0 ? 0 : Number((sourceEntries.length / graph.nodes.length).toFixed(2)),
    nodeToSourceCardinality: sourceEntries.length === 0 ? 0 : Number((graph.nodes.length / sourceEntries.length).toFixed(2)),
    errors
  };
}

function retrievalHealth(workspaceRoot, config) {
  try {
    const coverage = collectFileOnlyCoverage(workspaceRoot, {
      graphDir: config.graphDir,
      versionPath: config.versionPath,
      catalogPath: config.catalogPath,
      scenario: config.scenario,
      corpusEntrypoints: config.corpusEntrypoints,
      corpusRoots: config.corpusRoots,
      minHitRate: config.minHitRate
    });
    const failuresByDomain = {};
    for (const result of coverage.results.filter((result) => result.status !== "PASS")) {
      const domain = result.domain ?? "unclassified";
      failuresByDomain[domain] = (failuresByDomain[domain] ?? 0) + 1;
    }
    return {
      status: coverage.summary.ok && coverage.summary.blockedCount === 0 ? "PASS" : "ATTENTION",
      scenarioVersion: coverage.scenario.version,
      scenarioCount: coverage.scenario.queryCount,
      top1HitRate: coverage.summary.hitRate,
      oneHopHitRate: coverage.summary.oneHopHitRate,
      sourceReadyRate: coverage.scenario.queryCount === 0
        ? 0
        : (coverage.scenario.queryCount - coverage.summary.missingSourceCount) / coverage.scenario.queryCount,
      failuresByDomain,
      coverage
    };
  } catch (error) {
    return { status: "BLOCKED", error: error.message };
  }
}

export function collectPamHealth(workspaceRoot, options = {}) {
  const root = path.resolve(workspaceRoot);
  const config = {
    ...DEFAULTS,
    ...options,
    graphDir: options.graphDir ?? DEFAULTS.graphDir,
    versionPath: options.versionPath ?? DEFAULTS.versionPath
  };
  config.catalogPath ??= `${config.graphDir}/catalog.json`;
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const graph = loadGraph(root, { graphDir: config.graphDir });
  const structural = nodeIntegrity(graph, root);
  const catalog = catalogIntegrity(root, config.graphDir, graph);
  if (catalog.status === "BLOCKED") structural.errors.push(...catalog.errors);
  structural.status = structural.errors.length === 0 ? "PASS" : "BLOCKED";
  const version = readJson(root, config.versionPath);
  if (!version.ok) {
    structural.errors.push("PAM version is missing or invalid");
    structural.status = "BLOCKED";
  }
  const fresh = freshness(
    graph,
    root,
    version.ok ? version.value : null,
    catalog.catalog,
    nowMs,
    config.staleAfterDays,
    config.sourceRegistry
  );
  const retrieval = retrievalHealth(root, config);
  const coverage = coverageHealth(root, config.sourceRegistry, graph, nowMs);
  const stats = graphStats(root, { graphDir: config.graphDir });
  const readVolume = retrieval.coverage?.readVolume?.pamFirstCore ?? null;
  const efficiency = {
    status: readVolume && retrieval.coverage.summary.coreBudgetOk && retrieval.coverage.summary.sourceBudgetOk ? "PASS" : "ATTENTION",
    graphCoreFileCount: readVolume?.fileCount ?? null,
    graphCoreBytes: readVolume?.bytes ?? null,
    graphCoreTokenProxy: readVolume?.tokenProxy ?? null,
    p50QueryDurationMs: null,
    p95QueryDurationMs: null,
    broadCorpusFallbackCount: null
  };
  const status = statusOf(structural.status, fresh.status, retrieval.status, coverage.status, efficiency.status);
  return {
    schemaVersion: "pam-health/v1",
    generatedAt: new Date(nowMs).toISOString(),
    status,
    privacy: { aggregateOnly: true, rawTextIncluded: false, absolutePathsIncluded: false },
    structural: {
      ...structural,
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
      aliases: stats.aliasCount,
      graphBytes: stats.bytes
    },
    freshness: fresh,
    retrieval,
    coverage,
    efficiency,
    configuration: {
      graphDir: config.graphDir,
      versionPath: config.versionPath,
      catalogPath: config.catalogPath,
      scenario: config.scenario,
      sourceRegistry: config.sourceRegistry ?? null,
      staleAfterDays: config.staleAfterDays
    }
  };
}
