import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSanitized,
  collectLargeCorpusBenchmark
} from "./large-corpus-benchmark.mjs";

test("large corpus benchmark emits sanitized aggregate reports", () => {
  const report = collectLargeCorpusBenchmark({
    generatedAt: "2026-06-02T00:00:00.000Z",
    sourceCount: 20,
    factsPerSource: 3,
    sourceBodyBytes: 600,
    pam04CaptureRate: 0.1,
    pam05CaptureRate: 0.9
  });
  assert.equal(report.privacy.rawTextIncluded, false);
  assert.equal(report.privacy.privatePathsIncluded, false);
  assertSanitized(report);
});

test("large corpus benchmark shows 0.5 captures substantially more persisted facts", () => {
  const report = collectLargeCorpusBenchmark({
    generatedAt: "2026-06-02T00:00:00.000Z",
    sourceCount: 100,
    factsPerSource: 5,
    sourceBodyBytes: 1000,
    pam04CaptureRate: 0.08,
    pam05CaptureRate: 0.92
  });
  assert.equal(report.fixture.totalFacts, 500);
  assert.equal(report.modes["pam-0.4"].capturedFacts, 40);
  assert.equal(report.modes["pam-0.5"].capturedFacts, 460);
  assert.ok(report.comparison.pam05CapturedFactsPerPam04CapturedFact > 10);
  assert.ok(report.comparison.persistedTokenProxyIncreasePercent > 0);
});
