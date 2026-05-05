# Portable Agent Memory

Portable Agent Memory is a small, markdown-first maintenance toolkit for AI
agent memory.

It gives a repository a predictable way to preserve working memory over time:

- keep recent log entries active;
- archive older or overflow entries without rewriting them;
- regenerate archive indexes;
- refresh summary and index pages through a bounded Codex pass;
- install a local cron job from repository-owned scripts.

The project is intentionally agent-agnostic. It can be used with Codex, Claude
Code, Cursor, OpenClaw, shell scripts, or any future runtime that can read and
write markdown.

## What This Is

This repository contains:

- `memory/agent-memory/pam.md` - a portable memory constitution;
- `memory/agent-memory/llm-wiki.md` - the persistent wiki pattern;
- `tools/memory-maintenance.mjs` - the maintenance CLI;
- `tools/memory-maintenance.config.json` - editable policy;
- `tools/run-memory-maintenance-nightly.sh` - cron-friendly runner;
- `tools/install-memory-maintenance-cron.sh` - host-local cron installer.

## Requirements

- Node.js 20 or newer.
- `npm`.
- Optional: Codex CLI if you want the `codex` or full `maintain` synthesis pass.
- Optional: cron if you want scheduled local maintenance.

The deterministic rotation and index steps do not require Codex.

## Quick Start

Clone the repository, then run:

```bash
npm test
npm run memory:maintain:dry-run
```

Create or edit your active memory logs:

```text
memory/conversation-log.md
memory/knowledge-log.md
```

Each dated log entry should use a level-2 markdown heading:

```markdown
## 2026-05-05 - Example Topic

Notes for this entry.
```

Run maintenance:

```bash
npm run memory:maintain
```

Install a local cron entry for this clone:

```bash
npm run memory:cron:install
```

The cron entry is host-local because cron needs an absolute path. The script
that installs it is versioned, so each clone can regenerate its own entry.

## Configuration

Edit `tools/memory-maintenance.config.json`.

Important fields:

- `retentionDays`: archive dated entries older than this many days.
- `managedLogs`: active markdown logs to maintain.
- `activeEntryLimit`: optional maximum dated entries to keep in a log.
- `archiveRoot`: where archived log slices are written.
- `summariesRoot`: where generated summaries are allowed.
- `maintenanceRoot`: where run reports and manifests are written.
- `workspace.indexPath`: the top-level memory index page.
- `workspace.policyPaths`: local instruction files the synthesis pass should respect.
- `protectedPaths`: paths copied into the temp workspace but not writable by synthesis.

## Safety Model

The tool is conservative by default:

- archived entry bodies are copied unchanged;
- archive files are append-only;
- dry-run mode reports planned moves without editing files;
- Codex runs in a temporary workspace;
- Codex copy-back is restricted to explicit allowlisted paths;
- deletions from the temporary workspace are rejected.

Always review the diff before committing generated changes.

## Commands

```bash
npm run memory:maintain
npm run memory:maintain:dry-run
npm run memory:rotate
npm run memory:index
npm run memory:codex
npm run memory:cron:install
npm test
```

## Repository Layout

```text
memory/
  agent-memory/
    llm-wiki.md
    pam.md
  archive/
  maintenance/
  sources/
  summaries/
tools/
  memory-maintenance.mjs
  memory-maintenance.config.json
  run-memory-maintenance-nightly.sh
  install-memory-maintenance-cron.sh
```

## Public-Use Guidance

Do not commit private logs, credentials, cookies, tokens, or raw confidential
communications into a public fork.

Use `memory/sources/` only for sources that are safe to store in the repository
you are publishing.
