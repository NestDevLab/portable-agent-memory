import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateCaptureProposal } from "./lib/pam-capture.mjs";

function digest(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "portable-agent-memory-capture-"));
  fs.mkdirSync(path.join(root, "docs", "agent-memory"), { recursive: true });
  const content = "Verified workflow change.\n";
  fs.writeFileSync(path.join(root, "docs", "source.md"), content, "utf8");
  return { root, content };
}

function proposal(content) {
  return {
    schemaVersion: "pam-capture/v1",
    candidates: [{
      id: "daily-routing-1",
      type: "procedure",
      claim: "A verified workflow change should be reviewed before capture.",
      confidence: "high",
      sensitivity: "none",
      evidenceDate: "2026-08-21T00:00:00.000Z",
      source: { path: "docs/source.md", sha256: digest(content) },
      targetPath: "docs/agent-memory/pam.md"
    }]
  };
}

test("capture proposal validates a source-traced shadow candidate", () => {
  const { root, content } = fixture();
  try {
    const report = validateCaptureProposal(root, proposal(content), { allowedPaths: ["docs/agent-memory"] });
    assert.equal(report.status, "REVIEW_REQUIRED");
    assert.equal(report.reviewRequiredCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capture proposal blocks stale source digests and sensitive claims", () => {
  const { root, content } = fixture();
  try {
    fs.writeFileSync(path.join(root, "docs", "source.md"), "Changed source.\n", "utf8");
    const input = proposal(content);
    input.candidates[0].claim = "Store bearer token now.";
    const report = validateCaptureProposal(root, input, { allowedPaths: ["docs/agent-memory"] });
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.candidates[0].errors.some((error) => error.includes("digest changed")));
    assert.ok(report.candidates[0].errors.some((error) => error.includes("sensitive-looking")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
