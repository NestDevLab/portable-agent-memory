import { collectLargeCorpusBenchmark } from "./large-corpus-benchmark.mjs";
import { collectLlmRetrievalBenchmark } from "./llm-retrieval-benchmark.mjs";

const DEFAULT_THRESHOLDS = {
  minPam04PromptReduction: 50,
  minPam05PromptReduction: 50,
  minPam04ReadReduction: 50,
  minPam05ReadReduction: 50,
  minPam04NodeHitRate: 100,
  minPam05NodeHitRate: 100,
  minPam05CoverageQueries: 1,
  minPam05CaptureRate: 80,
  minPam05FactsPerPam04Fact: 5
};

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const options = {
    json: false,
    thresholds: { ...DEFAULT_THRESHOLDS }
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--min-")) {
      const key = arg
        .slice(2)
        .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      options.thresholds[key] = parseNumber(args.shift(), options.thresholds[key]);
    }
  }
  return options;
}

function checkAtLeast(findings, label, actual, minimum) {
  const ok = actual >= minimum;
  findings.push({
    label,
    ok,
    actual,
    minimum
  });
}

function buildReport(thresholds) {
  const llm = collectLlmRetrievalBenchmark({
    generatedAt: "1970-01-01T00:00:00.000Z"
  });
  const largeCorpus = collectLargeCorpusBenchmark({
    generatedAt: "1970-01-01T00:00:00.000Z"
  });
  const findings = [];

  checkAtLeast(
    findings,
    "pam-0.4 prompt token proxy reduction vs none",
    llm.summaries["pam-0.4"].tokenProxyReductionVsNone,
    thresholds.minPam04PromptReduction
  );
  checkAtLeast(
    findings,
    "pam-0.5 prompt token proxy reduction vs none",
    llm.summaries["pam-0.5"].tokenProxyReductionVsNone,
    thresholds.minPam05PromptReduction
  );
  checkAtLeast(
    findings,
    "pam-0.4 read token proxy reduction vs none",
    llm.summaries["pam-0.4"].readVolumeReductionVsNone,
    thresholds.minPam04ReadReduction
  );
  checkAtLeast(
    findings,
    "pam-0.5 read token proxy reduction vs none",
    llm.summaries["pam-0.5"].readVolumeReductionVsNone,
    thresholds.minPam05ReadReduction
  );
  checkAtLeast(
    findings,
    "pam-0.4 expected node hit rate",
    llm.summaries["pam-0.4"].expectedNodeHitRate,
    thresholds.minPam04NodeHitRate
  );
  checkAtLeast(
    findings,
    "pam-0.5 expected node hit rate",
    llm.summaries["pam-0.5"].expectedNodeHitRate,
    thresholds.minPam05NodeHitRate
  );
  checkAtLeast(
    findings,
    "pam-0.5 coverage query count",
    llm.persistedKnowledge["pam-0.5"].recordCounts.coverageQueries,
    thresholds.minPam05CoverageQueries
  );
  checkAtLeast(
    findings,
    "large corpus pam-0.5 capture rate",
    largeCorpus.modes["pam-0.5"].captureRate,
    thresholds.minPam05CaptureRate
  );
  checkAtLeast(
    findings,
    "large corpus pam-0.5 facts per pam-0.4 fact",
    largeCorpus.comparison.pam05CapturedFactsPerPam04CapturedFact,
    thresholds.minPam05FactsPerPam04Fact
  );

  return {
    benchmarkVersion: 1,
    privacy: {
      aggregateOnly: true,
      rawTextIncluded: false,
      privatePathsIncluded: false
    },
    thresholds,
    passed: findings.every((finding) => finding.ok),
    findings,
    summaries: {
      llmRetrieval: {
        "pam-0.4": llm.summaries["pam-0.4"],
        "pam-0.5": llm.summaries["pam-0.5"],
        persistedKnowledgeComparison: llm.persistedKnowledgeComparison
      },
      largeCorpus: {
        "pam-0.4": largeCorpus.modes["pam-0.4"],
        "pam-0.5": largeCorpus.modes["pam-0.5"],
        comparison: largeCorpus.comparison
      }
    }
  };
}

function printHuman(report) {
  for (const finding of report.findings) {
    const status = finding.ok ? "ok" : "fail";
    process.stdout.write(`${status}: ${finding.label} actual=${finding.actual} minimum=${finding.minimum}\n`);
  }
}

export {
  buildReport,
  DEFAULT_THRESHOLDS
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options.thresholds);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
  if (!report.passed) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main();
}
