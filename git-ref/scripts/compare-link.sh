#!/usr/bin/env bash
set -euo pipefail

do_open=0
repo_dir="."
while :; do
  case "${1:-}" in
    --open) do_open=1; shift ;;
    -C) repo_dir="${2:?usage: compare-link.sh [--open] [-C <repo>] <ref1> <ref2>}"; shift 2 ;;
    *) break ;;
  esac
done

ref1="${1:?usage: compare-link.sh [--open] [-C <repo>] <ref1> <ref2>}"
ref2="${2:?usage: compare-link.sh [--open] [-C <repo>] <ref1> <ref2>}"

repo_root="$(git -C "$repo_dir" rev-parse --show-toplevel)"
sha1="$(git -C "$repo_root" rev-parse --verify "${ref1}^{commit}")"
sha2="$(git -C "$repo_root" rev-parse --verify "${ref2}^{commit}")"
repo_id="$(git -C "$repo_root" rev-list --max-parents=0 HEAD | tail -n1)"

scheme="vscode"
case "${VSCODE_GIT_ASKPASS_NODE:-}${TERM_PROGRAM:-}" in
  *[Cc]ursor*) scheme="cursor" ;;
  *[Ww]indsurf*) scheme="windsurf" ;;
esac

enc() { printf '%s' "$1" | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip(), safe=""))'; }

remote_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)"
query="url=$(enc "$remote_url")&path=$(enc "$repo_root")"

link="${scheme}://eamodio.gitlens/link/r/${repo_id}/compare/${sha1}...${sha2}?${query}"

redirect="https://vscode.dev/redirect?url=$(enc "$link")"

printf 'deep: %s\nredirect: %s\n' "$link" "$redirect"

if [ "$do_open" = 1 ]; then
  open "$link"
fi
