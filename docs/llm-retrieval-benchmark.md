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

## Results snapshot

These sample results were produced on the repository fixture with seven
retrieval queries. Deterministic token proxies estimate `bytes / 4`; real token
usage is provider-reported Codex JSONL usage from an authenticated local run.

| Mode | Queries | Prompt token proxy | Read token proxy | Real input tokens | Node hit rate | Token proxy reduction vs none | Real input reduction vs none |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `none` | 7 | 102,238 | 101,339 | 235,003 | 0% | 0% | 0% |
| `pam-0.4` | 7 | 37,041 | 35,296 | 182,236 | 100% | 63.77% | 22.45% |
| `pam-0.5` | 7 | 38,126 | 36,304 | 183,412 | 100% | 62.71% | 21.95% |

The proxy reduction is larger than the real Codex reduction because the proxy
only models repository context. The real Codex run also includes fixed session,
tool, policy, and instruction overhead that PAM cannot remove.

On this small fixture, `pam-0.5` is slightly more expensive than `pam-0.4` for
retrieval because it includes file-only coverage expectations. That is expected:
the 0.5.x improvement is mostly about collecting and verifying more usable
knowledge, not shrinking every single retrieval context.

| Persisted knowledge | `pam-0.4` | `pam-0.5` | Change |
| --- | ---: | ---: | ---: |
| Structured records | 48 | 53 | +10.42% |
| Artifact bytes | 8,090 | 8,665 | +7.11% |
| Token proxy | 2,024 | 2,168 | +7.11% |
| Coverage queries | 0 | 5 | +5 |
| Token proxy per record | 42.17 | 40.91 | -2.99% |

The small fixture is intentionally conservative. It proves the benchmark can
report the new persisted-knowledge fields, but it does not show the historical
failure mode where 0.4-style collection misses most of a larger corpus.

The synthetic large-corpus benchmark models that collection gap directly:

| Large corpus mode | Source files | Total facts | Captured facts | Capture rate | Persisted token proxy | Records | Graph-first reduction vs corpus |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `pam-0.4` | 500 | 2,000 | 160 | 8% | 17,113 | 479 | 92.65% |
| `pam-0.5` | 500 | 2,000 | 1,840 | 92% | 241,367 | 7,359 | -3.66% |

| Large corpus comparison | Value |
| --- | ---: |
| Facts captured by 0.5 per 0.4 fact | 11.5x |
| Persisted token proxy increase | 1,310.43% |

This is the key tradeoff: a graph that captures almost nothing is compact but
not useful. A graph that captures and verifies the corpus can be much larger,
especially when coverage queries are stored, but it makes the knowledge
available to later retrieval and validation.

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
