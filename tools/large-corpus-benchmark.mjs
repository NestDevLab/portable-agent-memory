import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const DEFAULTS = {
  sourceCount: 500,
  factsPerSource: 4,
  sourceBodyBytes: 1800,
  pam04CaptureRate: 0.08,
  pam05CaptureRate: 0.92
};
const SENSITIVE_RE = /(secret|cookie|credential|private[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token)/i;
const ABSOLUTE_PRIVATE_PATH_RE = /\/home\/|\/Users\/|[A-Za-z]:\\/;

function tokenProxy(bytes) {
  return Math.ceil(bytes / 4);
}

function percent(value) {
  return Math.round(value * 10000) / 100;
}

function percentReduction(before, after) {
  if (!before) {
    return 0;
  }
  return Math.round((1 - after / before) * 10000) / 100;
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, json: false, keepFixture: false };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--sources") {
      options.sourceCount = parseNumber(args.shift(), options.sourceCount);
    } else if (arg === "--facts-per-source") {
      options.factsPerSource = parseNumber(args.shift(), options.factsPerSource);
    } else if (arg === "--source-body-bytes") {
      options.sourceBodyBytes = parseNumber(args.shift(), options.sourceBodyBytes);
    } else if (arg === "--pam04-capture-rate") {
      options.pam04CaptureRate = parseNumber(args.shift(), options.pam04CaptureRate);
    } else if (arg === "--pam05-capture-rate") {
      options.pam05CaptureRate = parseNumber(args.shift(), options.pam05CaptureRate);
    } else if (arg === "--keep-fixture") {
      options.keepFixture = true;
    } else if (arg === "--generated-at") {
      options.generatedAt = args.shift();
    }
  }
  return options;
}

function fixtureSourceText(index, factsPerSource, sourceBodyBytes) {
  const factLines = Array.from({ length: factsPerSource }, (_, factIndex) => {
    const globalFact = index * factsPerSource + factIndex;
    return `- synthetic fact ${globalFact}: project-${index} decision-${factIndex} status confirmed.`;
  }).join("\n");
  const filler = " Synthetic benchmark filler sentence for corpus scale measurement.";
  const repeats = Math.max(0, Math.ceil((sourceBodyBytes - Buffer.byteLength(factLines)) / Buffer.byteLength(filler)));
  return `# Synthetic Source ${index}\n\n${factLines}\n\n${filler.repeat(repeats)}\n`;
}

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function createFixture(root, options) {
  fs.mkdirSync(path.join(root, "memory/graph"), { recursive: true });
  fs.mkdirSync(path.join(root, "memory/sources"), { recursive: true });
  fs.mkdirSync(path.join(root, "benchmarks"), { recursive: true });

  const totalFacts = options.sourceCount * options.factsPerSource;
  const sourceFiles = [];
  for (let sourceIndex = 0; sourceIndex < options.sourceCount; sourceIndex += 1) {
    const relativePath = `memory/sources/synthetic-${String(sourceIndex).padStart(4, "0")}.md`;
    fs.writeFileSync(path.join(root, relativePath), fixtureSourceText(sourceIndex, options.factsPerSource, options.sourceBodyBytes), "utf8");
    sourceFiles.push(relativePath);
  }

  const captured04 = Math.floor(totalFacts * options.pam04CaptureRate);
  const captured05 = Math.floor(totalFacts * options.pam05CaptureRate);
  const nodes04 = buildNodes(captured04, options.factsPerSource);
  const nodes05 = buildNodes(captured05, options.factsPerSource);
  const aliases04 = nodes04.map((node) => ({ a: node.n, id: node.id }));
  const aliases05 = nodes05.map((node) => ({ a: node.n, id: node.id }));
  const edges04 = buildEdges(nodes04);
  const edges05 = buildEdges(nodes05);
  const coverageQueries05 = nodes05.map((node) => ({ q: node.n, expectedId: node.id }));

  writeJsonl(path.join(root, "pam04-nodes.jsonl"), nodes04);
  writeJsonl(path.join(root, "pam04-aliases.jsonl"), aliases04);
  writeJsonl(path.join(root, "pam04-edges.jsonl"), edges04);
  writeJsonl(path.join(root, "pam05-nodes.jsonl"), nodes05);
  writeJsonl(path.join(root, "pam05-aliases.jsonl"), aliases05);
  writeJsonl(path.join(root, "pam05-edges.jsonl"), edges05);
  fs.writeFileSync(path.join(root, "pam04-version.json"), JSON.stringify({ pamVersion: "0.4.0", memoryFormat: "graph-v1" }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(root, "pam05-version.json"), JSON.stringify({ pamVersion: "0.5.0", memoryFormat: "graph-v1", features: { fileOnlyCoverage: true } }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(root, "pam05-coverage.json"), JSON.stringify({ name: "Synthetic large corpus coverage", queries: coverageQueries05 }, null, 2) + "\n", "utf8");

  return { sourceFiles, totalFacts };
}

function buildNodes(count, factsPerSource) {
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.floor(index / factsPerSource);
    const factIndex = index % factsPerSource;
    return {
      id: `synthetic:fact:${index}`,
      k: "fact",
      n: `synthetic fact ${index}`,
      d: `project-${sourceIndex} decision-${factIndex} status confirmed`,
      st: "confirmed",
      c: "high",
      u: "2026-06-02",
      src: `memory/sources/synthetic-${String(sourceIndex).padStart(4, "0")}.md`,
      tags: ["synthetic", `project-${sourceIndex}`]
    };
  });
}

function buildEdges(nodes) {
  return nodes.slice(1).map((node, index) => ({
    f: nodes[index].id,
    r: "next",
    t: node.id,
    st: "confirmed",
    c: "medium",
    u: "2026-06-02",
    src: node.src
  }));
}

