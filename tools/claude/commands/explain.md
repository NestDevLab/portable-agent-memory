---
description: Print the PAM status-line legend with live values from the current workspace. Read-only; just runs a shell script and echoes its output.
allowed-tools:
  - Bash(bash:*)
---

# /pam-explain

Run the block below and print its stdout verbatim. Do not add commentary, headers, summaries, or follow-up suggestions.

```bash
bash <<'PAM_EXPLAIN_EOF'
set -u
pam_root=""
dir="$PWD"
while [ "$dir" != "/" ]; do
  [ -f "$dir/memory/pam.version.json" ] && { pam_root="$dir"; break; }
  dir=$(dirname "$dir")
done
if [ -z "$pam_root" ]; then
  printf 'Not in a PAM workspace - the status line only shows the generic `[model] dir · branch · NN%%%% ctx` row.\n'
  exit 0
fi

have_jq=0
command -v jq >/dev/null 2>&1 && have_jq=1
read_json() {
  if [ "$have_jq" -eq 1 ] && [ -f "$1" ]; then
    local v; v=$(jq -r "$2 // empty" "$1" 2>/dev/null)
    [ -n "$v" ] && { printf '%s' "$v"; return; }
  fi
  printf '%s' "$3"
}

PAM_VERSION=$(read_json "$pam_root/memory/pam.version.json" '.pamVersion' "?")
CATALOG="$pam_root/memory/graph/catalog.json"
GRAPH_STATUS=$(read_json "$CATALOG" '.health.status' "unknown")
NODE_COUNT=$(read_json "$CATALOG" '.nodeCount' "?")
EDGE_COUNT=$(read_json "$CATALOG" '.edgeCount' "?")
GENERATED_AT=$(read_json "$CATALOG" '.generatedAt' "")

case "$GRAPH_STATUS" in
  valid) glyph="✅" ;;
  warning|warn) glyph="⚠️" ;;
  invalid|error) glyph="❌" ;;
  *) glyph="·" ;;
esac

PROPOSAL_COUNT=0
prop_dir="$pam_root/memory/maintenance/proposals"
if [ -d "$prop_dir" ]; then
  PROPOSAL_COUNT=$(find "$prop_dir" -maxdepth 1 -type f -name '*.json' ! -name '*.applied.json' 2>/dev/null | wc -l | tr -d ' ')
fi

AGE_LABEL="unknown"
if [ -n "$GENERATED_AT" ]; then
  gen_epoch=""
  if date -j -f "%Y-%m-%dT%H:%M:%S" "${GENERATED_AT%.*}" +%s >/dev/null 2>&1; then
    gen_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${GENERATED_AT%.*}" +%s 2>/dev/null)
  elif date -d "$GENERATED_AT" +%s >/dev/null 2>&1; then
    gen_epoch=$(date -d "$GENERATED_AT" +%s 2>/dev/null)
  fi
  if [ -n "$gen_epoch" ]; then
    now_epoch=$(date +%s)
    age_days=$(( (now_epoch - gen_epoch) / 86400 ))
    if [ "$age_days" -le 0 ]; then AGE_LABEL="today"
    elif [ "$age_days" -eq 1 ]; then AGE_LABEL="1d"
    else AGE_LABEL="${age_days}d"
    fi
  fi
fi

APPENDS=0; SESSION_NOTE=""
session_dir="$pam_root/memory/.session"
if [ -d "$session_dir" ]; then
  latest=$(ls -t "$session_dir"/*.json 2>/dev/null | head -n 1)
  if [ -n "$latest" ] && [ "$have_jq" -eq 1 ]; then
    APPENDS=$(jq -r '.appends // 0' "$latest" 2>/dev/null || printf '0')
    SESSION_NOTE=" (from $(basename "$latest"))"
  fi
fi

cat <<EOF
🧠 PAM status line legend

🧠 PAM <pamVersion>
    PAM tooling version from memory/pam.version.json.
    Now: ${PAM_VERSION}

<✅|⚠️|❌|·> <N>n/<M>e
    Graph health and size from memory/graph/catalog.json.
    ✅ valid · ⚠️ warning · ❌ invalid · · unknown
    Now: ${glyph} ${NODE_COUNT}n/${EDGE_COUNT}e (${GRAPH_STATUS})

📋 <P>
    Pending curator proposals in memory/maintenance/proposals/ (excludes *.applied.json).
    Dim when 0, yellow when > 0 - a review is waiting.
    Now: ${PROPOSAL_COUNT}

💤 <today|Nd>
    Age of memory/graph/catalog.json (last graph_reindex).
    Goes yellow past ~7 days - that's the threshold that suggests a /dream run.
    Now: ${AGE_LABEL}

✍️ <K>
    Successful memory_append calls in this session (post-memory-append hook).
    Hidden in the status line when 0.
    Now: ${APPENDS}${SESSION_NOTE}
EOF
PAM_EXPLAIN_EOF
```
