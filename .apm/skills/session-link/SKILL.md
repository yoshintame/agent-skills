---
name: session-link
description: Make a Claude Code session resumable from another directory.
---

```
bun ~/.claude/skills/session-link/scripts/link-session-to.ts <dst-cwd> [src-cwd] [--session <id>]
```

`src-cwd` defaults to cwd, `--session` to `$CLAUDE_CODE_SESSION_ID` (falling back to the
newest transcript under `src-cwd`'s project folder). Any two directories work — no git,
no worktree relationship required.

Run it with the Bash sandbox disabled (`dangerouslyDisableSandbox: true`) from the start:
the write target `~/.claude/projects/**` sits in the sandbox's built-in write-deny, so a
sandboxed attempt always dies with `EPERM: operation not permitted, link`. `Bash(bun *)`
is allowlisted, so the unsandboxed call goes through without a prompt.

Relay the `session-link:` lines verbatim.

## What it does and does not do

The transcript `<id>.jsonl` is an append-log on a single inode; hardlinking it into the
destination's project folder makes the session appear in that directory's native picker.
Both entries stay — this adds a path, it does not remove the old one. The underlying
`link-session-jsonl` is idempotent, so re-running is free.

Sidecar directories are not mirrored, and don't need to be: `tool-results` are addressed
by absolute path baked into the JSONL, so they resolve from wherever they were written.
`subagents` are resolved relative to the project folder and won't be found from the new
path — that costs only expanding a subagent's inner transcript, not resume itself.

For a **live** session, context compaction can replace the transcript atomically, which
leaves the mirror frozen on the old inode. The symptom is a stale session at the
destination while the source keeps growing; re-running the command relinks it.
