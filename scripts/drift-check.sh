#!/usr/bin/env bash
# Scheduled drift check: dev-mod copy vs marketplace copy. Appends to ~/.claude/escalation-ladder-drift.log
# and maintains ~/.claude/escalation-ladder-DRIFT.flag while they differ.
LOG="$HOME/.claude/escalation-ladder-drift.log"; FLAG="$HOME/.claude/escalation-ladder-DRIFT.flag"
OUT=$("$(dirname "$0")/sync-from-dev.sh" --check 2>&1)
TS=$(date '+%Y-%m-%d %H:%M')
if [ "$OUT" = "in sync" ]; then echo "$TS in sync" >> "$LOG"; rm -f "$FLAG"
else { echo "$TS DRIFT"; echo "$OUT" | sed 's/^/    /'; } >> "$LOG"; echo "$OUT" > "$FLAG"; fi
