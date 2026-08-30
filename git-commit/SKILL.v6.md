---
name: git-commit
description: Generates Conventional Commits messages by analyzing staged changes and repo commit history. Use when the user says "commit", "git commit", or asks to commit changes.
license: MIT
metadata:
  version: 6.4.0
---

# Git Commit

## Rules

- Commit message in English only
- Subject line under 100 characters, Conventional Commits format: `type(scope): subject`
- Body uses bullets only — no prose paragraphs, no lead-in sentences
- Do not push, only commit
- Do not ask the user why, infer from the diff and conversation
- Never add AI attribution lines

## Workflow

**Always invoke wrappers as standalone binaries (`git-commit-context`, `git-commit-atomic`), never via git subcommand form (`git commit-context`, `git -C <path> commit-atomic`).** The subcommand form is fragile to model regenerate — the subcommand token can merge into an adjacent path token and disappear silently. Use the `-C <repo>` flag of the wrapper instead.

1. Run the read-only context helper:

   ```bash
   git-commit-context -C <repo>
   ```

   `<repo>` — absolute path to the worktree. Default output: branch info, working-tree status, **worktree diff `--stat` only**, branch divergence, recent-commits style, detected repo commit conventions. Add `--full-diff` if a full unified diff is genuinely needed (rare — you usually have edit context already and can request specific hunks via `git -C <repo> diff HEAD -- <path>`).

2. Choose commit mode — **`--auto` is the default**:

   The mode determines signing. **Never pass `-S`** — the agent never signs; signing is deferred to push (`git sp`), and only the opt-in editor commit is signed by the `commit.gpgsign` default.

   - **Default — pass `--auto`** (both an autonomous task commit and an explicit `/git-commit` with no argument): no editor preview. The `--auto` path builds via `git commit-tree`, which ignores `commit.gpgsign`, so the commit is **unsigned** — deliberate, so a locked signing agent can never block a commit and no Touch ID / 1Password-fallback prompt fires mid-task. These commits are signed later in one batch at push by `git sp` (the `git-sign-push` wrapper), which re-signs the whole un-pushed range through the Secure Enclave key.
   - **Argument `edit` (`/git-commit edit`)** — the user explicitly wants an interactive, reviewed commit: editor mode (no `--auto`). Repo `pre-commit` / `commit-msg` / `post-commit` hooks run and the commit is **signed** via `commit.gpgsign`. Rare — use only on explicit request.

3. Run the wrapper:

   ```bash
   git-commit-atomic -C <repo> [flags] "<message>" [<file>...] [-- <patch>...]
   ```

   - **Files** (positional, before `--`): staged whole from the worktree.
   - **Patches** (positional, after `--`): applied to an ephemeral index via `git apply --cached`.
   - The two halves combine into one commit, so you can mix them: `git-commit-atomic -C <repo> "msg" foo.md bar.md -- baz.diff`.
   - File paths are relative to `<repo>` (the wrapper `chdir`s into it before running).

   The wrapper has two execution paths:

   - **Editor path (no `--auto`)** — delegates to `git commit -e`. The user's real editor opens for message review, repo `pre-commit` / `commit-msg` / `post-commit` hooks fire, lint and test gates run as configured. Race-safety: `.git/index.lock` (git-native), no CAS against `HEAD` movement. Opt-in only, via `/git-commit edit`.
   - **`--auto`** — builds the commit on top of `HEAD` in an ephemeral `GIT_INDEX_FILE` under `$GIT_DIR`, then advances `HEAD` via atomic compare-and-swap (`commit-tree` + `update-ref HEAD <new> <expected>`). On lost CAS the wrapper retries with the new `HEAD` snapshot. Race-safe under parallel Claude sessions sharing the worktree, but hooks are NOT executed (plumbing flow). **The default path**: autonomous task commits, plain `/git-commit`, and concurrent sessions sharing the worktree.

   Supported flags (must precede the message):

   | Flag | Effect |
   |---|---|
   | `-C <path>`, `--repo <path>` | `chdir` into `<path>` before committing. Always use this instead of `git -C <path> commit-atomic` to avoid subcommand-token-merge regenerate failures. |
   | `--auto` | Take the CAS path; skip editor preview. The default; the editor path is opt-in via `/git-commit edit`. |
   | `-s`, `--signoff` | Append `Signed-off-by` trailer (forwarded to `git commit -s` in editor mode; manually appended in `--auto`). |
   | `-n`, `--no-verify` | In editor mode: forwarded to `git commit --no-verify` (skips hooks). In `--auto`: no-op (hooks aren't run anyway). |
   | `--author "Name <email>"` | Override commit author via `GIT_AUTHOR_NAME`/`EMAIL`. |
   | `--date <when>` | Override author date via `GIT_AUTHOR_DATE`. |
   | `--allow-empty-message` | Don't abort on empty post-edit message. |

   Unknown flags are rejected with exit 2: the plumbing path does not honor most `git commit` flags (e.g. `-c`, `--fixup`, `--squash`, `--reuse-message`), so silent pass-through would be misleading.

4. Do not run bare `git add`, `git commit`, or `git commit-edit`. Do not invoke via git subcommand form (`git commit-atomic`, `git -C <path> commit-atomic`) — always standalone `git-commit-atomic -C <path>`. Do not pass `GIT_INDEX_FILE=...`.

Do not push.
