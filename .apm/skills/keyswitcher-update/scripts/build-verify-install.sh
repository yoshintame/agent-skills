#!/usr/bin/env bash
# Build <tag> from source, verify it against the audited baseline, install to /Applications,
# and record the pin. Exits non-zero (BLOCK) on any verification failure — caller must not install.
set -euo pipefail
REPO="https://github.com/graninilya/keyswitcher"
TAG="${1:?usage: build-verify-install.sh <tag>}"
APP_NAME="keySwitcher.app"
DEST="/Applications/$APP_NAME"
PIN_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/keyswitcher-update"

ALLOWED_HOSTS_RE='qkb-llm\.graninilya\.workers\.dev|github\.com/graninilya/keyswitcher|api\.openai\.com'
EXPECTED_EDKEY='+VYV2MzhMzAQl+Qwb7wPPR4HldDmiINfqpiU8kva9Mo='

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ksw-build.XXXXXX")"
git clone --quiet "$REPO" "$WORK/repo"
git -C "$WORK/repo" checkout --quiet "$TAG"
COMMIT="$(git -C "$WORK/repo" rev-parse HEAD)"
echo "→ building $TAG ($COMMIT)"
"$WORK/repo/App/build.sh" release

APP="$WORK/repo/App/dist/$APP_NAME"
EXE="$APP/Contents/MacOS/keySwitcher"
[ -x "$EXE" ] || { echo "BLOCK: build produced no executable" >&2; exit 1; }

echo "→ verify: linked dylibs"
bad="$(otool -L "$EXE" | tail -n +2 | grep -vE '/usr/lib/|/System/|@rpath/Sparkle\.framework' || true)"
[ -z "$bad" ] || { echo "BLOCK: unexpected linked library:" >&2; echo "$bad" >&2; exit 2; }

echo "→ verify: baked-in hosts"
hosts="$(strings -a "$EXE" | grep -aoiE 'https?://[a-z0-9._~:/?#@!$&()*+,;=%-]+' \
  | grep -viE 'andymatuschak|apple\.com/DTD|w3\.org|swift\.org' | sort -u || true)"
unexpected="$(printf '%s\n' "$hosts" | grep -vE "^($ALLOWED_HOSTS_RE)" | grep . || true)"
[ -z "$unexpected" ] || { echo "BLOCK: unexpected baked-in host(s):" >&2; printf '%s\n' "$unexpected" >&2; exit 3; }
printf '%s\n' "$hosts" | sed 's/^/   host: /'

echo "→ verify: Sparkle update key unchanged"
edkey="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$APP/Contents/Info.plist" 2>/dev/null || true)"
[ "$edkey" = "$EXPECTED_EDKEY" ] || { echo "BLOCK: SUPublicEDKey changed → $edkey" >&2; exit 4; }

echo "→ install → $DEST"
[ -d "$DEST" ] && rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

mkdir -p "$PIN_DIR"
printf '%s %s\n' "$TAG" "$COMMIT" > "$PIN_DIR/pinned.txt"
echo "→ pinned: $TAG $COMMIT"
codesign -dv --verbose=2 "$DEST" 2>&1 | grep -iE 'Signature|TeamIdentifier' || true
echo "✓ installed $TAG. If the signature is ad-hoc, re-grant Accessibility once."
