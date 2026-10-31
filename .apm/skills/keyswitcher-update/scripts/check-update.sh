#!/usr/bin/env bash
# Print the current pinned tag, the latest upstream release tag, whether an update exists,
# and every patch branch that moved, appeared in or left the desvio manifest since the install.
set -euo pipefail
REPO="https://github.com/graninilya/keyswitcher"
PIN="${XDG_STATE_HOME:-$HOME/.local/state}/keyswitcher-update/pinned.txt"
CONF="$HOME/.config/desvio/keyswitcher/desvio.conf"

current="$(awk 'NR==1{print $1}' "$PIN" 2>/dev/null || true)"
commit="$(awk 'NR==1{print $2}' "$PIN" 2>/dev/null || true)"
local_ref="$(awk 'NR==1{print $3}' "$PIN" 2>/dev/null || true)"
latest="$(git ls-remote --tags --refs "$REPO" 'v*' | awk -F/ '{print $NF}' | grep -E '^v[0-9]+(\.[0-9]+)*$' | sort -V | tail -1)"
[ -n "$latest" ] || { echo "ERROR: no release tags from $REPO" >&2; exit 1; }

newer=false
if [ "$current" != "$latest" ] && \
   [ "$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -1)" = "$latest" ]; then
  newer=true
fi

echo "current=${current:-<none>} ${commit:-}${local_ref:+ local=$local_ref}"
echo "latest=$latest"
echo "newer=$newer"

work_repo="$(DESVIO_CONFIG_FILE="$CONF" bash -c '. "$DESVIO_CONFIG_FILE" && printf %s "$DESVIO_REPO"')"
manifest="$(sed 's/#.*//' "$(dirname "$CONF")/manifest.txt" | awk 'NF { print $1 }')"
pinned="$(printf '%s\n' "$local_ref" | tr , '\n' | grep @ || true)"

for name in $manifest; do
  entry="$(printf '%s\n' "$pinned" | grep "^$name@" || true)"
  if [ -z "$entry" ]; then
    echo "branch-new=$name"
    continue
  fi
  old="$(git -C "$work_repo" rev-parse --verify --quiet "${entry#*@}^{commit}" || echo "${entry#*@}")"
  now="$(git -C "$work_repo" rev-parse --verify --quiet "$name^{commit}" || echo missing)"
  [ "$now" = "$old" ] || echo "branch-moved=$name ${old:0:9}..${now:0:9}"
done
for entry in $pinned; do
  printf '%s\n' "$manifest" | grep -qx "${entry%@*}" || echo "branch-dropped=${entry%@*}"
done
