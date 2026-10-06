#!/usr/bin/env bash
# Mirror the dev-mod working copy into this marketplace. Dev copy stays the source of truth
# until testing moves here. Usage: scripts/sync-from-dev.sh [--check]  (--check = dry run/diff only)
set -euo pipefail
SRC=$(echo "$HOME"/.claude/dev-mods/*/escalation-ladder)
DST="$(cd "$(dirname "$0")/.." && pwd)/plugins/escalation-ladder"
EXCL=(--exclude node_modules --exclude '.claude-plugin/types' --exclude .git)
if [ "${1:-}" = "--check" ]; then
  diff -rq "${EXCL[@]/#--exclude/-x}" "$SRC" "$DST" 2>/dev/null | grep -v -E 'node_modules|/types' || echo "in sync"
else
  mkdir -p "$DST"; cd "$SRC"
  find . \( -name node_modules -o -path ./.claude-plugin/types -o -name .git \) -prune -o -type f -print \
    | while read -r f; do mkdir -p "$DST/$(dirname "$f")"; cp -p "$f" "$DST/$f"; done
  echo "synced $SRC -> $DST"
fi
