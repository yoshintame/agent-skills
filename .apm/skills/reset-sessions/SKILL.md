---
name: reset-sessions
description: Kill Claude Code sessions except current.
---
Run the script and relay its summary verbatim:

```
bun ~/.claude/skills/reset-sessions/scripts/reset-sessions.ts
```

Kills all `claude` native-binary processes (VSCode extension sessions) except the current session's subtree, then kills orphaned children (MCP sidecars, shells). Output: sessions killed, MB freed, sessions remaining.

Flags: `--dry-run` — show targets without killing; `--all` — do not spare current (for out-of-session runs); `--self` — kill own session after end of turn (last step of `/done`, not for manual use: detaches a worker that waits for `end_turn` in the JSONL, re-checks title is 🟢, sends SIGTERM with escalation; 5 min cap; log `~/.local/state/cc-reaper/self.log`). In SDK/Paseo sessions (no native-binary ancestor) `--self` exits cleanly — no process to kill.

Killed sessions are not lost: transcripts persist in `~/.claude/projects/`, resumable via `Cmd+Shift+T` or Session history. Tabs respawn lazily — only on click or next message.

`session-reaper.ts` nearby is an idle-reaper on launchd (module `session-reaper`) that kills sessions idle beyond a threshold; manual: `bun ~/.claude/skills/reset-sessions/scripts/session-reaper.ts --dry-run`. Kill log for all surfaces: `~/.local/state/cc-reaper/kills.jsonl`.
