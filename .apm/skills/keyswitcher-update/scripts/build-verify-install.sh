#!/usr/bin/env bash
# Build <audited-tag>, or a local patch <ref> on top of it, from source, verify it against the
# audited baseline, install to /Applications, and record the pin. Exits non-zero (BLOCK) on any
# verification failure — caller must not install.
set -euo pipefail
UPSTREAM="https://github.com/graninilya/keyswitcher"
REPO="${KSW_REPO:-$UPSTREAM}"
TAG="${1:?usage: [KSW_REPO=<path>] build-verify-install.sh <audited-tag> [<local-ref>]}"
REF="${2:-$TAG}"
APP_NAME="keySwitcher.app"
DEST="/Applications/$APP_NAME"
PIN_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/keyswitcher-update"
PIN="$PIN_DIR/pinned.txt"

ALLOWED_HOSTS_RE='qkb-llm\.graninilya\.workers\.dev|github\.com/graninilya/keyswitcher|api\.openai\.com'
ALLOWED_LITERALS_RE='https://ya\.ru/a,b'
EXPECTED_EDKEY='+VYV2MzhMzAQl+Qwb7wPPR4HldDmiINfqpiU8kva9Mo='

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ksw-build.XXXXXX")"
git clone --quiet "$REPO" "$WORK/repo"
git -C "$WORK/repo" checkout --quiet "$REF" --
COMMIT="$(git -C "$WORK/repo" rev-parse HEAD)"

echo "→ verify: base tag $TAG matches upstream"
TAG_COMMIT="$(git -C "$WORK/repo" rev-parse "$TAG^{commit}")"
UPSTREAM_TAG_COMMIT="$(git ls-remote "$UPSTREAM" "refs/tags/$TAG" "refs/tags/$TAG^{}" | sort -k2 | tail -1 | cut -f1)"
[ "$TAG_COMMIT" = "$UPSTREAM_TAG_COMMIT" ] || { echo "BLOCK: $TAG is $TAG_COMMIT here, ${UPSTREAM_TAG_COMMIT:-missing} upstream" >&2; exit 7; }
git -C "$WORK/repo" merge-base --is-ancestor "$TAG" HEAD || { echo "BLOCK: $REF is not based on $TAG" >&2; exit 7; }

pinned_base="$(awk 'NR==1{print $1}' "$PIN" 2>/dev/null || true)"
if [ -n "$pinned_base" ] && [ "$pinned_base" != "$TAG" ]; then
  echo "→ base moves $pinned_base → $TAG: valid only after a clean audit of that diff"
fi

LOCAL=""
if [ "$COMMIT" != "$TAG_COMMIT" ]; then
  LOCAL="$REF"
  echo "→ local commits on top of $TAG (review them against the threat model):"
  git -C "$WORK/repo" log --oneline "$TAG..HEAD" | sed 's/^/   /'
fi

echo "→ building $REPO @ $REF ($COMMIT)"
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
unexpected="$(printf '%s\n' "$hosts" | grep -vE "^https?://($ALLOWED_HOSTS_RE)([/:?#)]|$)" \
  | grep -vxE "$ALLOWED_LITERALS_RE" | grep . || true)"
[ -z "$unexpected" ] || { echo "BLOCK: unexpected baked-in host(s):" >&2; printf '%s\n' "$unexpected" >&2; exit 3; }
printf '%s\n' "$hosts" | sed 's/^/   host: /'

echo "→ verify: Sparkle update key unchanged"
edkey="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$APP/Contents/Info.plist" 2>/dev/null || true)"
[ "$edkey" = "$EXPECTED_EDKEY" ] || { echo "BLOCK: SUPublicEDKey changed → $edkey" >&2; exit 4; }

if [ -n "$LOCAL" ]; then
  echo "→ verify: self-test of the built bundle"
  "$EXE" --self-test || { echo "BLOCK: self-test failed" >&2; exit 5; }
fi

echo "→ install → $DEST"
was_running=false
if pgrep -x keySwitcher >/dev/null; then
  was_running=true
  osascript -e 'tell application id "com.granin.keyswitcher" to quit'
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x keySwitcher >/dev/null || break; sleep 0.5; done
  if pgrep -x keySwitcher >/dev/null; then
    echo "BLOCK: keySwitcher did not quit; nothing installed" >&2
    exit 6
  fi
fi
[ -d "$DEST" ] && rm -rf "$DEST"
cp -R "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
defaults write com.granin.keyswitcher SUAutomaticallyUpdate -bool NO
echo "→ Sparkle auto-install off (update checks stay on)"
if $was_running; then open "$DEST"; fi

mkdir -p "$PIN_DIR"
printf '%s\n' "$TAG $COMMIT${LOCAL:+ $LOCAL}" > "$PIN"
echo "→ pinned: $TAG $COMMIT${LOCAL:+ $LOCAL}"
codesign -dv --verbose=2 "$DEST" 2>&1 | grep -iE 'Signature|TeamIdentifier' || true
echo "✓ installed $TAG${LOCAL:+ + $LOCAL}. If the signature is ad-hoc, re-grant Accessibility once."
