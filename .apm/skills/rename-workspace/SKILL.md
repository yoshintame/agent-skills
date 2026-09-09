---
name: rename-workspace
description: Rename the current Paseo workspace.
---

Use the workspace name for the task or feature, while session names describe individual stages. The workspace splits two axes: the title holds only the feature, and task status (`active`/`paused`/`done`) is a colored Paseo workspace label — not an emoji in the title.

Accept `/rename-workspace <status> [feature]`, where status is `active`, `paused`, or `done`. Default to `active` when omitted. Feature is lowercase English kebab-case. When feature is omitted, preserve the feature already present in the workspace title.

Run the bundled script from this skill's directory:

```bash
bun <skill-dir>/scripts/rename-workspace.ts --status <active|paused|done> [kebab-feature]
```

Run outside the project sandbox. The script maps the exact `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID` to its Paseo agent, renames that agent's workspace title to the bare feature through `paseo workspace rename`, then sets the matching status label over the Paseo daemon WebSocket — creating it on first use and clearing the other two, so a workspace holds one status at a time. It prints the resulting `<feature> [<status>]`.

The status label is best-effort: if the daemon is unreachable it is skipped and the output says so, while the title rename still applies. Surface a non-zero stderr verbatim. Never choose a workspace by cwd or mutate `~/.paseo` JSON directly.
