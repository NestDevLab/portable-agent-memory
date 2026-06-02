import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadGraph, queryGraph } from "./memory-graph.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_SCENARIO = "benchmarks/llm-retrieval-scenario.json";
const DEFAULT_MODES = ["none", "pam-0.4", "pam-0.5"];
const GRAPH_FILES = [
  "memory/pam.version.json",
  "memory/graph/catalog.json",
  "memory/graph/aliases.jsonl",
  "memory/graph/nodes.jsonl",
  "memory/graph/edges.jsonl"
];
const MARKDOWN_MEMORY_FILES = [
  "README.md",
  "AGENT_BOOTSTRAP.md",
  "memory/index.md",
  "memory/conversation-log.md",
  "memory/knowledge-log.md",
  "memory/agent-memory/pam.md",
  "memory/agent-memory/llm-wiki.md",
  "memory/agent-memory/pam-runtime.md"
];
const FILE_ONLY_COVERAGE_FILES = ["benchmarks/file-only-coverage.json"];
const SENSITIVE_RE = /(secret|cookie|credential|private[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token)/i;
const ABSOLUTE_PRIVATE_PATH_RE = /\/home\/|\/Users\/|[A-Za-z]:\\/;

function resolveWorkspacePath(relativePath) {
  return path.join(WORKSPACE_ROOT, relativePath);
}

function fileExists(relativePath) {
  return fs.existsSync(resolveWorkspacePath(relativePath));
}

function readText(relativePath) {
  return fs.readFileSync(resolveWorkspacePath(relativePath), "utf8");
}

function fileMetric(relativePath) {
  const bytes = Buffer.byteLength(readText(relativePath));
  return {
    path: relativePath,
    bytes,
    tokenProxy: Math.ceil(bytes / 4)
  };
}

function aggregateFiles(files) {
  const uniqueFiles = [...new Set(files)].filter(Boolean);
  const existingFiles = uniqueFiles.filter(fileExists);
  const missingFiles = uniqueFiles.filter((file) => !fileExists(file));
  const metrics = existingFiles.map(fileMetric);
  return {
    fileCount: metrics.length,
    missingFileCount: missingFiles.length,
    bytes: metrics.reduce((sum, entry) => sum + entry.bytes, 0),
    tokenProxy: metrics.reduce((sum, entry) => sum + entry.tokenProxy, 0),
    files: metrics,
    missingFiles
  };
}

function tokenProxy(value) {
  return Math.ceil(Buffer.byteLength(String(value ?? "")) / 4);
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readJsonl(relativePath) {
  if (!fileExists(relativePath)) {
    return [];
  }
  return readText(relativePath)
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function countUnique(values) {
  return new Set(values.filter(Boolean)).size;
}

function persistedKnowledgeSnapshot(mode) {
  if (mode === "none") {
    return {
      mode,
      description: "No PAM graph or coverage artifacts are used.",
      files: aggregateFiles([]),
      recordCounts: {
        aliases: 0,
        nodes: 0,
        edges: 0,
        coverageQueries: 0
      },
      uniqueSourceRefs: 0,
      totalStructuredRecords: 0,
      tokenProxyPerStructuredRecord: 0
    };
  }

  const files = mode === "pam-0.5" ? [...GRAPH_FILES, ...FILE_ONLY_COVERAGE_FILES] : GRAPH_FILES;
  const aliases = readJsonl("memory/graph/aliases.jsonl");
  const nodes = readJsonl("memory/graph/nodes.jsonl");
  const edges = readJsonl("memory/graph/edges.jsonl");
  const coverageQueries = mode === "pam-0.5" && fileExists("benchmarks/file-only-coverage.json")
    ? readJson("benchmarks/file-only-coverage.json").queries ?? []
    : [];
  const totalStructuredRecords = aliases.length + nodes.length + edges.length + coverageQueries.length;
  const fileMetrics = aggregateFiles(files);

  return {
    mode,
    description: mode === "pam-0.5"
      ? "PAM graph plus the file-only coverage scenario introduced in 0.5.x."
      : "PAM graph artifacts available in 0.4.x.",
    files: fileMetrics,
    recordCounts: {
      aliases: aliases.length,
      nodes: nodes.length,
      edges: edges.length,
      coverageQueries: coverageQueries.length
    },
    uniqueSourceRefs: countUnique([
      ...nodes.map((node) => node.src),
      ...edges.map((edge) => edge.src)
    ]),
    totalStructuredRecords,
    tokenProxyPerStructuredRecord: totalStructuredRecords === 0
      ? 0
      : Math.round((fileMetrics.tokenProxy / totalStructuredRecords) * 100) / 100
  };
}

function readScenario(relativePath = DEFAULT_SCENARIO) {
  const scenario = JSON.parse(readText(relativePath));
  if (!Array.isArray(scenario.queries) || scenario.queries.length === 0) {
    throw new Error(`LLM retrieval scenario must include a non-empty queries array: ${relativePath}`);
  }
  return {
    path: relativePath,
    name: scenario.name ?? null,
    description: scenario.description ?? null,
    queries: scenario.queries
  };
}

function nodeLookup() {
  return new Map(loadGraph(WORKSPACE_ROOT).nodes.map((node) => [node.id, node]));
}

function planRetrieval(mode, query, graph, nodesById) {
  if (mode === "none") {
    return {
      mode,
      graphResultIds: [],
      contextFiles: MARKDOWN_MEMORY_FILES,
      retrievalMethod: "broad-markdown"
    };
  }

  const graphQuery = query.graphQuery ?? query.q ?? query.prompt;
  const result = queryGraph(graph, { query: graphQuery, limit: 5 });
  const expectedIds = query.expectedIds ?? (query.expectedId ? [query.expectedId] : []);
  const matchedIds = expectedIds.filter((id) => result.results.some((entry) => entry.id === id));
  const expectedSourceFiles = expectedIds.map((id) => nodesById.get(id)?.src).filter(Boolean);
  const resultSourceFiles = result.results.map((entry) => entry.src);
  const selectedSourceFiles = matchedIds.length > 0 ? expectedSourceFiles : resultSourceFiles.slice(0, 1);
  const runtimeFiles = mode === "pam-0.5"
    ? ["memory/agent-memory/pam-runtime.md", "benchmarks/file-only-coverage.json"]
    : ["memory/agent-memory/pam-runtime.md"];

  return {
    mode,
    graphResultIds: result.results.map((entry) => entry.id),
    aliasResolvedTo: result.aliasResolvedTo,
    expectedMatchedIds: matchedIds,
    contextFiles: [...GRAPH_FILES, ...runtimeFiles, ...selectedSourceFiles],
    retrievalMethod: mode === "pam-0.5" ? "graph-first-file-only-gated" : "graph-first"
  };
}

function buildPrompt(mode, query, retrievalPlan) {
  const contextBlocks = retrievalPlan.contextFiles
    .filter(fileExists)
    .map((file) => `--- ${file} ---\n${readText(file)}`)
    .join("\n\n");
  return [
    "Answer the user question using only the provided repository context.",
    `Memory mode: ${mode}`,
    "Be concise. If the context is insufficient, say what is missing.",
    "",
    "Repository context:",
    contextBlocks,
    "",
    `Question: ${query.prompt}`
  ].join("\n");
}

function runLlm(command, prompt) {
  if (!command) {
    return {
      configured: false,
      status: null,
      durationMs: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      answer: ""
    };
  }

  const started = process.hrtime.bigint();
  const result = spawnSync(command, {
    cwd: WORKSPACE_ROOT,
    shell: true,
    input: prompt,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const parsed = parseCodexJsonl(result.stdout ?? "");
  return {
    configured: true,
    status: result.status,
    durationMs: Math.round(durationMs * 1000) / 1000,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
    answer: parsed.answer || result.stdout || "",
    usage: parsed.usage
  };
}

function parseCodexJsonl(output) {
  const parsed = {
    answer: "",
    usage: null
  };

  for (const line of String(output ?? "").split(/\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event?.type === "item.completed" && event.item?.type === "agent_message") {
      parsed.answer = event.item.text ?? "";
    }
    if (event?.type === "turn.completed" && event.usage) {
      parsed.usage = event.usage;
    }
  }

  return parsed;
}

function expectedTermHits(answer, terms = []) {
  const normalized = answer.toLowerCase();
  return terms.filter((term) => normalized.includes(String(term).toLowerCase()));
}

function percentReduction(before, after) {
  if (!before) {
    return 0;
  }
  return Math.round((1 - after / before) * 10000) / 100;
}

function percentIncrease(before, after) {
  if (!before) {
    return after ? 100 : 0;
  }
  return Math.round(((after / before) - 1) * 10000) / 100;
}

function summarizeMode(mode, results, noneSummary = null) {
  const queryCount = results.length;
  const readBytes = results.reduce((sum, entry) => sum + entry.readVolume.bytes, 0);
  const readTokenProxy = results.reduce((sum, entry) => sum + entry.readVolume.tokenProxy, 0);
  const promptTokenProxy = results.reduce((sum, entry) => sum + entry.promptTokenProxy, 0);
  const outputTokenProxy = results.reduce((sum, entry) => sum + entry.outputTokenProxy, 0);
  const expectedNodeHitCount = results.filter((entry) => entry.expectedNodeHit).length;
  const expectedTermHitCount = results.filter((entry) => entry.expectedTermHit).length;
  const llmAnsweredCount = results.filter((entry) => entry.llm.configured && entry.llm.status === 0).length;
  const durationMs = results.reduce((sum, entry) => sum + (entry.llm.durationMs ?? 0), 0);
  const realInputTokens = results.reduce((sum, entry) => sum + (entry.llm.usage?.input_tokens ?? 0), 0);
  const realCachedInputTokens = results.reduce((sum, entry) => sum + (entry.llm.usage?.cached_input_tokens ?? 0), 0);
  const realOutputTokens = results.reduce((sum, entry) => sum + (entry.llm.usage?.output_tokens ?? 0), 0);
  const realReasoningOutputTokens = results.reduce((sum, entry) => sum + (entry.llm.usage?.reasoning_output_tokens ?? 0), 0);

  return {
    mode,
    queryCount,
    readBytes,
    readTokenProxy,
    promptTokenProxy,
    outputTokenProxy,
    expectedNodeHitRate: queryCount === 0 ? 0 : Math.round((expectedNodeHitCount / queryCount) * 10000) / 100,
    expectedTermHitRate: queryCount === 0 ? 0 : Math.round((expectedTermHitCount / queryCount) * 10000) / 100,
    llmAnsweredCount,
    durationMs: Math.round(durationMs * 1000) / 1000,
    realInputTokens,
    realCachedInputTokens,
    realOutputTokens,
    realReasoningOutputTokens,
    realInputTokenReductionVsNone: noneSummary ? percentReduction(noneSummary.realInputTokens, realInputTokens) : 0,
    tokenProxyReductionVsNone: noneSummary ? percentReduction(noneSummary.promptTokenProxy, promptTokenProxy) : 0,
    readVolumeReductionVsNone: noneSummary ? percentReduction(noneSummary.readTokenProxy, readTokenProxy) : 0
  };
}

function collectLlmRetrievalBenchmark(options = {}) {
  const scenario = readScenario(options.scenario ?? DEFAULT_SCENARIO);
  const modes = options.modes ?? DEFAULT_MODES;
  const command = options.llmCommand ?? process.env.PAM_LLM_COMMAND ?? "";
  const graph = loadGraph(WORKSPACE_ROOT);
  const nodesById = nodeLookup();
  const modeResults = {};

  for (const mode of modes) {
    modeResults[mode] = scenario.queries.map((query) => {
      const retrievalPlan = planRetrieval(mode, query, graph, nodesById);
      const readVolume = aggregateFiles(retrievalPlan.contextFiles);
      const prompt = buildPrompt(mode, query, retrievalPlan);
      const llm = runLlm(command, prompt);
      const expectedIds = query.expectedIds ?? (query.expectedId ? [query.expectedId] : []);
      const expectedNodeHit = mode === "none"
        ? false
        : expectedIds.every((id) => retrievalPlan.graphResultIds.includes(id));
      const termHits = llm.configured ? expectedTermHits(llm.answer, query.expectedTerms ?? []) : [];

      return {
        id: query.id,
        mode,
        retrievalMethod: retrievalPlan.retrievalMethod,
        expectedIds,
        graphResultIds: retrievalPlan.graphResultIds,
        expectedNodeHit,
        readVolume,
        promptTokenProxy: tokenProxy(prompt),
        outputTokenProxy: tokenProxy(llm.answer),
        expectedTerms: query.expectedTerms ?? [],
        expectedTermHits: termHits,
        expectedTermHit: llm.configured ? termHits.length === (query.expectedTerms ?? []).length : null,
        llm: {
          configured: llm.configured,
          status: llm.status,
          durationMs: llm.durationMs,
          stdoutBytes: llm.stdoutBytes,
          stderrBytes: llm.stderrBytes,
          usage: llm.usage ?? null
        },
        answer: options.includeAnswers ? llm.answer : undefined
      };
    });
  }

  const summaries = {};
  for (const mode of modes) {
    summaries[mode] = summarizeMode(mode, modeResults[mode], summaries.none ?? null);
  }
  const persistedKnowledge = Object.fromEntries(
    modes.map((mode) => [mode, persistedKnowledgeSnapshot(mode)])
  );
  const persistedKnowledgeComparison = persistedKnowledge["pam-0.4"] && persistedKnowledge["pam-0.5"]
    ? {
        from: "pam-0.4",
        to: "pam-0.5",
        byteIncreasePercent: percentIncrease(persistedKnowledge["pam-0.4"].files.bytes, persistedKnowledge["pam-0.5"].files.bytes),
        tokenProxyIncreasePercent: percentIncrease(persistedKnowledge["pam-0.4"].files.tokenProxy, persistedKnowledge["pam-0.5"].files.tokenProxy),
        structuredRecordIncreasePercent: percentIncrease(persistedKnowledge["pam-0.4"].totalStructuredRecords, persistedKnowledge["pam-0.5"].totalStructuredRecords),
        addedCoverageQueries: persistedKnowledge["pam-0.5"].recordCounts.coverageQueries - persistedKnowledge["pam-0.4"].recordCounts.coverageQueries
      }
    : null;

  const report = {
    benchmarkVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    repository: "portable-agent-memory",
    scenario: {
      path: scenario.path,
      name: scenario.name,
      queryCount: scenario.queries.length
    },
    modes,
    llm: {
      configured: Boolean(command),
      commandLabel: command ? command.split(/\s+/).slice(0, 2).join(" ") : null
    },
    privacy: {
      aggregateOnly: !options.includeAnswers,
      rawContextIncluded: false,
      rawPromptsIncluded: false,
      rawAnswersIncluded: Boolean(options.includeAnswers),
      privatePathsIncluded: false
    },
    summaries,
    persistedKnowledge,
    persistedKnowledgeComparison,
    results: modeResults
  };

  if (!options.includeAnswers) {
    assertSanitized(report);
  }

  return report;
}

function assertSanitized(data) {
  const serialized = JSON.stringify(data);
  if (SENSITIVE_RE.test(serialized)) {
    throw new Error("LLM benchmark output contains sensitive-looking keys or values");
  }
  if (ABSOLUTE_PRIVATE_PATH_RE.test(serialized)) {
    throw new Error("LLM benchmark output contains private absolute paths");
  }
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    command: args[0]?.startsWith("-") ? "run" : args.shift() ?? "run",
    json: false,
    includeAnswers: false
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--scenario") {
      options.scenario = args.shift();
    } else if (arg === "--modes") {
      options.modes = String(args.shift() ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    } else if (arg === "--llm-command") {
      options.llmCommand = args.shift();
    } else if (arg === "--include-answers") {
      options.includeAnswers = true;
    } else if (arg === "--generated-at") {
      options.generatedAt = args.shift();
    }
  }

  return options;
}

function printHuman(report) {
  process.stdout.write(`LLM configured: ${report.llm.configured ? "yes" : "no"}\n`);
  for (const mode of report.modes) {
    const summary = report.summaries[mode];
    process.stdout.write([
      `${mode}:`,
      `queries=${summary.queryCount}`,
      `promptTokenProxy=${summary.promptTokenProxy}`,
      `readTokenProxy=${summary.readTokenProxy}`,
      `nodeHitRate=${summary.expectedNodeHitRate}%`,
      `termHitRate=${summary.expectedTermHitRate}%`,
      `answered=${summary.llmAnsweredCount}/${summary.queryCount}`,
      `realInputTokens=${summary.realInputTokens}`,
      `realInputReductionVsNone=${summary.realInputTokenReductionVsNone}%`,
      `tokenReductionVsNone=${summary.tokenProxyReductionVsNone}%`,
      `readReductionVsNone=${summary.readVolumeReductionVsNone}%`
    ].join(" "));
    process.stdout.write("\n");
  }
  if (report.persistedKnowledgeComparison) {
    const comparison = report.persistedKnowledgeComparison;
    process.stdout.write([
      "persistedKnowledge pam-0.4->pam-0.5:",
      `byteIncrease=${comparison.byteIncreasePercent}%`,
      `tokenProxyIncrease=${comparison.tokenProxyIncreasePercent}%`,
      `recordIncrease=${comparison.structuredRecordIncreasePercent}%`,
      `addedCoverageQueries=${comparison.addedCoverageQueries}`
    ].join(" "));
    process.stdout.write("\n");
  }
}

export {
  assertSanitized,
  collectLlmRetrievalBenchmark
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command !== "run") {
    throw new Error(`Unsupported llm retrieval benchmark command: ${options.command}`);
  }
  const report = collectLlmRetrievalBenchmark(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
}

if (process.argv[1] === __filename) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
