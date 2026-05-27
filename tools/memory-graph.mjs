import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const GRAPH_DIR = "memory/graph";
const MAX_NODE_DIGEST_CHARS = 180;
const DEFAULT_COVERAGE_SCENARIO = "benchmarks/file-only-coverage.json";
const DEFAULT_FILE_ONLY_BUDGET = {
  maxCoreFiles: 5,
  maxCoreBytes: 100 * 1024,
  maxSourceFilesPerQuery: 1,
  minHitRate: 0.8
};

function resolveWorkspacePath(workspaceRoot, relativePath) {
  return path.join(workspaceRoot, relativePath);
}

function toPosixPath(inputPath) {
  return inputPath.split(path.sep).join("/");
}

function readJsonl(workspaceRoot, relativePath) {
  const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter((entry) => entry.line.trim() !== "")
    .map((entry) => {
      try {
        return JSON.parse(entry.line);
      } catch (error) {
        throw new Error(`Invalid JSONL in ${relativePath}:${entry.lineNumber}: ${error.message}`);
      }
    });
}

function loadGraph(workspaceRoot = WORKSPACE_ROOT) {
  return {
    aliases: readJsonl(workspaceRoot, `${GRAPH_DIR}/aliases.jsonl`),
    edges: readJsonl(workspaceRoot, `${GRAPH_DIR}/edges.jsonl`),
    nodes: readJsonl(workspaceRoot, `${GRAPH_DIR}/nodes.jsonl`)
  };
}

