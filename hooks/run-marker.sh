#!/bin/sh
# resolve-issue run marker: a PreToolUse hook for the Workflow tool (see hooks.json).
#
# When this session starts (or resumes) the resolve-issue pipeline, record the session id under the
# plugin's data folder. While the record is fresh (12 hours), publish-guard.sh blocks every publishing
# command from a subagent in this session, wherever it runs. It never blocks the Workflow call itself.

input=$(cat)
case $input in
  *resolve-issue:pipeline* | *resolve-issue*workflows/pipeline.js*) ;;
  *) exit 0 ;;
esac
sid=$(printf '%s' "$input" | tr ',{}' '[\n*]' | sed -n 's/^[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._-]*\)".*/\1/p' | head -n 1)
[ -n "$sid" ] || exit 0
data="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}/resolve-issue}"
mkdir -p "$data/runs" 2>/dev/null && touch "$data/runs/$sid" 2>/dev/null
exit 0
