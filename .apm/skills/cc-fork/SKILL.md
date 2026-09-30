---
name: cc-fork
description: Lossless fork of the current session from a specific message.
---

The user's argument is the pasted text of the message they want to fork from. The fork includes that message and everything before it.

Run `cc-fork` with `dangerouslyDisableSandbox: true` — writes to `~/.claude/projects/` which the sandbox denies:

```bash
cc-fork "$CLAUDE_CODE_SESSION_ID" --match-text "<user's pasted text>" -t "<current session title> (fork)"
```

Read the current title from the JSONL `custom-title` entry, or fall back to asking the user.

No-match fallback: `cc-fork` uses fzf for interactive picking, which won't work here. Parse the JSONL yourself to list user messages with their UUIDs, let the user pick, then pass `-m <uuid>` instead of `--match-text`.

Unset `$CLAUDE_CODE_SESSION_ID` means the session runs outside the Claude Code SDK process — ask the user for the session ID.

Paseo import failure is non-fatal; `cc-fork` still prints the forked session ID on stdout.

## Workspace targeting

`paseo import` has no `--workspace` flag — it auto-resolves by cwd. When multiple workspaces share the same cwd, the fork may land in the wrong one. After import, check `$PASEO_WORKSPACE_ID` (set in workspace terminals) or ask the user for the target workspace name, then find its ID via `paseo workspace ls --json`. If the agent landed in the wrong workspace, tell the user — Paseo has no agent-move API, so they must delete the misplaced agent and manually re-import from the Paseo UI where workspace context is available.

After reporting the result, tell the user to rewind this session in Paseo ("Rewind to this message" on their last pre-fork message) to remove the fork operation from the original.
