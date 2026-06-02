# LLM Retrieval Benchmark

This benchmark compares the same LLM against three memory modes:

- `none`: no PAM read path, broad source lookup only;
- `pam-0.4`: graph-v1 PAM lookup without the 0.5 file-only coverage gate;
- `pam-0.5`: graph-v1 PAM lookup with file-only coverage expectations.

The goal is to measure whether PAM improves retrieval efficiency without hiding
accuracy regressions.

## Metrics

The benchmark reports:

- input and output token proxy, estimated as bytes / 4;
- real provider token usage when the configured LLM command emits Codex JSONL
  `turn.completed` usage events;
- read volume, including file count and bytes;
- LLM duration when a real command is configured;
- expected graph node hits;
- expected-term hits in the LLM answer;
- deterministic token/read-volume reduction versus `none`;
- persisted PAM knowledge size and density for `pam-0.4` versus `pam-0.5`;
- privacy status: aggregate metrics only, no raw source text in reports.

The deterministic token fields are proxy metrics, not provider-reported token
usage. Real answer quality and exact token usage require an authenticated LLM
command.

Persisted knowledge fields compare the amount of structured retrieval
information saved by each PAM mode:

- graph artifact bytes and token proxy;
- alias, node, edge, and coverage-query counts;
- unique source references;
- token proxy per structured record;
- 0.4 to 0.5 growth percentages.

## Running deterministic mode

```bash
npm run benchmark:llm
```

This mode does not call an LLM. It compares the context each mode would give to
the same LLM and checks graph routing.

## Running a large synthetic corpus

```bash
npm run benchmark:large-corpus
```

This mode generates a private temporary synthetic corpus and deletes it after
the run. It is meant to model scale effects that are hard to see in this small
starter repository.

Default fixture:

- 500 markdown source files;
- 2,000 synthetic facts;
- PAM 0.4 captures 8% of facts;
- PAM 0.5 captures 92% of facts and adds coverage queries.

The default capture rates intentionally model the failure mode where an older
workflow leaves most useful facts uncollected. Tune them with:

```bash
npm run benchmark:large-corpus -- --sources 1000 --facts-per-source 5 --pam04-capture-rate 0.05 --pam05-capture-rate 0.95
```

This is a scale model, not a substitute for a real migrated workspace. Use it
to verify that report fields expose the collection gap clearly, then repeat the
same measurements on a real corpus when available.

## Running with a real LLM

Set `PAM_LLM_COMMAND` to a command that reads the full prompt from stdin and
writes the answer to stdout:

```bash
PAM_LLM_COMMAND='codex exec --ephemeral --json --skip-git-repo-check -' npm run benchmark:llm -- --json
```

Any CLI can be used if it follows the stdin/stdout contract, for example Claude
Code, OpenCode, Ollama, or a local wrapper script.

If Codex is installed but the benchmark reports authentication failures, check
which Codex home the shell is using:

```bash
codex login status
CODEX_HOME=/path/to/logged-in/codex-home codex login status
```

Then run the benchmark with the logged-in home in the command environment:

```bash
CODEX_HOME=/path/to/logged-in/codex-home \
PAM_LLM_COMMAND='codex exec --ephemeral --json --skip-git-repo-check -' \
npm run benchmark:llm
```

Reports intentionally omit raw prompts and answers by default. Use
`--include-answers` only in private local runs when answer inspection is needed.

## Version workflow

For a full release comparison:

1. Run this benchmark on the merged 0.5.x branch.
2. Check out or prepare the 0.4.0 tree and run the same scenario with
   `--modes none,pam-0.4`.
3. Return to 0.5.x and run `--modes none,pam-0.4,pam-0.5`.
4. Compare summary fields:
   - `tokenProxyReductionVsNone`;
   - `readVolumeReductionVsNone`;
   - `expectedNodeHitRate`;
   - `expectedTermHitRate`;
   - `llmAnsweredCount`;
   - `durationMs`.
   - `realInputTokens`;
   - `realInputTokenReductionVsNone`;
5. Compare persisted knowledge fields:
   - `persistedKnowledge.pam-0.4`;
   - `persistedKnowledge.pam-0.5`;
   - `persistedKnowledgeComparison`.

Keep the same model, temperature, prompt scenario, repository checkout, and
machine where possible. If the provider exposes exact token usage, record it
beside the proxy metrics.
