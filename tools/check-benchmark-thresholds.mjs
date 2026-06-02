import { collectLargeCorpusBenchmark } from "./large-corpus-benchmark.mjs";
import { collectLlmRetrievalBenchmark } from "./llm-retrieval-benchmark.mjs";

const DEFAULT_BASELINES = {
  pam04PromptReduction: 63.77,
  pam05PromptReduction: 62.71,
  pam04ReadReduction: 65.17,
  pam05ReadReduction: 64.17,
  pam04NodeHitRate: 100,
  pam05NodeHitRate: 100,
  pam05CoverageQueries: 5,
  pam05CaptureRate: 92,
  pam05FactsPerPam04Fact: 11.5
};

const DEFAULT_THRESHOLDS = {
  maxRegressionPercent: 1,
  baselines: { ...DEFAULT_BASELINES }
};

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(argv) {
  const options = {
    json: false,
    thresholds: {
      ...DEFAULT_THRESHOLDS,
      baselines: { ...DEFAULT_THRESHOLDS.baselines }
    }
  };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--max-regression-percent") {
      options.thresholds.maxRegressionPercent = parseNumber(
        args.shift(),
        options.thresholds.maxRegressionPercent
      );
    } else if (arg.startsWith("--baseline-")) {
      const key = arg
        .slice("--baseline-".length)
        .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      options.thresholds.baselines[key] = parseNumber(args.shift(), options.thresholds.baselines[key]);
    }
  }
  return options;
}

function minimumFromBaseline(baseline, maxRegressionPercent) {
  return baseline * (1 - maxRegressionPercent / 100);
}

function checkAtLeast(findings, label, actual, baseline, maxRegressionPercent) {
  const minimum = minimumFromBaseline(baseline, maxRegressionPercent);
  const ok = actual >= minimum;
  findings.push({
    label,
    ok,
    actual,
    baseline,
    maxRegressionPercent,
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
    thresholds.baselines.pam04PromptReduction,
    thresholds.maxRegressionPercent
  );
  checkAtLeast(
    findings,
    "pam-0.5 prompt token proxy reduction vs none",
    llm.summaries["pam-0.5"].tokenProxyReductionVsNone,
    thresholds.baselines.pam05PromptReduction,
    thresholds.maxRegressionPercent
  );
  checkAtLeast(
    findings,
    "pam-0.4 read token proxy reduction vs none",
    llm.summaries["pam-0.4"].readVolumeReductionVsNone,
    thresholds.baselines.pam04ReadReduction,
    thresholds.maxRegressionPercent
  );
  checkAtLeast(
    findings,
    "pam-0.5 read token proxy reduction vs none",
    llm.summaries["pam-0.5"].readVolumeReductionVsNone,
    thresholds.baselines.pam05ReadReduction,
    thresholds.maxRegressionPercent
  );
  checkAtLeast(
    findings,
    "pam-0.4 expected node hit rate",
    llm.summaries["pam-0.4"].expectedNodeHitRate,
    thresholds.baselines.pam04NodeHitRate,
    thresholds.maxRegressionPercent
  );
  checkAtLeast(
    findings,
    "pam-0.5 expected node hit rate",
    llm.summaries["pam-0.5"].expectedNodeHitRate,
    thresholds.baselines.pam05NodeHitRate,
    thresholds.maxRegressionPercent
  );
  checkAtLeast(
    findings,
    "pam-0.5 coverage query count",
    llm.persistedKnowledge["pam-0.5"].recordCounts.coverageQueries,
    thresholds.baselines.pam05CoverageQueries,
    thresholds.maxRegressionPercent
  );
  checkAtLeast(
    findings,
    "large corpus pam-0.5 capture rate",
    largeCorpus.modes["pam-0.5"].captureRate,
    thresholds.baselines.pam05CaptureRate,
    thresholds.maxRegressionPercent
  );
  checkAtLeast(
    findings,
    "large corpus pam-0.5 facts per pam-0.4 fact",
    largeCorpus.comparison.pam05CapturedFactsPerPam04CapturedFact,
    thresholds.baselines.pam05FactsPerPam04Fact,
    thresholds.maxRegressionPercent
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
    process.stdout.write(
      `${status}: ${finding.label} actual=${finding.actual} baseline=${finding.baseline} minimum=${finding.minimum}\n`
    );
  }
}

export {
  DEFAULT_BASELINES,
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
