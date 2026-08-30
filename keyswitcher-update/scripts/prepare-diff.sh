#!/usr/bin/env bash
# Clone upstream and emit the diff from the installed (or last-audited) tag to <new_tag>,
# plus a red-flag hit list. Does not build.
set -euo pipefail
REPO="https://github.com/graninilya/keyswitcher"
NEW="${1:?usage: prepare-diff.sh <new_tag>}"
PIN="${XDG_STATE_HOME:-$HOME/.local/state}/keyswitcher-update/pinned.txt"
OLD="$(awk 'NR==1{print $1}' "$PIN" 2>/dev/null || true)"
OLD="${OLD:-v0.2.6}"   # last audited baseline (commit 7166f68) when no pin is recorded

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ksw-diff.XXXXXX")"
git clone --quiet "$REPO" "$WORK/repo"
DIFF="$WORK/diff.patch"
git -C "$WORK/repo" diff "$OLD".."$NEW" > "$DIFF"

echo "range=$OLD..$NEW"
echo "diff=$DIFF"
echo "repo=$WORK/repo"
echo "--- changed files ---"
git -C "$WORK/repo" diff --stat "$OLD".."$NEW"
echo "--- added lines matching red-flag patterns (review each in context) ---"
grep -nE '^\+' "$DIFF" | grep -iE \
 'URLSession|URLRequest|URL\(string|https?://|NWConnection|getaddrinfo|SUPublicEDKey|SUFeedURL|listenOnly|IsSecureEventInputEnabled|Process\(|NSTask|dlopen|dlsym|NSClassFromString|LaunchDaemon|LaunchAgent|SMAppService|\.package\(|binaryTarget|\.entitlements|com\.apple\.security|secrets\.' \
 || echo "(none)"
