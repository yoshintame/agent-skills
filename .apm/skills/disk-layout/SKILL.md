---
name: disk-layout
description: Where repositories live on disk.
---

Clone target is derived from the `origin` remote, never chosen by category:

| Case | Target |
|---|---|
| Any repo you will work in | `~/Development/<owner>/<repo>` |
| Repo with no remote | `~/Development/local/<repo>` |
| Clone only to read code, answer a question, copy a pattern | `~/.cache/repos/<owner>/<repo>` |

- `<owner>` is the remote owner in lowercase (`Yoshintame` → `yoshintame`); `<repo>` is the remote name without `.git`.
- A fork is its own repo under its own owner: clone `yoshintame/x`, not `upstream-org/x`, into `~/Development/yoshintame/x`.
- No host level (`github.com/`), no category or language folders (`work/`, `personal/`, `forks/`, `ts/`, `go/`). Classification lives in metadata, not in the path.
- `~/.cache/repos` is disposable: never keep changes there.

Repos still sitting at legacy paths (`~/Development/projects/...`, `~/Development/work/...`, `~/Development/personal/...`) stay where they are unless the user asks to move one. A move also needs the Claude Code session dir in `~/.claude/projects/` (named after the encoded cwd) and the project key in `~/.claude.json` renamed, plus `git worktree repair` if the repo has linked worktrees.

The `git-clone-layout.sh` PreToolUse hook denies `git clone` into any other target and prints the expected path. Override for a deliberate exception: prefix the command with `FORCE_CLONE_PATH=1`.
