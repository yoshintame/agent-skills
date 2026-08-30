#!/usr/bin/env bash
# gather-context.sh — collect everything the git-commit skill needs in one shot.
#
# Also provisions a per-session private git index so concurrent Claude sessions
# in the same repo can stage and commit independently without stepping on each
# other's staged files.
#
# Usage: gather-context.sh [--index PATH] [REPO]
#   --index PATH   Reuse an existing private index path (idempotent across calls).
#   REPO           Path to repo (default: $PWD).

set -uo pipefail

INDEX_ARG=""
REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --index)
      INDEX_ARG="${2:-}"
      shift 2
      ;;
    --index=*)
      INDEX_ARG="${1#--index=}"
      shift
      ;;
    *)
      REPO="$1"
      shift
      ;;
  esac
done
REPO="${REPO:-$PWD}"

git_cmd() { git -C "$REPO" "$@"; }
git_priv() { GIT_INDEX_FILE="$PRIV_INDEX" git -C "$REPO" "$@"; }
git_shared() { (unset GIT_INDEX_FILE; git -C "$REPO" "$@"); }

if ! git_cmd rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $REPO is not a git work tree" >&2
  exit 1
fi

GIT_DIR=$(git_cmd rev-parse --git-dir)
case "$GIT_DIR" in
  /*) ;;
  *)  GIT_DIR="$REPO/$GIT_DIR" ;;
esac

SESSIONS_DIR="$GIT_DIR/claude-sessions"
mkdir -p "$SESSIONS_DIR"

if [ -n "$INDEX_ARG" ]; then
  PRIV_INDEX="$INDEX_ARG"
elif [ -n "${GIT_INDEX_FILE:-}" ]; then
  PRIV_INDEX="$GIT_INDEX_FILE"
else
  PRIV_INDEX=$(mktemp "$SESSIONS_DIR/idx-XXXXXXXX")
fi

CURRENT_HEAD=$(git_cmd rev-parse HEAD)
REBASED_FROM=""

if [ ! -s "$PRIV_INDEX" ]; then
  GIT_INDEX_FILE="$PRIV_INDEX" git_cmd read-tree HEAD
  printf '%s\n' "$CURRENT_HEAD" > "$PRIV_INDEX.base"
else
  PRIV_BASE=""
  [ -f "$PRIV_INDEX.base" ] && PRIV_BASE=$(cat "$PRIV_INDEX.base")
  if [ -n "$PRIV_BASE" ] && [ "$PRIV_BASE" != "$CURRENT_HEAD" ]; then
    # HEAD moved (parallel session committed). Rebase the private index onto
    # the new HEAD: remember which paths we already staged, reset the index to
    # the new HEAD tree, then re-stage those paths from the worktree. Without
    # this, our commit would silently revert the parallel session's changes
    # for every untouched file.
    STAGED_PATHS=$(git_priv diff --cached --name-only "$PRIV_BASE" 2>/dev/null || true)
    GIT_INDEX_FILE="$PRIV_INDEX" git_cmd read-tree "$CURRENT_HEAD"
    if [ -n "$STAGED_PATHS" ]; then
      printf '%s\n' "$STAGED_PATHS" | while IFS= read -r path; do
        [ -z "$path" ] && continue
        if [ -e "$REPO/$path" ]; then
          git_priv add -- "$path"
        else
          git_priv rm -- "$path" >/dev/null 2>&1 || true
        fi
      done
    fi
    printf '%s\n' "$CURRENT_HEAD" > "$PRIV_INDEX.base"
    REBASED_FROM="$PRIV_BASE"
  fi
fi

section() {
  printf '\n=== %s ===\n' "$1"
}

git_shared read-tree HEAD

BRANCH=$(git_cmd branch --show-current 2>/dev/null || echo "(detached)")
JIRA=$(printf '%s' "$BRANCH" | grep -oE '[A-Z][A-Z0-9]+-[0-9]+' | head -n1 || true)

BASE=""
for candidate in main master trunk develop; do
  if git_cmd rev-parse --verify --quiet "refs/heads/$candidate" >/dev/null; then
    BASE="$candidate"
    break
  fi
done

section "PRIVATE INDEX"
printf 'path: %s\n' "$PRIV_INDEX"
printf 'base: %s\n' "$CURRENT_HEAD"
printf 'usage: GIT_INDEX_FILE=%s git add -- <paths>\n' "$PRIV_INDEX"
if [ -n "$REBASED_FROM" ]; then
  printf 'rebased: %s -> %s (parallel session committed; untouched files refreshed from new HEAD)\n' "$REBASED_FROM" "$CURRENT_HEAD"
fi

section "SHARED INDEX"
echo "reset: .git/index -> HEAD"
echo "policy: shared staging is disposable; rebuild it manually if you really need it"

section "BRANCH"
printf 'current: %s\n' "$BRANCH"
[ -n "$JIRA" ] && printf 'jira:    %s\n' "$JIRA"
[ -n "$BASE" ] && printf 'base:    %s\n' "$BASE"

section "WORKING TREE (changed files)"
git_cmd status --short

PRIV_DIFF=$(git_priv diff --cached)
if [ -z "$PRIV_DIFF" ]; then
  section "STAGED DIFF (private index)"
  echo "(empty — stage with: GIT_INDEX_FILE=$PRIV_INDEX git add -- <paths>)"
else
  section "STAGED DIFF — private index (--stat)"
  git_priv diff --cached --stat
  section "STAGED DIFF — private index (full)"
  printf '%s\n' "$PRIV_DIFF"
fi

if [ -n "$BASE" ] && [ "$BRANCH" != "$BASE" ]; then
  section "BRANCH DIVERGENCE ($BASE..HEAD)"
  COUNT=$(git_cmd rev-list --count "$BASE..HEAD" 2>/dev/null || echo 0)
  printf 'commits ahead of %s: %s\n' "$BASE" "$COUNT"
  if [ "$COUNT" != "0" ]; then
    git_cmd log --oneline "$BASE..HEAD"
  fi
fi

section "RECENT COMMITS (up to 25 unique type(scope) prefixes)"
git_cmd log --oneline -500 | awk '
{
  i = index($0, " ")
  subj = substr($0, i+1)
  if (match(subj, /^[a-zA-Z]+(\([^)]+\))?:/)) {
    key = substr(subj, RSTART, RLENGTH)
  } else {
    key = subj
  }
  if (!(key in seen)) {
    seen[key] = 1
    print
    n++
    if (n >= 25) exit
  }
}'

section "REPO COMMIT CONVENTIONS"
FOUND_CONVENTIONS=0
ROOT=$(git_cmd rev-parse --show-toplevel)
for f in \
  .commitlintrc .commitlintrc.json .commitlintrc.yaml .commitlintrc.yml \
  .commitlintrc.js .commitlintrc.cjs commitlint.config.js commitlint.config.cjs \
  commitlint.config.mjs commitlint.config.ts \
  .gitmessage .github/commit-convention.md CONTRIBUTING.md CONTRIBUTING.rst
do
  if [ -f "$ROOT/$f" ]; then
    printf 'found: %s\n' "$f"
    FOUND_CONVENTIONS=1
  fi
done
[ "$FOUND_CONVENTIONS" = "0" ] && echo "(none detected — infer from recent commits)"
