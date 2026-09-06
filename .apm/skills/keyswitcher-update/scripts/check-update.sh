#!/usr/bin/env bash
# Print the current pinned tag, the latest upstream tag, and whether an update exists.
set -euo pipefail
REPO="https://github.com/graninilya/keyswitcher"
PIN="${XDG_STATE_HOME:-$HOME/.local/state}/keyswitcher-update/pinned.txt"

current="$(awk 'NR==1{print $1}' "$PIN" 2>/dev/null || true)"
commit="$(awk 'NR==1{print $2}' "$PIN" 2>/dev/null || true)"
latest="$(git ls-remote --tags --refs "$REPO" 'v*' | awk -F/ '{print $NF}' | sort -V | tail -1)"
[ -n "$latest" ] || { echo "ERROR: no tags from $REPO" >&2; exit 1; }

newer=false
if [ "$current" != "$latest" ] && \
   [ "$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -1)" = "$latest" ]; then
  newer=true
fi

echo "current=${current:-<none>} ${commit:-}"
echo "latest=$latest"
echo "newer=$newer"
