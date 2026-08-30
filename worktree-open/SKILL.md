---
name: worktree-open
description: Link the current worktree session into main and open it in VSCode.
---

# /worktree-open

Run from a session whose cwd is a git worktree. One command does both steps:

```
bun ~/.claude/skills/worktree-open/scripts/link-and-open.ts
```

It hardlinks the current session (`$CLAUDE_CODE_SESSION_ID`, found anywhere via
the linker's scan-fallback) into **this worktree's** project folder via
`link-session-jsonl` — so the session shows in the worktree window's native
picker — then opens VSCode on the worktree with `open -a "Visual Studio Code"`
(`code` is unusable: it needs `VSCODE_IPC_HOOK_CLI`, absent in the hook env;
`open` is allowed unsandboxed via the `bun *link-and-open.ts` exclusion). Idempotent.

Relay the script's `worktree-open:` summary lines verbatim. If it prints
`cwd is the main checkout`, you are not in a worktree and nothing was linked.
