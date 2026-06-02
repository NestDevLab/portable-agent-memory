import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSanitized,
  collectLlmRetrievalBenchmark
} from "./llm-retrieval-benchmark.mjs";

test("LLM retrieval benchmark emits sanitized aggregate reports by default", () => {
  const report = collectLlmRetrievalBenchmark({
    generatedAt: "2026-06-02T00:00:00.000Z"
  });
  assert.equal(report.privacy.rawContextIncluded, false);
  assert.equal(report.privacy.rawPromptsIncluded, false);
  assert.equal(report.privacy.rawAnswersIncluded, false);
  assert.equal(report.llm.configured, false);
  assertSanitized(report);
});

test("PAM retrieval modes reduce prompt token proxy compared with no-PAM baseline", () => {
  const report = collectLlmRetrievalBenchmark({
    generatedAt: "2026-06-02T00:00:00.000Z"
  });
  assert.ok(report.summaries["pam-0.4"].promptTokenProxy < report.summaries.none.promptTokenProxy);
  assert.ok(report.summaries["pam-0.5"].promptTokenProxy < report.summaries.none.promptTokenProxy);
  assert.ok(report.summaries["pam-0.4"].tokenProxyReductionVsNone > 0);
  assert.ok(report.summaries["pam-0.5"].tokenProxyReductionVsNone > 0);
});

test("PAM retrieval modes resolve expected graph nodes", () => {
  const report = collectLlmRetrievalBenchmark({
    generatedAt: "2026-06-02T00:00:00.000Z"
  });
  assert.equal(report.summaries["pam-0.4"].expectedNodeHitRate, 100);
  assert.equal(report.summaries["pam-0.5"].expectedNodeHitRate, 100);
});

test("LLM retrieval benchmark compares persisted PAM knowledge artifacts", () => {
  const report = collectLlmRetrievalBenchmark({
    generatedAt: "2026-06-02T00:00:00.000Z"
  });
  assert.equal(report.persistedKnowledge.none.totalStructuredRecords, 0);
  assert.equal(report.persistedKnowledge["pam-0.4"].recordCounts.coverageQueries, 0);
  assert.ok(report.persistedKnowledge["pam-0.4"].recordCounts.nodes > 0);
  assert.ok(report.persistedKnowledge["pam-0.4"].recordCounts.edges > 0);
  assert.ok(report.persistedKnowledge["pam-0.5"].recordCounts.coverageQueries > 0);
  assert.ok(report.persistedKnowledge["pam-0.5"].totalStructuredRecords > report.persistedKnowledge["pam-0.4"].totalStructuredRecords);
  assert.ok(report.persistedKnowledgeComparison.structuredRecordIncreasePercent > 0);
});
