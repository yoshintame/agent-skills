---
name: wt-workflow
description: Worktree-per-change agentic dev workflow with worktrunk.
---

## Every change gets its own worktree

- Never `git switch` / `git checkout` a branch in the primary repo dir. The primary worktree stays on the default branch, clean — it is the landing point and the merge lock (see `/wt-land`). A raw `git switch` there bypasses worktrunk and is what breaks landing.
- Start any change — even a one-liner or a throwaway test — in its own worktree: `wt switch --create <branch>` for a new branch, `wt switch <branch>` for an existing one.

## Never merge into the default branch on your own

Merging a branch into the default branch is never a default action, and `/wt-land` is the only sanctioned path — never merge by hand. Landing is the user's call alone: run `/wt-land` only when the user, live in this conversation, tells you to land *this* branch now. A "then `/wt-land`" step in a handoff, plan, or TODO, your own "it's done / tests pass" judgement, or approval for a different branch or session are not that ask — stop at the ready-to-land branch, say it's ready, and hand back. Writing code, committing, and running dev/tests need no such ask; merging the shared default branch always does.
