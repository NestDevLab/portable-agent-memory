#!/usr/bin/env bash
# session-start.sh - PAM workspace warning on session start.
#
# Wired as a SessionStart hook. When the session opens inside a PAM workspace,
# checks catalog freshness and pending proposals. If anything is worth knowing,
# prints a short additionalContext payload that Claude Code injects into the
# session. Silent otherwise.

set -u

input=$(cat 2>/dev/null || true)

command -v jq >/dev/null 2>&1 || exit 0

CWD=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null)
[ -z "$CWD" ] && CWD="$PWD"

# Walk up from CWD to find the PAM root.
pam_root=""
dir="$CWD"
while [ "$dir" != "/" ] && [ -n "$dir" ]; do
  if [ -f "$dir/memory/pam.version.json" ]; then
    pam_root="$dir"
    break
  fi
  dir=$(dirname "$dir")
done

[ -z "$pam_root" ] && exit 0

# --- gather signals ----------------------------------------------------------
STALE_DAYS=${PAM_STALE_DAYS:-7}

catalog="$pam_root/memory/graph/catalog.json"
age_days=""
status=""
if [ -f "$catalog" ]; then
  status=$(jq -r '.health.status // ""' "$catalog" 2>/dev/null)
  generated_at=$(jq -r '.generatedAt // ""' "$catalog" 2>/dev/null)
  if [ -n "$generated_at" ]; then
    gen_epoch=""
    if date -j -f "%Y-%m-%dT%H:%M:%S" "${generated_at%.*}" +%s >/dev/null 2>&1; then
      gen_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${generated_at%.*}" +%s 2>/dev/null)
    elif date -d "$generated_at" +%s >/dev/null 2>&1; then
      gen_epoch=$(date -d "$generated_at" +%s 2>/dev/null)
    fi
    if [ -n "$gen_epoch" ]; then
      now_epoch=$(date +%s)
      age_days=$(( (now_epoch - gen_epoch) / 86400 ))
    fi
  fi
fi

proposal_count=0
if [ -d "$pam_root/memory/maintenance/proposals" ]; then
  proposal_count=$(find "$pam_root/memory/maintenance/proposals" -maxdepth 1 -type f -name '*.json' ! -name '*.applied.json' 2>/dev/null | wc -l | tr -d ' ')
fi

# Build a punch list. Skip if everything is fresh.
lines=()
if [ -n "$age_days" ] && [ "$age_days" -gt "$STALE_DAYS" ]; then
  lines+=("- Graph catalog is ${age_days} days old (threshold: ${STALE_DAYS}d). Run \`/dream\` to refresh.")
fi
if [ "$proposal_count" -gt 0 ]; then
  lines+=("- ${proposal_count} pending curator proposal(s) in memory/maintenance/proposals/. Review before applying.")
fi
if [ "$status" = "invalid" ] || [ "$status" = "error" ]; then
  lines+=("- Graph catalog status is \`${status}\`. Run \`/dream\` or \`mcp__pam__graph_validate\` to investigate.")
fi

[ ${#lines[@]} -eq 0 ] && exit 0

# Compose additionalContext JSON the SessionStart hook contract expects.
context="PAM workspace notes:"
for line in "${lines[@]}"; do
  context="${context}
${line}"
done

jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
