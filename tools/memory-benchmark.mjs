import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, "..");
const SENSITIVE_RE = /(secret|cookie|credential|private[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token)/i;
const ABSOLUTE_PRIVATE_PATH_RE = /\/home\/|\/Users\/|[A-Za-z]:\\/;

function resolveWorkspacePath(workspaceRoot, relativePath) {
  return path.join(workspaceRoot, relativePath);
}

function fileMetrics(workspaceRoot, relativePath) {
  const content = fs.readFileSync(resolveWorkspacePath(workspaceRoot, relativePath), "utf8");
  const bytes = Buffer.byteLength(content);
  const words = content.trim() === "" ? 0 : content.trim().split(/\s+/).length;
  return {
    path: relativePath,
    bytes,
    words,
    tokenProxy: Math.ceil(bytes / 4)
  };
}

function aggregateFiles(workspaceRoot, files) {
  const fileStats = files.filter((file) => fs.existsSync(resolveWorkspacePath(workspaceRoot, file))).map((file) => fileMetrics(workspaceRoot, file));
  return {
    fileCount: fileStats.length,
    bytes: fileStats.reduce((sum, entry) => sum + entry.bytes, 0),
    words: fileStats.reduce((sum, entry) => sum + entry.words, 0),
    tokenProxy: fileStats.reduce((sum, entry) => sum + entry.tokenProxy, 0),
    files: fileStats
  };
}

function timedCommand(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: WORKSPACE_ROOT,
    encoding: "utf8",
    input: options.input
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return {
    command: [command, ...args].join(" "),
    durationMs: Math.round(durationMs * 1000) / 1000,
    status: result.status,
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? "")
  };
}

function collectCurrentBenchmark(workspaceRoot = WORKSPACE_ROOT, options = {}) {
  const startedAt = options.generatedAt ?? new Date().toISOString();
  const profile = options.profile ?? "graph-v1";
  const setupFiles = [
    "AGENT_BOOTSTRAP.md",
    "README.md",
    "memory/agent-memory/pam.md",
    "memory/agent-memory/llm-wiki.md"
  ];
  const markdownQueryFiles = [
    "memory/index.md",
    "memory/conversation-log.md",
    "memory/knowledge-log.md",
    "memory/agent-memory/pam.md",
    "memory/agent-memory/llm-wiki.md"
  ];
  const graphQueryFiles = [
    "memory/pam.version.json",
    "memory/graph/catalog.json",
    "memory/graph/aliases.jsonl",
    "memory/graph/nodes.jsonl",
    "memory/graph/edges.jsonl"
  ];
  const dryRun = timedCommand("node", ["tools/memory-maintenance.mjs", "maintain", "--dry-run", "--json"]);
  const search = timedCommand("node", ["-e", "const fs=require('fs'); for (const f of ['README.md','memory/index.md','memory/agent-memory/pam.md']) fs.readFileSync(f,'utf8').includes('memory');"]);

  const benchmark = {
    benchmarkVersion: 1,
    generatedAt: startedAt,
    repository: "portable-agent-memory",
    profile,
    privacy: {
      aggregateOnly: true,
      rawTextIncluded: false,
      privatePathsIncluded: false
    },
    scenarios: {
      setupAuditMarkdown: aggregateFiles(workspaceRoot, setupFiles),
      genericMemoryQueryMarkdown: aggregateFiles(workspaceRoot, markdownQueryFiles),
      genericMemoryQueryGraph: aggregateFiles(workspaceRoot, graphQueryFiles),
      maintenanceDryRun: {
        ...dryRun,
        readVolume: aggregateFiles(workspaceRoot, [
          "tools/memory-maintenance.config.json",
          "memory/conversation-log.md",
          "memory/knowledge-log.md"
        ])
      },
      searchPath: {
        ...search,
        readVolume: aggregateFiles(workspaceRoot, ["README.md", "memory/index.md", "memory/agent-memory/pam.md"])
      }
    }
  };

  if (profile === "markdown-v0") {
    delete benchmark.scenarios.genericMemoryQueryGraph;
  }

  return benchmark;
}

function assertSanitized(data) {
  const serialized = JSON.stringify(data);
  if (SENSITIVE_RE.test(serialized)) {
    throw new Error("Benchmark output contains sensitive-looking keys or values");
  }
  if (ABSOLUTE_PRIVATE_PATH_RE.test(serialized)) {
    throw new Error("Benchmark output contains private absolute paths");
  }
}

function compareBenchmarks(before, after) {
  const beforeValue = before.scenarios.genericMemoryQueryMarkdown.tokenProxy;
  const afterValue = after.scenarios.genericMemoryQueryGraph?.tokenProxy ?? after.scenarios.genericMemoryQueryMarkdown.tokenProxy;
  const delta = afterValue - beforeValue;
  const reductionPercent = beforeValue === 0 ? 0 : Math.round((1 - afterValue / beforeValue) * 10000) / 100;
  return {
    beforeTokenProxy: beforeValue,
    afterTokenProxy: afterValue,
    deltaTokenProxy: delta,
    reductionPercent,
    improved: afterValue < beforeValue
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(WORKSPACE_ROOT, filePath), "utf8"));
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "current";
  const options = { command, output: null };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--output") {
      options.output = args.shift();
    } else if (arg === "--before") {
      options.before = args.shift();
    } else if (arg === "--after") {
      options.after = args.shift();
    } else if (arg === "--profile") {
      options.profile = args.shift();
    } else if (arg === "--generated-at") {
      options.generatedAt = args.shift();
    }
  }
  return options;
}

export {
  assertSanitized,
  collectCurrentBenchmark,
  compareBenchmarks
};

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.command === "current") {
    const benchmark = collectCurrentBenchmark(WORKSPACE_ROOT, options);
    assertSanitized(benchmark);
    const output = `${JSON.stringify(benchmark, null, 2)}\n`;
    if (options.output) {
      const outputPath = path.resolve(WORKSPACE_ROOT, options.output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, output, "utf8");
    } else {
      process.stdout.write(output);
    }
    return;
  }

  if (options.command === "compare") {
    if (!options.before || !options.after) {
      throw new Error("compare requires --before <file> --after <file>");
    }
    const result = compareBenchmarks(readJson(options.before), readJson(options.after));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unsupported memory-benchmark command: ${options.command}`);
}

if (process.argv[1] === __filename) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
