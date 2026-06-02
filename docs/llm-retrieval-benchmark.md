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
- read volume, including file count and bytes;
- LLM duration when a real command is configured;
- expected graph node hits;
- expected-term hits in the LLM answer;
- deterministic token/read-volume reduction versus `none`;
- privacy status: aggregate metrics only, no raw source text in reports.

## Running deterministic mode

```bash
npm run benchmark:llm
```

This mode does not call an LLM. It compares the context each mode would give to
the same LLM and checks graph routing.

## Running with a real LLM

Set `PAM_LLM_COMMAND` to a command that reads the full prompt from stdin and
writes the answer to stdout:

```bash
PAM_LLM_COMMAND='codex -a never --sandbox read-only exec --ephemeral -' npm run benchmark:llm -- --json
```

Any CLI can be used if it follows the stdin/stdout contract, for example Claude
Code, OpenCode, Ollama, or a local wrapper script.

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

Keep the same model, temperature, prompt scenario, repository checkout, and
machine where possible. If the provider exposes exact token usage, record it
beside the proxy metrics.
