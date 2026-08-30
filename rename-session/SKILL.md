---
name: rename-session
description: Rename the current Claude Code session to a short, human-readable label following the `<status-emoji> [<prefix>/]<kebab-title>` convention. Atomically appends a `custom-title` event to the session's JSONL. Use when the user types `/rename-session`, `/rename-session done|paused|active`, or says "переименуй сессию", "rename this session", "name this session", "дай имя сессии".
---

# /rename-session

In-session AI rename. **You (the agent) decide the name from session context. The bundled script handles status→emoji mapping, validation, and the atomic JSONL append.** You never write the JSONL yourself, never apply regexes — that boundary is strict.

Design reference: `$OBSIDIAN_VAULT/projects/ai-session-management/session-rename-skill.md`

## Naming convention

```
<status-emoji> [<prefix>/]<kebab-title>
```

- **status-emoji** — `🔴` active / `🟡` paused / `🟢` done. Default `active`. You pass this via `--status`; the script renders the emoji.
- **prefix** *(optional, one segment)* — either a scope (`sesher`, `dotfiles`, `vault`, `homelab`, `research`, ...) **or** a type (`impl`, `research`, `groom`, `plan`, `analytics`, `fix`, `refactor`). Pick whichever groups the session more strongly. Not both.
- **kebab-title** — 2–5 lowercase kebab-case English words. Capture the essence.

Target length ≤ 50 visible chars. Hard ceiling 80 (script enforces).

Examples: `🔴 sesher/impl-rename-skill`, `🟡 dotfiles/secret-strategies`, `🟢 vault/groom-ai-session-mgmt`, `🔴 fix-cc-notification-hooks`.

## Steps

1. **Pick the status.**
   - If the user passed one after the command (`done`, `paused`, `active`) — use it.
   - Otherwise infer from context (default `active`; switch to `done` only when the session has a clear closing signal — final commit landed, user said "готово"/"done", everything wrapped).

2. **Compose `[<prefix>/]<kebab-title>` from session context.**
   - Skim what the session actually did — files touched, project, intent.
   - Pick one prefix slot if there's an obvious group (project scope or work type). Skip the prefix when the title alone is clear.
   - 2–5 kebab words, lowercase, English only, only `[a-z0-9-]`.

3. **Invoke the script.** It maps status to emoji, validates, and atomically appends:

   ```bash
   bun ~/.claude/skills/rename-session/scripts/append-custom-title.ts --status <active|paused|done> "<[prefix/]kebab-title>"
   ```

   Pass the **kebab title without the emoji** — the script prepends it. The script prints the final composed name (e.g. `🟢 vault/groom-ai-session-mgmt`) to stdout.

   Run the command with the Bash sandbox disabled (`dangerouslyDisableSandbox: true`) from the start: the append target `~/.claude/projects/**` sits in the sandbox's built-in write-deny, so a sandboxed attempt always dies with EPERM. `Bash(bun *)` is in the permission allowlist — the unsandboxed call goes through without a prompt.

4. **Echo the script's output to the user** as a single line, so they immediately see the new name and can re-run `/rename-session` if it doesn't fit.

## Rules

- Never construct the JSONL line, never call `Write`/`Edit` on a `.jsonl`, never include the emoji in the positional argument. The script owns all of that.
- If the script exits non-zero, surface the stderr message verbatim — don't try to "fix" the name by retrying with a mutated title unless the user asks. The error messages are specific (invalid chars, missing session, etc.).
- Don't auto-rerun on every prompt. After a baseline name exists, only rename on an explicit user request.

## Script reference

`scripts/append-custom-title.ts` — TypeScript on bun, zero shell ops (pure `node:fs` + JSON), no third-party deps. `dax-sh` was considered per the project's anti-bash policy but skipped: this script doesn't shell out, so adding it would be dead weight.

Behavior:

- Discovers the session JSONL via `CLAUDE_CODE_SESSION_ID` env (primary) → `~/.claude/projects/<cwd-hash>/<sid>.jsonl`, falling back to a scan across project dirs if cwd-hash misses (worktrees). If the env var is absent, picks the most recently modified `*.jsonl` in the cwd-hash dir.
- Maps `--status` to `🔴|🟡|🟢`, composes `<emoji> [prefix/]title`, validates against `^(🔴|🟡|🟢) ([a-z0-9-]+/)?[a-z0-9-]+$` and `≤ 80` visible chars.
- Atomic `O_APPEND` write of `{"type":"custom-title","sessionId":"...","customTitle":"..."}` + newline. Single sub-PIPE_BUF write — no advisory lock needed (last entry wins on concurrent renames, same semantics as native CC `/rename`).
- Prints the final composed name to stdout. Errors go to stderr with `rename-session:` prefix and exit 1.

## Known limitation

Native CC UI reads only the last 64 KB of the JSONL. On long sessions the `custom-title` event is evicted and the default `aiTitle` reappears. Out of scope for this skill — see `session-rename-skill.md` § "64KB keepalive".
