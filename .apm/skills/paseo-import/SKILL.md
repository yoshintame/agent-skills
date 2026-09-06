---
name: paseo-import
description: Register the current Claude Code or Codex session as a Paseo agent.
---

Run the bundled script from inside the session you want in Paseo (`<skill-dir>` is this skill's base directory, shown at invocation — `~/.claude/skills/paseo-import` under Claude Code, `~/.agents/skills/paseo-import` under Codex):

```bash
bun <skill-dir>/scripts/import-current-session.ts
```

Under Codex, run it with escalated permissions (outside the sandbox). Codex's `workspace-write` sandbox sets `network_access = false`, and `paseo` reaches its daemon over `127.0.0.1:6767`; a sandboxed run fails with `Transport closed (1006)`. The daemon is already up, so this is a network-access problem, not `paseo daemon start`.

The agent appears in Paseo at once (`paseo ls` and the GUI). The script reads the live session id from `CLAUDE_CODE_SESSION_ID` or `CODEX_SESSION_ID`, sets `--provider` to match, passes the current directory as `--cwd`, and calls `paseo import`.

The script exists because a raw `paseo import <id>` is wrong two ways: without `--cwd` it silently registers the agent at the CLI's own directory, not the session's; and the correct provider/id pair lives only in those env vars, not anywhere `paseo` can read.

- `--dry-run` prints the composed command and runs nothing.
- Extra args are forwarded to `paseo import`, e.g. `--label key=value`.
- A non-zero exit is paseo's own error verbatim (daemon down, id already imported). Relay it, don't retry blind.
- `already has an active writer` under Codex is handled for you: the script spawns a detached helper that imports once the thread's writer lock frees, logging to `/tmp/paseo-import/<thread-id>.log`. A dedicated `codex resume` holder is terminated (this session ends); a shared app-server is left alone — close the session yourself and the helper imports on release.
