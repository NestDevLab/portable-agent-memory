import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const GRAPH_DIR = "memory/graph";
const MAX_NODE_DIGEST_CHARS = 180;

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
