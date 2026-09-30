#!/bin/sh
# Claude Code SessionEnd hook: appends one JSON line per finished session to the vault's
# .localflow/sessions.jsonl (time, project folder, why it ended, message count, first prompt).
# Reads only the local transcript; nothing leaves the machine. Costs no tokens.
#
# Register in ~/.claude/settings.json:
#   "hooks": { "SessionEnd": [ { "hooks": [ { "type": "command",
#              "command": "~/work/localflow/hooks/session-log.sh" } ] } ] }
# The vault is taken from LOCALFLOW_VAULT, else ~/LocalFlow.

VAULT="${LOCALFLOW_VAULT:-$HOME/LocalFlow}"
[ -f "$VAULT/localflow.json" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
tp=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
reason=$(printf '%s' "$input" | jq -r '.reason // "end"')
[ -n "$tp" ] && [ -f "$tp" ] || exit 0

# First real user prompt: plain string or text blocks; skip <command>/<system-reminder> wrappers.
prompt=$(jq -rs '[ .[] | select(.type=="user") | .message.content
  | if type=="string" then . elif type=="array" then (map(select(.type=="text")|.text)|join(" ")) else empty end
  | select(length>0) | select(startswith("<")|not) ] | first // empty' "$tp" 2>/dev/null | tr '\n' ' ' | cut -c1-180)
n=$(grep -c '"type":"user"' "$tp" 2>/dev/null || echo 0)

mkdir -p "$VAULT/.localflow"
jq -cn --arg ts "$(date +%Y-%m-%dT%H:%M:%S)" --arg cwd "$cwd" --arg reason "$reason" \
  --argjson messages "${n:-0}" --arg prompt "$prompt" \
  '{ts:$ts, cwd:$cwd, reason:$reason, messages:$messages, prompt:$prompt}' >> "$VAULT/.localflow/sessions.jsonl"
exit 0
