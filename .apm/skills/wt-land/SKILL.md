---
name: wt-land
description: Land a branch into the default branch as one no-ff merge commit, then remove its worktree.
---

Run this only when the user explicitly asked to merge or land a branch — never on your own initiative.

## Arguments

- **No argument (default)** → land, then remove the branch's worktree and delete the now-merged branch.
- **`keep`** (`/wt-land keep`) → land only; leave the worktree and branch in place. This is the old behaviour.

## Land

- From the branch's worktree: `wt land` — the worktrunk alias expands to `git -C <primary> merge --no-ff <branch>`. Or run that `git merge --no-ff <branch>` in the primary yourself.
- It is a single **no-ff, no-squash** merge commit, straight into the default branch. Never ff, squash, or rebase.
- Use `wt land`, not `wt merge`: worktrunk's `wt merge` default is squash + rebase + ff, which flattens the branch into the default branch.
- Resolve conflicts **in the primary worktree, inside that merge**. Run the project's typecheck + tests on the merged tree, then commit. If it doesn't build: `git merge --abort` — the default branch never lands broken.
- Do NOT pre-merge the default branch into the feature branch first, and don't reach for `git rerere` or a temp worktree. Those only look necessary when the default branch isn't parked in the primary — fix the layout (below) instead.
- Don't `git push` — leave the push to the user.

## Clean up after landing (default)

- Skip this entire section if the user passed `keep`. Then just tell them the worktree and branch stay.
- Only clean up once the merge commit exists and the merged tree passed typecheck + tests. Never remove anything after `git merge --abort`, mid-conflict, or a failed build — the point of landing is a clean default branch, and a half-landed branch's worktree must survive for the retry.
- From the primary (default-branch) worktree, remove the branch's worktree and its now-merged branch in one step:
  ```
  wt remove <branch> -f -y --foreground
  ```
  - `wt remove` deletes the worktree and, because the branch is merged, the branch with it. Pass `--no-delete-branch` to keep the branch label; never reach for `-D` (force-delete unmerged) here — a landed branch is always merged.
  - `-f` is required: the worktree holds untracked build artifacts (`node_modules`, generated route trees, etc.) and removal refuses without it.
  - `-y` skips the approval prompt and `--foreground` blocks until it finishes, so you can confirm and report the result.
- Run it with the Bash sandbox disabled (`dangerouslyDisableSandbox: true`). `wt remove` deletes the worktree's admin dir under the primary's `.git/worktrees/`, and the sandbox blocks that with `Operation not permitted` — a sandboxed run removes the worktree directory but leaves a stale `prunable` registration and then fails the branch delete with `cannot delete branch … used by worktree at …`.
- If a sandboxed attempt already left that half-state, recover with the sandbox off: `git -C <primary> worktree prune` to drop the stale registration, then `git -C <primary> branch -d <branch>` to delete the merged branch.
- Run it from the primary, never from inside the worktree you are deleting. Target the branch by name so the current directory is irrelevant.
- The deleted branch is not pushed, but its commits are reachable from the default branch through the merge commit — nothing is lost. Say in the recap that the worktree and branch were removed (or, with `keep`, that they remain).

## The single default-branch worktree is the merge lock

Git allows a branch in one worktree only, so the default branch exists in exactly one place — the primary. Every land funnels through it and serializes; an in-progress merge (conflict resolution) holds it, so two agents cannot land at once. This holds for free while the default branch stays in the primary.

## Recover a broken layout

Symptom: the default branch is checked out nowhere, or the primary sits on a feature branch — `wt switch <default>` refuses (`there's a worktree at the expected path …`), `git worktree list` confirms. While it's homeless, `wt land` and `git worktree add <tmp> <default>` both misfire — the trap that tempts the back-merge / temp-worktree workarounds.

Fix: park the primary back on the default branch — commit or stash the stray work, move that branch into its own worktree, `git switch <default>` in the primary. Only then land. worktrunk resolves the default branch from `git config worktrunk.default-branch`.