function validateGraph(graph) {
  const errors = [];
  const warnings = [];
  const nodeIds = new Set();
  const requiredNodeFields = ["id", "k", "n", "d", "st", "c", "u", "src"];
  const requiredEdgeFields = ["f", "r", "t", "st", "c", "u", "src"];

  for (const node of graph.nodes) {
    for (const field of requiredNodeFields) {
      if (typeof node[field] !== "string" || node[field].trim() === "") {
        errors.push(`Node missing ${field}: ${JSON.stringify(node)}`);
      }
    }

    if (nodeIds.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`);
    }
    nodeIds.add(node.id);

    if (typeof node.d === "string" && node.d.length > MAX_NODE_DIGEST_CHARS) {
      errors.push(`Node digest exceeds ${MAX_NODE_DIGEST_CHARS} chars: ${node.id}`);
    }
  }

  for (const edge of graph.edges) {
    for (const field of requiredEdgeFields) {
      if (typeof edge[field] !== "string" || edge[field].trim() === "") {
        errors.push(`Edge missing ${field}: ${JSON.stringify(edge)}`);
      }
    }

    if (!nodeIds.has(edge.f)) {
      errors.push(`Dangling edge source: ${edge.f}`);
    }
    if (!nodeIds.has(edge.t)) {
      errors.push(`Dangling edge target: ${edge.t}`);
    }
  }

  for (const alias of graph.aliases) {
    if (typeof alias.a !== "string" || alias.a.trim() === "") {
      errors.push(`Alias missing a: ${JSON.stringify(alias)}`);
    }
    if (typeof alias.id !== "string" || alias.id.trim() === "") {
      errors.push(`Alias missing id: ${JSON.stringify(alias)}`);
    } else if (!nodeIds.has(alias.id)) {
      errors.push(`Alias target missing: ${alias.id}`);
    }
  }

  return {
    errors,
    ok: errors.length === 0,
    warnings
  };
}

function buildCatalog(workspaceRoot = WORKSPACE_ROOT, options = {}) {
  const graph = loadGraph(workspaceRoot);
  const validation = validateGraph(graph);
  return {
    schemaVersion: "pam-graph-v1",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    aliasCount: graph.aliases.length,
    sourceFiles: [
      `${GRAPH_DIR}/nodes.jsonl`,
      `${GRAPH_DIR}/edges.jsonl`,
      `${GRAPH_DIR}/aliases.jsonl`
    ],
    entrypoints: {
      runtime: "memory/agent-memory/pam-runtime.md",
      version: "memory/pam.version.json",
      index: "memory/index.md"
    },
    budgets: {
      maxNodeDigestChars: MAX_NODE_DIGEST_CHARS
    },
    health: {
      status: validation.ok ? "valid" : "invalid",
      warnings: validation.warnings,
      errors: validation.errors
    }
  };
}

function normalize(value) {
  return String(value ?? "").toLowerCase();
}

function matchesQuery(node, query) {
  const q = normalize(query);
  if (q === "") {
    return true;
  }
  return [node.id, node.k, node.n, node.d, node.src, ...(node.tags ?? [])]
    .map(normalize)
    .some((value) => value.includes(q));
}

function queryGraph(graph, options = {}) {
  const alias = graph.aliases.find((entry) => normalize(entry.a) === normalize(options.query));
  const relationFilter = options.relation ? normalize(options.relation) : null;
  const kindFilter = options.kind ? normalize(options.kind) : null;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 10;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const candidateNodes = alias
    ? graph.nodes.filter((node) => node.id === alias.id)
    : graph.nodes.filter((node) => matchesQuery(node, options.query));

  const filteredNodes = candidateNodes.filter((node) => !kindFilter || normalize(node.k) === kindFilter);
  const results = filteredNodes.slice(0, limit).map((node) => {
    const edges = graph.edges
      .filter((edge) => edge.f === node.id || edge.t === node.id)
      .filter((edge) => !relationFilter || normalize(edge.r) === relationFilter)
      .map((edge) => ({
        f: edge.f,
        r: edge.r,
        t: edge.t,
        peer: edge.f === node.id ? nodeById.get(edge.t)?.n : nodeById.get(edge.f)?.n,
        src: edge.src
      }));

    return {
      id: node.id,
      k: node.k,
      n: node.n,
      d: node.d,
      st: node.st,
      c: node.c,
      src: node.src,
      edges
    };
  });

  return {
    query: options.query ?? "",
    aliasResolvedTo: alias?.id ?? null,
    results
  };
}

function graphStats(workspaceRoot = WORKSPACE_ROOT) {
  const graph = loadGraph(workspaceRoot);
  const files = [`${GRAPH_DIR}/nodes.jsonl`, `${GRAPH_DIR}/edges.jsonl`, `${GRAPH_DIR}/aliases.jsonl`];
  const fileStats = files.map((relativePath) => {
    const content = fs.readFileSync(resolveWorkspacePath(workspaceRoot, relativePath), "utf8");
    return {
      path: relativePath,
      bytes: Buffer.byteLength(content),
      words: content.trim() === "" ? 0 : content.trim().split(/\s+/).length
    };
  });

  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    aliasCount: graph.aliases.length,
    bytes: fileStats.reduce((sum, entry) => sum + entry.bytes, 0),
    words: fileStats.reduce((sum, entry) => sum + entry.words, 0),
    files: fileStats
  };
}

function fileMetric(workspaceRoot, relativePath) {
  const content = fs.readFileSync(resolveWorkspacePath(workspaceRoot, relativePath), "utf8");
  return {
    path: relativePath,
    bytes: Buffer.byteLength(content),
    tokenProxy: Math.ceil(Buffer.byteLength(content) / 4)
  };
}

function aggregateFileMetrics(workspaceRoot, files) {
  const uniqueFiles = [...new Set(files)].filter((file) => fs.existsSync(resolveWorkspacePath(workspaceRoot, file)));
  const metrics = uniqueFiles.map((file) => fileMetric(workspaceRoot, file));
  return {
    fileCount: metrics.length,
    bytes: metrics.reduce((sum, entry) => sum + entry.bytes, 0),
    tokenProxy: metrics.reduce((sum, entry) => sum + entry.tokenProxy, 0),
    files: metrics
  };
}

function listFilesRecursive(workspaceRoot, relativeDir) {
  const absoluteDir = resolveWorkspacePath(workspaceRoot, relativeDir);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relativePath = toPosixPath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      return listFilesRecursive(workspaceRoot, relativePath);
    }
    if (entry.isFile()) {
      return [relativePath];
    }
    return [];
  });
}

function defaultCoverageQueries() {
  return [
    { q: "PAM", expectedId: "project:pam" },
    { q: "runtime guide", expectedId: "doc:runtime" },
    { q: "graph cli", expectedId: "tool:graph" },
    { q: "markdown migration", expectedId: "migration:markdown-to-graph-v1" },
    { q: "agent-facing runbooks", expectedId: "principle:agent-facing-runbooks" }
  ];
}

function readCoverageScenario(workspaceRoot, scenarioPath) {
  const absolutePath = resolveWorkspacePath(workspaceRoot, scenarioPath);
  if (!fs.existsSync(absolutePath)) {
    return {
      path: scenarioPath,
      queries: defaultCoverageQueries()
    };
  }

  const scenario = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!Array.isArray(scenario.queries)) {
    throw new Error(`Coverage scenario must include a queries array: ${scenarioPath}`);
  }
  return {
    path: scenarioPath,
    name: scenario.name,
    queries: scenario.queries
  };
}

function collectFileOnlyCoverage(workspaceRoot = WORKSPACE_ROOT, options = {}) {
  const graph = loadGraph(workspaceRoot);
  const validation = validateGraph(graph);
  const scenario = readCoverageScenario(workspaceRoot, options.scenario ?? DEFAULT_COVERAGE_SCENARIO);
  const budget = {
    maxCoreFiles: options.maxCoreFiles ?? DEFAULT_FILE_ONLY_BUDGET.maxCoreFiles,
    maxCoreBytes: options.maxCoreBytes ?? DEFAULT_FILE_ONLY_BUDGET.maxCoreBytes,
    maxSourceFilesPerQuery: options.maxSourceFilesPerQuery ?? DEFAULT_FILE_ONLY_BUDGET.maxSourceFilesPerQuery,
    minHitRate: options.minHitRate ?? DEFAULT_FILE_ONLY_BUDGET.minHitRate
  };
  const coreFiles = [
    "memory/pam.version.json",
    `${GRAPH_DIR}/catalog.json`,
    `${GRAPH_DIR}/aliases.jsonl`,
    `${GRAPH_DIR}/nodes.jsonl`,
    `${GRAPH_DIR}/edges.jsonl`
  ];
  const corpusFiles = [
    "AGENT_BOOTSTRAP.md",
    "README.md",
    ...listFilesRecursive(workspaceRoot, "memory").filter((file) => /\.(json|jsonl|md)$/i.test(file))
  ];
  const coreRead = aggregateFileMetrics(workspaceRoot, coreFiles);
  const corpusRead = aggregateFileMetrics(workspaceRoot, corpusFiles);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  const queryResults = scenario.queries.map((entry) => {
    const query = entry.q ?? entry.query ?? "";
    const expectedId = entry.expectedId ?? null;
    const result = queryGraph(graph, { query, limit: 3 });
    const resultIds = result.results.map((node) => node.id);
    const topResult = result.results[0] ?? null;
    const expectedNode = expectedId ? nodeById.get(expectedId) : null;
    const targetSources = expectedNode ? [expectedNode.src] : result.results.map((node) => node.src);
    const sourceRead = aggregateFileMetrics(workspaceRoot, targetSources.slice(0, budget.maxSourceFilesPerQuery));
    const expectedMatched = expectedId ? resultIds.includes(expectedId) : resultIds.length > 0;
    const topMatched = expectedId ? topResult?.id === expectedId : Boolean(topResult);
    const status = topMatched ? "PASS" : expectedMatched ? "PARTIAL" : "BLOCKED";

    return {
      query,
      expectedId,
      aliasResolvedTo: result.aliasResolvedTo,
      resultIds,
      topId: topResult?.id ?? null,
      status,
      sourceRead,
      notes: {
        opensRawSourceText: false,
        candidateSourceCount: new Set(result.results.map((node) => node.src)).size
      }
    };
  });

  const passCount = queryResults.filter((entry) => entry.status === "PASS").length;
  const partialCount = queryResults.filter((entry) => entry.status === "PARTIAL").length;
  const blockedCount = queryResults.filter((entry) => entry.status === "BLOCKED").length;
  const hitRate = queryResults.length === 0 ? 0 : passCount / queryResults.length;
  const coreBudgetOk = coreRead.fileCount <= budget.maxCoreFiles && coreRead.bytes <= budget.maxCoreBytes;
  const sourceBudgetOk = queryResults.every((entry) => entry.sourceRead.fileCount <= budget.maxSourceFilesPerQuery);
  const ok = validation.ok && coreBudgetOk && sourceBudgetOk && hitRate >= budget.minHitRate;

  return {
    coverageVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    privacy: {
      aggregateOnly: true,
      rawTextIncluded: false,
      absolutePathsIncluded: false
    },
    scenario: {
      path: scenario.path,
      name: scenario.name ?? null,
      queryCount: queryResults.length
    },
    budget,
    graph: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      aliasCount: graph.aliases.length,
      valid: validation.ok
    },
    readVolume: {
      pamFirstCore: coreRead,
      corpusFirst: corpusRead
    },
    results: queryResults,
    summary: {
      ok,
      passCount,
      partialCount,
      blockedCount,
      hitRate,
      coreBudgetOk,
      sourceBudgetOk
    }
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "validate";
  const options = { command, json: false, limit: 10 };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--q") {
      options.query = args.shift() ?? "";
    } else if (arg === "--kind") {
      options.kind = args.shift() ?? "";
    } else if (arg === "--rel") {
      options.relation = args.shift() ?? "";
    } else if (arg === "--limit") {
      options.limit = Number(args.shift() ?? "10");
    } else if (arg === "--scenario") {
      options.scenario = args.shift();
    } else if (arg === "--max-files") {
      options.maxCoreFiles = Number(args.shift() ?? DEFAULT_FILE_ONLY_BUDGET.maxCoreFiles);
    } else if (arg === "--max-bytes") {
      options.maxCoreBytes = Number(args.shift() ?? DEFAULT_FILE_ONLY_BUDGET.maxCoreBytes);
    } else if (arg === "--max-source-files") {
      options.maxSourceFilesPerQuery = Number(args.shift() ?? DEFAULT_FILE_ONLY_BUDGET.maxSourceFilesPerQuery);
    } else if (arg === "--min-hit-rate") {
      options.minHitRate = Number(args.shift() ?? DEFAULT_FILE_ONLY_BUDGET.minHitRate);
    } else if (arg === "--generated-at") {
      options.generatedAt = args.shift();
    }
  }

  return options;
}

function print(data, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

export {
  buildCatalog,
  collectFileOnlyCoverage,
  graphStats,
  loadGraph,
  queryGraph,
  validateGraph
};

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "validate") {
    const result = validateGraph(loadGraph());
    print(result, options.json);
    if (!result.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.command === "query") {
    print(queryGraph(loadGraph(), options), options.json);
    return;
  }

  if (options.command === "stats") {
    print(graphStats(), options.json);
    return;
  }

  if (options.command === "coverage") {
    const result = collectFileOnlyCoverage(WORKSPACE_ROOT, options);
    print(result, options.json);
    if (!result.summary.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (options.command === "index") {
    const catalog = buildCatalog();
    const catalogPath = resolveWorkspacePath(WORKSPACE_ROOT, `${GRAPH_DIR}/catalog.json`);
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    print({ wrote: toPosixPath(path.relative(WORKSPACE_ROOT, catalogPath)), health: catalog.health }, options.json);
    return;
  }

  throw new Error(`Unsupported memory-graph command: ${options.command}`);
}

if (process.argv[1] === __filename) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
