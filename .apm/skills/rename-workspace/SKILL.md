---
name: rename-workspace
description: Rename the current Paseo workspace.
---

Use the workspace name for the task or feature, while session names describe individual stages.

Accept `/rename-workspace <status> [feature]`, where status is `active`, `paused`, or `done`. Default to `active` when omitted. Feature is lowercase English kebab-case. When feature is omitted, preserve the feature already present after the workspace status emoji.

Run the bundled script from this skill's directory:

```bash
bun <skill-dir>/scripts/rename-workspace.ts --status <active|paused|done> [kebab-feature]
```

Run outside the project sandbox. The script maps the exact `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID` to its Paseo agent, renames that agent's workspace through `paseo workspace rename`, and prints the resulting `<status-emoji> <feature>` name.

Surface a non-zero stderr verbatim. Never choose a workspace by cwd or mutate `~/.paseo` JSON directly.
