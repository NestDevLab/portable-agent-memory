---
description: Enable, disable, or toggle the PAM status line by editing the active settings.json. Reversible; disabling moves the entry to _pamDisabledStatusLine rather than deleting it.
argument-hint: "[on|off|toggle]"
allowed-tools:
  - Read
  - Edit
  - Bash(ls:*)
  - Bash(test:*)
  - Bash(jq:*)
  - Bash(cat:*)
---

# /pam-enable-status-line; turn the PAM status line on/off

Toggle (or explicitly set) the PAM status line. The status line is configured via `statusLine.command` in a `settings.json` file, pointing at `pam-layer/statusline/pam-statusline.sh`.

When disabled, the entry is **moved** to `_pamDisabledStatusLine` (not deleted), so a future enable restores the same command without needing to reinstall the layer.

## Argument

- `on`: enable the PAM status line (no-op if already enabled).
- `off`: disable the PAM status line (no-op if already disabled).
- `toggle` *(default when no argument given)*: flip the current state.

## What to do

1. Parse `$ARGUMENTS`. Default to `toggle` if empty. Reject anything other than `on`/`off`/`toggle`.
2. Locate the active settings file in this order; pick the first that contains a PAM-layer status line config (either `statusLine.command` or `_pamDisabledStatusLine.command` matching the regex `pam-layer/statusline/pam-statusline\.sh$`):
   - `./.claude/settings.json` (project scope)
   - `~/.claude/settings.json` (user scope)
   If neither file matches, report: "No PAM status line is configured in project or user settings. The plugin does not ship the status line (Claude Code requires it at user scope); install it separately with `node tools/claude/install-statusline.mjs --apply` from the PAM repo." and stop.
3. Determine current state from that file:
   - **enabled** - `statusLine.command` is the pam-layer statusline
   - **disabled** - `_pamDisabledStatusLine.command` is the pam-layer statusline
4. Resolve the action:
   - target `on` from disabled → rename key `_pamDisabledStatusLine` → `statusLine`
   - target `off` from enabled → rename key `statusLine` → `_pamDisabledStatusLine`
   - target `toggle` → flip whichever side is set
   - already in target state → say so and exit without writing
5. Apply with a single `Edit` against `settings.json`. Match a long enough surrounding context that the replacement is unambiguous. Preserve indentation and trailing comma style. Do not touch any other key.
6. Confirm the change.

## Output format

```
PAM status line: <action taken>
  settings:  <absolute path>
  before:    <enabled|disabled>
  after:     <enabled|disabled>
  command:   <statusline path>

Restart Claude Code to see the new status line state.
```

If no change was needed, print just:

```
PAM status line already <enabled|disabled>. Nothing to do.
  settings:  <absolute path>
```

## Hard constraints

- **Only edit the `statusLine` / `_pamDisabledStatusLine` keys whose command path ends in `pam-layer/statusline/pam-statusline.sh`.** Never overwrite a non-PAM `statusLine` that some other tool installed.
- Do not delete the key; rename it. The whole point of `_pamDisabledStatusLine` is that re-enabling is a single rename, not a reinstall.
- Do not modify any other field in `settings.json` (hooks, permissions, theme, etc.).
- Do not edit both project and user settings in one run. Stop at the first match.
