---
name: paseo-import
description: Register the current Claude Code or Codex session as a Paseo agent.
---

Run the bundled script from inside the session you want in Paseo (`<skill-dir>` is this skill's base directory, shown at invocation — `~/.claude/skills/paseo-import` under Claude Code, `~/.codex/skills/paseo-import` under Codex):

```bash
bun <skill-dir>/scripts/import-current-session.ts
```

The agent appears in Paseo at once (`paseo ls` and the GUI). The script reads the live session id from `CLAUDE_CODE_SESSION_ID` or `CODEX_SESSION_ID`, sets `--provider` to match, passes the current directory as `--cwd`, and calls `paseo import`.

The script exists because a raw `paseo import <id>` is wrong two ways: without `--cwd` it silently registers the agent at the CLI's own directory, not the session's; and the correct provider/id pair lives only in those env vars, not anywhere `paseo` can read.

- `--dry-run` prints the composed command and runs nothing.
- Extra args are forwarded to `paseo import`, e.g. `--label key=value`.
- A non-zero exit is paseo's own error verbatim — daemon down, id already imported, or `already has an active writer` (the session is still held open elsewhere; release it there first). Relay it, don't retry blind.
