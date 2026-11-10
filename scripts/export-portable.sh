#!/usr/bin/env bash
# Export this dev tree to a directory that matches the public repo: the fleet files (listed in .portable-exclude),
# node_modules and the progress notes left out.
#   scripts/export-portable.sh TARGET_DIR
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXCLUDE_FILE="$ROOT/.portable-exclude"
ALWAYS_EXCLUDE=(node_modules PORTABILITY_PROGRESS.txt SCRUB_PROGRESS.txt .portable-exclude .git)

[ $# -eq 1 ] || { echo "usage: $0 TARGET_DIR" >&2; exit 2; }
TARGET="$1"
mkdir -p "$TARGET"

args=(-a --delete --exclude-from="$EXCLUDE_FILE")
for pattern in "${ALWAYS_EXCLUDE[@]}"; do args+=(--exclude="$pattern"); done
rsync "${args[@]}" "$ROOT/" "$TARGET/"
echo "exported to $TARGET"
