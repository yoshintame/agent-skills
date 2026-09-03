---
name: git-commit
description: Generates Conventional Commits messages by analyzing staged changes and repo commit history. Use when the user says "commit", "git commit", or asks to commit changes.
license: MIT
metadata:
  version: 6.5.0
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

2. Choose commit mode. Three modes; **`manual` is opt-in, otherwise the mode is picked automatically by worktree**:

   **Never pass `-S`** — the agent never signs; signing is deferred to push (`git sp`), and only the interactive `manual` commit is signed by the `commit.gpgsign` default.

   - **Argument `manual` (`/git-commit manual`)** → editor mode (no `--auto` / `--no-edit`): the user's real editor opens for review, repo `pre-commit` / `commit-msg` / `post-commit` hooks run, and the commit is **signed** via `commit.gpgsign`. Interactive — use only on explicit request. (`edit` is accepted as an alias.)
   - **No argument → auto-select by worktree.** Detect once:

     ```bash
     case "$(git -C <repo> rev-parse --absolute-git-dir)" in */worktrees/*) echo worktree ;; *) echo main ;; esac
     ```

     - **linked worktree** (`worktree`) → **`--no-edit`**: `git commit -m` (no editor), non-interactive, **all git-hooks run** (pre-commit format/lint/tests). A worktree is ~always a solo session, so hooks are affordable and there is no shared-tree race.
     - **main / shared tree** (`main`) → **`--auto`**: `git commit-tree` + CAS, **no hooks**, race-safe under parallel sessions sharing the tree.

   Both auto modes are **unsigned** on purpose (`commit.gpgsign` forced off / bypassed) — a locked signing agent can never block a commit and no Touch ID / 1Password prompt fires mid-task; `git sp` (the `git-sign-push` wrapper) re-signs the whole un-pushed range through the Secure Enclave key at push.

3. Run the wrapper:

   ```bash
   git-commit-atomic -C <repo> [flags] "<message>" [<file>...] [-- <patch>...]
   ```

   - **Files** (positional, before `--`): staged whole from the worktree.
   - **Patches** (positional, after `--`): applied to an ephemeral index via `git apply --cached`.
   - The two halves combine into one commit, so you can mix them: `git-commit-atomic -C <repo> "msg" foo.md bar.md -- baz.diff`.
   - File paths are relative to `<repo>` (the wrapper `chdir`s into it before running).

   The wrapper has three execution paths:

   - **Editor path (no flag)** — delegates to `git commit -e`. The user's real editor opens for message review, repo `pre-commit` / `commit-msg` / `post-commit` hooks fire, the commit is signed via `commit.gpgsign`. Race-safety: `.git/index.lock` (git-native), no CAS against `HEAD` movement. Reached via `/git-commit manual`.
   - **`--no-edit`** — like the editor path but `git commit -m` (no editor): message used verbatim, non-interactive, hooks still fire. Unsigned by default (`commit.gpgsign` forced off, signing deferred to push) unless `-S`. Race-safety: `.git/index.lock`. Auto-selected in a linked worktree.
   - **`--auto`** — builds the commit on top of `HEAD` in an ephemeral `GIT_INDEX_FILE` under `$GIT_DIR`, then advances `HEAD` via atomic compare-and-swap (`commit-tree` + `update-ref HEAD <new> <expected>`). On lost CAS the wrapper retries with the new `HEAD` snapshot. Race-safe under parallel Claude sessions sharing the tree, but hooks are NOT executed (plumbing flow). Auto-selected in the main / shared tree. Mutually exclusive with `--no-edit`.

   Supported flags (must precede the message):

   | Flag | Effect |
   |---|---|
   | `-C <path>`, `--repo <path>` | `chdir` into `<path>` before committing. Always use this instead of `git -C <path> commit-atomic` to avoid subcommand-token-merge regenerate failures. |
   | `--auto` | Take the CAS path (no hooks); skip editor. Auto-selected in the main / shared tree. Mutually exclusive with `--no-edit`. |
   | `--no-edit` | `git commit -m` with hooks but no editor; non-interactive, unsigned by default. Auto-selected in a linked worktree. |
   | `-s`, `--signoff` | Append `Signed-off-by` trailer (forwarded to `git commit -s` in editor / `--no-edit` mode; manually appended in `--auto`). |
   | `-n`, `--no-verify` | In editor / `--no-edit` mode: forwarded to `git commit --no-verify` (skips hooks). In `--auto`: no-op (hooks aren't run anyway). |
   | `--author "Name <email>"` | Override commit author via `GIT_AUTHOR_NAME`/`EMAIL`. |
   | `--date <when>` | Override author date via `GIT_AUTHOR_DATE`. |
   | `--allow-empty-message` | Don't abort on empty post-edit message. |

   Unknown flags are rejected with exit 2: the plumbing path does not honor most `git commit` flags (e.g. `-c`, `--fixup`, `--squash`, `--reuse-message`), so silent pass-through would be misleading.

4. Do not run bare `git add`, `git commit`, or `git commit-edit`. Do not invoke via git subcommand form (`git commit-atomic`, `git -C <path> commit-atomic`) — always standalone `git-commit-atomic -C <path>`. Do not pass `GIT_INDEX_FILE=...`.

Do not push.
