---
name: wt-land
description: Land a branch into the default branch as one no-ff merge commit.
---

Run this only when the user explicitly asked to merge or land a branch — never on your own initiative.

## Land

- From the branch's worktree: `wt land` — the worktrunk alias expands to `git -C <primary> merge --no-ff <branch>`. Or run that `git merge --no-ff <branch>` in the primary yourself.
- It is a single **no-ff, no-squash** merge commit, straight into the default branch. Never ff, squash, or rebase.
- Use `wt land`, not `wt merge`: worktrunk's `wt merge` default is squash + rebase + ff, which flattens the branch into the default branch.
- Resolve conflicts **in the primary worktree, inside that merge**. Run the project's typecheck + tests on the merged tree, then commit. If it doesn't build: `git merge --abort` — the default branch never lands broken.
- Do NOT pre-merge the default branch into the feature branch first, and don't reach for `git rerere` or a temp worktree. Those only look necessary when the default branch isn't parked in the primary — fix the layout (below) instead.
- Don't `git push` — leave the push to the user.

## The single default-branch worktree is the merge lock

Git allows a branch in one worktree only, so the default branch exists in exactly one place — the primary. Every land funnels through it and serializes; an in-progress merge (conflict resolution) holds it, so two agents cannot land at once. This holds for free while the default branch stays in the primary.

## Recover a broken layout

Symptom: the default branch is checked out nowhere, or the primary sits on a feature branch — `wt switch <default>` refuses (`there's a worktree at the expected path …`), `git worktree list` confirms. While it's homeless, `wt land` and `git worktree add <tmp> <default>` both misfire — the trap that tempts the back-merge / temp-worktree workarounds.

Fix: park the primary back on the default branch — commit or stash the stray work, move that branch into its own worktree, `git switch <default>` in the primary. Only then land. worktrunk resolves the default branch from `git config worktrunk.default-branch`.
