#!/usr/bin/env bash
# gather-context.v6.sh — read-only context for the v6 git-commit skill.
# Output: BRANCH, WORKING TREE, WORKTREE DIFF (--stat), BRANCH DIVERGENCE,
# RECENT COMMITS, REPO COMMIT CONVENTIONS. No mutations to any index.
#
# Usage: gather-context.v6.sh [-C <repo>] [--full-diff] [REPO]
#   -C <repo>, --repo <repo>   Path to repo (preferred form)
#   --full-diff                Include full unified diff (default: --stat only)
#   REPO (positional)          Backwards-compat fallback for repo path
#
# Default omits the full unified diff to keep the output bounded — large
# refactors used to blow past Claude Code's bash output limit and fail the
# whole call. The agent already has the diff context from its own edits;
# request specific hunks explicitly via `git -C <repo> diff HEAD -- <path>`
# when needed.

set -uo pipefail

REPO=""
SHOW_FULL_DIFF=0
PATHS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -C)            REPO="${2:-}"; shift 2 ;;
    --repo)        REPO="${2:-}"; shift 2 ;;
    --repo=*)      REPO="${1#--repo=}"; shift ;;
    --full-diff)   SHOW_FULL_DIFF=1; shift ;;
    --)            shift; PATHS=("$@"); break ;;
    -*)            echo "gather-context: unsupported flag: $1" >&2; exit 2 ;;
    *)             REPO="$1"; shift ;;
  esac
done
REPO="${REPO:-$PWD}"

git_cmd() { git -C "$REPO" "$@"; }
scoped() {
  if [ ${#PATHS[@]} -gt 0 ]; then
    "$@" -- "${PATHS[@]}"
  else
    "$@"
  fi
}

if ! git_cmd rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $REPO is not a git work tree" >&2
  exit 1
fi

section() { printf '\n=== %s ===\n' "$1"; }

BRANCH=$(git_cmd branch --show-current 2>/dev/null || echo "(detached)")
JIRA=$(printf '%s' "$BRANCH" | grep -oE '[A-Z][A-Z0-9]+-[0-9]+' | head -n1 || true)

BASE=""
for candidate in main master trunk develop; do
  if git_cmd rev-parse --verify --quiet "refs/heads/$candidate" >/dev/null; then
    BASE="$candidate"
    break
  fi
done

section "BRANCH"
printf 'current: %s\n' "$BRANCH"
[ -n "$JIRA" ] && printf 'jira:    %s\n' "$JIRA"
[ -n "$BASE" ] && printf 'base:    %s\n' "$BASE"

section "WORKING TREE (changed files)"
scoped git_cmd status --short

WT_STAT=$(scoped git_cmd diff HEAD --stat)
if [ -z "$WT_STAT" ]; then
  section "WORKTREE DIFF"
  echo "(empty — worktree matches HEAD)"
else
  section "WORKTREE DIFF (--stat)"
  printf '%s\n' "$WT_STAT"
  if [ "$SHOW_FULL_DIFF" = 1 ]; then
    section "WORKTREE DIFF (full)"
    scoped git_cmd diff HEAD
  fi
fi

if [ ${#PATHS[@]} -gt 0 ]; then
  section "LAST COMMIT TOUCHING PATHS"
  scoped git_cmd log -1 --format='%h %cI %s' || true
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
scoped git_cmd log --oneline -500 | awk '
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
