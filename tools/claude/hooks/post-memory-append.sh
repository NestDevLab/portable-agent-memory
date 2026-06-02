#!/usr/bin/env bash
# post-memory-append.sh - PAM session-activity tracker.
#
# Wired as a PostToolUse hook matching `mcp__pam__memory_append`. Reads the
# hook JSON from stdin, locates the PAM workspace, and increments a per-session
# counter at memory/.session/<session_id>.json. Failure is silent: this hook
# must never block a tool call.

set -u

input=$(cat)

# Bail out quietly if jq is missing - we won't crash the tool call.
command -v jq >/dev/null 2>&1 || exit 0

SESSION_ID=$(printf '%s' "$input" | jq -r '.session_id // ""')
CWD=$(printf '%s' "$input" | jq -r '.cwd // ""')
TOOL_NAME=$(printf '%s' "$input" | jq -r '.tool_name // ""')

# Defense in depth: only count actual append calls.
case "$TOOL_NAME" in
  mcp__pam__memory_append) ;;
  *) exit 0 ;;
esac

[ -z "$SESSION_ID" ] && exit 0
[ -z "$CWD" ] && CWD="$PWD"

# Walk up from CWD looking for the PAM root.
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

session_dir="$pam_root/memory/.session"
mkdir -p "$session_dir" 2>/dev/null || exit 0

# Refuse session IDs that could escape the .session directory.
case "$SESSION_ID" in
  ""|*/*|*\\*|*..*) exit 0 ;;
esac

session_file="$session_dir/$SESSION_ID.json"
prev=0
if [ -f "$session_file" ]; then
  prev=$(jq -r '.appends // 0' "$session_file" 2>/dev/null || echo 0)
fi
next=$((prev + 1))
now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Atomic-ish write via tmp file.
tmp="$session_file.tmp.$$"
printf '{"sessionId":"%s","appends":%d,"updatedAt":"%s"}\n' \
  "$SESSION_ID" "$next" "$now" > "$tmp" 2>/dev/null || exit 0
mv "$tmp" "$session_file" 2>/dev/null || rm -f "$tmp"

exit 0
