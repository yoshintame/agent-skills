---
name: git-commit
description: Generates Conventional Commits messages by analyzing staged changes and repo commit history. Use when the user says "commit", "git commit", or asks to commit changes.
license: MIT
metadata:
  version: 5.4.0
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

1. Run the context helper (provisions a per-session private index that isolates staging from parallel Claude sessions and rebases onto current `HEAD`):

   ```bash
   git commit-context
   ```

   This command also resets the shared `.git/index` to `HEAD`. The skill treats shared staging as disposable.

2. Use the `GIT_INDEX_FILE=<path>` prefix from the `PRIVATE INDEX` section on **every** git command. Bash calls don't share env. Never run bare `git add` / `git commit`.

3. Stage only files/hunks for the current task into the private index. Keep commits atomic. Match recent-commits style.

4. Re-run `git commit-context --index <path>` right before committing. If output contains `rebased: <old> -> <new>`, re-check the staged diff — a parallel session committed and the index was refreshed.

5. Commit:

   ```bash
   GIT_INDEX_FILE=<path> git commit-edit "<message>"
   ```

   `git commit-edit` refreshes `<path>.base` after a successful private-index commit and always resets the shared index to `HEAD`.

Do not push.
