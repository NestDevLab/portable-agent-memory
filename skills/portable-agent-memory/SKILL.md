---
name: portable-agent-memory
description: Inspect or maintain a Portable Agent Memory graph when retrieval quality, source coverage, freshness, proposals, or cross-machine portability need attention.
---

# Portable Agent Memory

Use PAM as a portable, Markdown-first memory contract. Do not require AMF,
another backend, or a fixed repository layout.

## Health

Run the public check before changing memory:

```bash
npm run pam:health -- --workspace-root <workspace-root> --graph-dir <graph-dir> --version-path <version-path> --scenario <scenario-path> --source-registry <registry-path>
```

Treat `BLOCKED` as structural corruption and `ATTENTION` as a visible maintenance
finding. Report each health dimension; never replace it with one opaque score.

## Capture

Capture only durable, source-traced facts, decisions, procedures, troubleshooting,
relationships, conflicts, or obsolescence. Exclude credentials, tokens, cookies,
raw private communications, transient counters, and unsupported inference.

Validate proposals and exact paths before any write. Apply only an explicit,
reviewed proposal; revalidate sources and graph afterwards. Startup checks stay
read-only. Preserve the workspace's own policy and canonical documents.

## Completion

Report structural, freshness, retrieval, coverage, efficiency, and portability
results, plus every pending proposal and any required approval.
