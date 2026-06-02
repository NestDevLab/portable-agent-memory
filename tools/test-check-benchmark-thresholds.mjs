import assert from "node:assert/strict";
import test from "node:test";

import { buildReport, DEFAULT_THRESHOLDS } from "./check-benchmark-thresholds.mjs";

test("benchmark threshold check passes with default thresholds", () => {
  const report = buildReport(DEFAULT_THRESHOLDS);

  assert.equal(report.passed, true);
  assert.equal(report.privacy.aggregateOnly, true);
  assert.ok(report.findings.length > 0);
  assert.equal(report.findings.every((finding) => finding.ok), true);
});

test("benchmark threshold check fails when thresholds are stricter than current metrics", () => {
  const report = buildReport({
    ...DEFAULT_THRESHOLDS,
    baselines: {
      ...DEFAULT_THRESHOLDS.baselines,
      pam05PromptReduction: 99
    }
  });

  assert.equal(report.passed, false);
  assert.ok(report.findings.some((finding) => !finding.ok && finding.label.includes("pam-0.5 prompt")));
});
