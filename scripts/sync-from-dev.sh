#!/usr/bin/env bash
# Mirror the dev-mod working copy into this marketplace. Dev copy stays the source of truth
# until testing moves here. Usage: scripts/sync-from-dev.sh [--check]  (--check = report drift only)
# Marketplace-only files (LICENSE, plugin.json author/license/repository/homepage) are preserved/ignored.
set -euo pipefail
SRC=$(echo "$HOME"/.claude/dev-mods/*/escalation-ladder)
DST="$(cd "$(dirname "$0")/.." && pwd)/plugins/escalation-ladder"
PJ=.claude-plugin/plugin.json
norm() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));for(const k of ["author","license","repository","homepage"])delete d[k];console.log(JSON.stringify(d,Object.keys(d).sort()))' "$1"; }
if [ "${1:-}" = "--check" ]; then
  OUT=$(diff -rq -x node_modules -x types -x .git -x LICENSE -x plugin.json "$SRC" "$DST" 2>&1 || true)
  diff -rq -x node_modules -x .git "$SRC/types" "$DST/types" >/dev/null 2>&1 || OUT="$OUT"$'\n'"types/ differs"
  [ "$(norm "$SRC/$PJ")" = "$(norm "$DST/$PJ")" ] || OUT="$OUT"$'\n'"plugin.json differs (ignoring author/license/repository/homepage)"
  OUT=$(echo "$OUT" | sed '/^$/d'); [ -z "$OUT" ] && echo "in sync" || echo "$OUT"
else
  mkdir -p "$DST"; cd "$SRC"
  find . \( -name node_modules -o -path ./.claude-plugin/types -o -name .git -o -path ./.claude-plugin/plugin.json \) -prune -o -type f -print \
    | while read -r f; do mkdir -p "$DST/$(dirname "$f")"; cp -p "$f" "$DST/$f"; done
  # merge dev plugin.json, keeping marketplace-only metadata
  node -e 'const fs=require("fs");const [s,d]=process.argv.slice(1);const a=JSON.parse(fs.readFileSync(s)),b=JSON.parse(fs.readFileSync(d));
    for(const k of ["author","license","repository","homepage"])a[k]=b[k];fs.writeFileSync(d,JSON.stringify(a,null,2)+"\n")' "$SRC/$PJ" "$DST/$PJ"
  echo "synced $SRC -> $DST"
fi
