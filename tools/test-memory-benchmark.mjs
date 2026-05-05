import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSanitized,
  collectCurrentBenchmark,
  compareBenchmarks
} from "./memory-benchmark.mjs";

test("benchmark output uses aggregate metrics without raw text or private paths", () => {
  const benchmark = collectCurrentBenchmark(undefined, {
    generatedAt: "2026-05-05T00:00:00.000Z",
    profile: "graph-v1"
  });
  assert.equal(benchmark.privacy.rawTextIncluded, false);
  assert.equal(benchmark.privacy.privatePathsIncluded, false);
  assert.ok(benchmark.scenarios.setupAuditMarkdown.bytes > 0);
  assertSanitized(benchmark);
});

test("markdown profile omits graph query scenario", () => {
  const benchmark = collectCurrentBenchmark(undefined, {
    generatedAt: "2026-05-05T00:00:00.000Z",
    profile: "markdown-v0"
  });
  assert.equal(benchmark.scenarios.genericMemoryQueryGraph, undefined);
});

test("graph query benchmark improves read-volume token proxy over markdown query path", () => {
  const before = collectCurrentBenchmark(undefined, {
    generatedAt: "2026-05-05T00:00:00.000Z",
    profile: "markdown-v0"
  });
  const after = collectCurrentBenchmark(undefined, {
    generatedAt: "2026-05-05T00:00:00.000Z",
    profile: "graph-v1"
  });
  const comparison = compareBenchmarks(before, after);
  assert.equal(comparison.improved, true);
  assert.ok(comparison.reductionPercent > 0);
});
