#!/usr/bin/env bash
# pam-statusline.sh - PAM-aware statusline for Claude Code.
#
# Reads JSON session data from stdin and prints up to two lines:
#   line 1: [model] dir · branch · NN% ctx
#   line 2: PAM-specific segment, only when memory/pam.version.json is present.
#
# Silent (no PAM line) outside a PAM workspace, so this is safe to install
# user-wide in ~/.claude/settings.json.

set -u
input=$(cat)

# --- jq helper (graceful fallback if jq missing) -----------------------------
_jq() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$input" | jq -r "$1" 2>/dev/null
  else
    printf ''
  fi
}

MODEL=$(_jq '.model.display_name // "Claude"')
CWD=$(_jq '.workspace.current_dir // .cwd // ""')
PROJECT=$(_jq '.workspace.project_dir // ""')
PCT=$(_jq '.context_window.used_percentage // 0' | cut -d. -f1)
SESSION_ID=$(_jq '.session_id // ""')

DIR_LABEL="${CWD##*/}"

# Git branch (cheap; skip if not in a repo).
BRANCH=""
if command -v git >/dev/null 2>&1 && [ -n "$CWD" ]; then
  BRANCH=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
fi

# --- line 1: generic ---------------------------------------------------------
line1="[$MODEL] $DIR_LABEL"
[ -n "$BRANCH" ] && line1="$line1 · $BRANCH"
line1="$line1 · ${PCT}% ctx"
printf '%s\n' "$line1"

# --- detect PAM workspace ----------------------------------------------------
pam_root=""
for candidate in "$CWD" "$PROJECT"; do
  [ -z "$candidate" ] && continue
  if [ -f "$candidate/memory/pam.version.json" ]; then
    pam_root="$candidate"
    break
  fi
done

[ -z "$pam_root" ] && exit 0

# --- PAM signals -------------------------------------------------------------
PAM_VERSION=""
GRAPH_STATUS="?"
NODE_COUNT="?"
EDGE_COUNT="?"
GENERATED_AT=""

if command -v jq >/dev/null 2>&1; then
  PAM_VERSION=$(jq -r '.pamVersion // ""' "$pam_root/memory/pam.version.json" 2>/dev/null)
  if [ -f "$pam_root/memory/graph/catalog.json" ]; then
    GRAPH_STATUS=$(jq -r '.health.status // "unknown"' "$pam_root/memory/graph/catalog.json" 2>/dev/null)
    NODE_COUNT=$(jq -r '.nodeCount // 0' "$pam_root/memory/graph/catalog.json" 2>/dev/null)
    EDGE_COUNT=$(jq -r '.edgeCount // 0' "$pam_root/memory/graph/catalog.json" 2>/dev/null)
    GENERATED_AT=$(jq -r '.generatedAt // ""' "$pam_root/memory/graph/catalog.json" 2>/dev/null)
  fi
fi

# Pending proposals (count *.json files; tolerate missing dir).
PROPOSAL_COUNT=0
if [ -d "$pam_root/memory/maintenance/proposals" ]; then
  PROPOSAL_COUNT=$(find "$pam_root/memory/maintenance/proposals" -maxdepth 1 -type f -name '*.json' ! -name '*.applied.json' 2>/dev/null | wc -l | tr -d ' ')
fi

# Session activity (appends this session).
APPENDS=0
if [ -n "$SESSION_ID" ] && [ -f "$pam_root/memory/.session/$SESSION_ID.json" ]; then
  if command -v jq >/dev/null 2>&1; then
    APPENDS=$(jq -r '.appends // 0' "$pam_root/memory/.session/$SESSION_ID.json" 2>/dev/null)
  fi
fi

# Catalog age in days.
AGE_LABEL=""
if [ -n "$GENERATED_AT" ]; then
  # Parse ISO 8601 -> epoch; fall back silently if `date` flavor disagrees.
  gen_epoch=""
  if date -j -f "%Y-%m-%dT%H:%M:%S" "${GENERATED_AT%.*}" +%s >/dev/null 2>&1; then
    gen_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${GENERATED_AT%.*}" +%s 2>/dev/null)
  elif date -d "$GENERATED_AT" +%s >/dev/null 2>&1; then
    gen_epoch=$(date -d "$GENERATED_AT" +%s 2>/dev/null)
  fi
  if [ -n "$gen_epoch" ]; then
    now_epoch=$(date +%s)
    age_days=$(( (now_epoch - gen_epoch) / 86400 ))
    if [ "$age_days" -le 0 ]; then
      AGE_LABEL="today"
    elif [ "$age_days" -eq 1 ]; then
      AGE_LABEL="1d"
    else
      AGE_LABEL="${age_days}d"
    fi
  fi
fi

# --- colors (ANSI) -----------------------------------------------------------
RESET=$'\033[0m'
DIM=$'\033[2m'
RED=$'\033[31m'
YELLOW=$'\033[33m'
GREEN=$'\033[32m'

graph_color="$GREEN"
graph_glyph="✅"
case "$GRAPH_STATUS" in
  valid) graph_color="$GREEN"; graph_glyph="✅" ;;
  warning|warn) graph_color="$YELLOW"; graph_glyph="⚠️" ;;
  invalid|error) graph_color="$RED"; graph_glyph="❌" ;;
  *) graph_color="$DIM"; graph_glyph="·" ;;
esac

prop_color="$DIM"
[ "$PROPOSAL_COUNT" -gt 0 ] && prop_color="$YELLOW"

age_color="$DIM"
case "$AGE_LABEL" in
  ""|today|1d|2d|3d|4d|5d|6d) ;;
  *) age_color="$YELLOW" ;;
esac

# --- line 2: PAM segment ----------------------------------------------------
line2="${DIM}🧠 PAM"
[ -n "$PAM_VERSION" ] && line2="$line2 $PAM_VERSION"
line2="$line2${RESET} · ${graph_color}${graph_glyph} ${NODE_COUNT}n/${EDGE_COUNT}e${RESET}"
line2="$line2 · ${prop_color}📋 ${PROPOSAL_COUNT}${RESET}"
[ -n "$AGE_LABEL" ] && line2="$line2 · ${age_color}💤 ${AGE_LABEL}${RESET}"
[ "$APPENDS" -gt 0 ] && line2="$line2 · ${GREEN}✍️ ${APPENDS}${RESET}"

printf '%s\n' "$line2"