function fileBytes(root, relativePath) {
  return Buffer.byteLength(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function aggregateBytes(root, relativePaths) {
  const bytes = relativePaths.reduce((sum, relativePath) => sum + fileBytes(root, relativePath), 0);
  return {
    fileCount: relativePaths.length,
    bytes,
    tokenProxy: tokenProxy(bytes)
  };
}

function collectLargeCorpusBenchmark(options = {}) {
  const benchmarkOptions = { ...DEFAULTS, ...options };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pam-large-corpus-"));
  try {
    const fixture = createFixture(root, benchmarkOptions);
    const corpus = aggregateBytes(root, fixture.sourceFiles);
    const pam04Files = ["pam04-version.json", "pam04-aliases.jsonl", "pam04-nodes.jsonl", "pam04-edges.jsonl"];
    const pam05Files = ["pam05-version.json", "pam05-aliases.jsonl", "pam05-nodes.jsonl", "pam05-edges.jsonl", "pam05-coverage.json"];
    const pam04 = aggregateBytes(root, pam04Files);
    const pam05 = aggregateBytes(root, pam05Files);
    const pam04CapturedFacts = Math.floor(fixture.totalFacts * benchmarkOptions.pam04CaptureRate);
    const pam04Records = pam04CapturedFacts * 2 - 1 + pam04CapturedFacts;
    const pam05CapturedFacts = Math.floor(fixture.totalFacts * benchmarkOptions.pam05CaptureRate);
    const pam05Records = pam05CapturedFacts * 2 - 1 + pam05CapturedFacts + pam05CapturedFacts;

    const report = {
      benchmarkVersion: 1,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      benchmarkType: "synthetic-large-corpus",
      privacy: {
        aggregateOnly: true,
        rawTextIncluded: false,
        privatePathsIncluded: false
      },
      fixture: {
        sourceCount: benchmarkOptions.sourceCount,
        factsPerSource: benchmarkOptions.factsPerSource,
        totalFacts: fixture.totalFacts,
        sourceBodyBytes: benchmarkOptions.sourceBodyBytes
      },
      corpus,
      modes: {
        "pam-0.4": {
          persisted: pam04,
          capturedFacts: pam04CapturedFacts,
          captureRate: percent(benchmarkOptions.pam04CaptureRate),
          structuredRecords: pam04Records,
          tokenProxyPerCapturedFact: Math.round((pam04.tokenProxy / Math.max(1, pam04CapturedFacts)) * 100) / 100,
          corpusTokenReductionIfGraphFirst: percentReduction(corpus.tokenProxy, pam04.tokenProxy)
        },
        "pam-0.5": {
          persisted: pam05,
          capturedFacts: pam05CapturedFacts,
          captureRate: percent(benchmarkOptions.pam05CaptureRate),
          structuredRecords: pam05Records,
          tokenProxyPerCapturedFact: Math.round((pam05.tokenProxy / Math.max(1, pam05CapturedFacts)) * 100) / 100,
          corpusTokenReductionIfGraphFirst: percentReduction(corpus.tokenProxy, pam05.tokenProxy)
        }
      },
      comparison: {
        capturedFactIncreasePercent: percentReduction(
          pam04CapturedFacts,
          pam05CapturedFacts
        ) * -1,
        pam05CapturedFactsPerPam04CapturedFact: Math.round((pam05CapturedFacts / Math.max(1, pam04CapturedFacts)) * 100) / 100,
        persistedTokenProxyIncreasePercent: Math.round(((pam05.tokenProxy / Math.max(1, pam04.tokenProxy)) - 1) * 10000) / 100,
        corpusTokenProxy: corpus.tokenProxy,
        pam04PersistedTokenProxy: pam04.tokenProxy,
        pam05PersistedTokenProxy: pam05.tokenProxy
      }
    };

    assertSanitized(report);
    return report;
  } finally {
    if (!benchmarkOptions.keepFixture) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

function assertSanitized(data) {
  const serialized = JSON.stringify(data);
  if (SENSITIVE_RE.test(serialized)) {
    throw new Error("Large corpus benchmark output contains sensitive-looking keys or values");
  }
  if (ABSOLUTE_PRIVATE_PATH_RE.test(serialized)) {
    throw new Error("Large corpus benchmark output contains private absolute paths");
  }
}

function printHuman(report) {
  process.stdout.write([
    `synthetic corpus: sources=${report.fixture.sourceCount}`,
    `facts=${report.fixture.totalFacts}`,
    `corpusTokenProxy=${report.corpus.tokenProxy}`
  ].join(" "));
  process.stdout.write("\n");
  for (const mode of ["pam-0.4", "pam-0.5"]) {
    const summary = report.modes[mode];
    process.stdout.write([
      `${mode}:`,
      `capturedFacts=${summary.capturedFacts}`,
      `captureRate=${summary.captureRate}%`,
      `persistedTokenProxy=${summary.persisted.tokenProxy}`,
      `records=${summary.structuredRecords}`,
      `graphFirstReductionVsCorpus=${summary.corpusTokenReductionIfGraphFirst}%`
    ].join(" "));
    process.stdout.write("\n");
  }
  process.stdout.write([
    "comparison:",
    `pam05FactsPerPam04Fact=${report.comparison.pam05CapturedFactsPerPam04CapturedFact}`,
    `persistedTokenProxyIncrease=${report.comparison.persistedTokenProxyIncreasePercent}%`
  ].join(" "));
  process.stdout.write("\n");
}

export {
  assertSanitized,
  collectLargeCorpusBenchmark
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = collectLargeCorpusBenchmark(options);
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
