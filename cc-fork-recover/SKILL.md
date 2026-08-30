---
name: cc-fork-recover
description: Recover an orphaned Claude Code fork session in the VSCode extension.
---

A VSCode "Fork conversation" that opened a blank tab or never showed in the session list is not lost — the fork's transcript is on disk, only untitled, so the picker drops it. Recover it with the bundled CLI.

Run it against the session that was **forked from** (the one still visible), not the blank tab:

```
cc-fork-recover <source-session-id>
```

The id may be a full uuid or a ≥8-char prefix. Flags: default titles the newest orphan; `--all` every orphan; `--dry-run` previews; `--json` for machine output.

The real run appends to `~/.claude/projects/**`, which the sandbox write-denies — invoke it with `dangerouslyDisableSandbox: true` (same reason the rename append needs it). `--dry-run` only reads and runs sandboxed.

Then tell the user to reload the VSCode window (Command Palette → Developer: Reload Window); the fork reappears in the list and opens with full history.

Do not hand-roll detection. VSCode forks carry no `forkedFrom` field, so the tool links a fork to its source by shared record timestamps — the copy regenerates uuids but preserves timestamps. It only appends a `custom-title` record; it never rewrites existing lines.
