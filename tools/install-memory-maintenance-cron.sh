#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNNER="$ROOT_DIR/tools/run-memory-maintenance-nightly.sh"
LOG_PATH="$ROOT_DIR/memory/maintenance/nightly-cron.log"
MARKER_START="# BEGIN portable-agent maintenance"
MARKER_END="# END portable-agent maintenance"

if [[ ! -x "$RUNNER" ]]; then
  chmod +x "$RUNNER"
fi

current_crontab="$(mktemp)"
next_crontab="$(mktemp)"
trap 'rm -f "$current_crontab" "$next_crontab"' EXIT

crontab -l >"$current_crontab" 2>/dev/null || true

awk -v start="$MARKER_START" -v end="$MARKER_END" '
  $0 == start { skip = 1; next }
  $0 == end { skip = 0; next }
  skip != 1 { print }
' "$current_crontab" >"$next_crontab"

{
  printf '\n%s\n' "$MARKER_START"
  printf '15 3 * * * %q >> %q 2>&1\n' "$RUNNER" "$LOG_PATH"
  printf '%s\n' "$MARKER_END"
} >>"$next_crontab"

crontab "$next_crontab"
printf 'Installed portable-agent maintenance cron for %s\n' "$ROOT_DIR"
