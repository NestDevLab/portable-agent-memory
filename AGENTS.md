# Agent Instructions

This repository is a public, agent-agnostic toolkit for portable markdown
memory.

## Rules

- Keep examples generic.
- Do not add client, employer, personal, credential, or private workspace data.
- Prefer placeholders such as `<workspace-root>` over machine-specific paths.
- Keep scripts portable across Linux and macOS when practical.
- Treat `memory/sources/` as raw source material: preserve it or ask before
  destructive changes.
- Treat archived logs as append-only.
- Run `npm test` after changing maintenance behavior.

## Memory Model

Use `memory/agent-memory/pam-runtime.md` and `memory/graph/` first for everyday
memory lookup.

Use `memory/agent-memory/pam.md` as the durable memory contract for setup,
audits, migrations, and protocol changes.
Use `memory/agent-memory/llm-wiki.md` as the persistent wiki pattern reference.

The maintenance CLI is a tool that implements part of that contract; it is not
the entire memory system.
