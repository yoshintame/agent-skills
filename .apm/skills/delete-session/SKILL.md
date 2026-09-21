---
name: delete-session
description: Permanently delete one Claude Code or Codex session and its Paseo agent.
---

Run the bundled script from this skill's directory:

```bash
bun <skill-dir>/scripts/delete-session.ts [<session-uuid>] [--provider claude|codex] [--dry-run]
```

Omit the UUID to target the invoking session. For an explicit UUID, pass `--provider` if both providers contain it. Run `--dry-run` first, check the resolved provider, UUID, and Paseo agent IDs, then run the same command without `--dry-run`. The request to delete authorizes that second call; do not ask again.

Run the deletion call outside the Codex sandbox: it writes provider session state and Paseo needs its local daemon connection. The script leaves the workspace and repository in place. Claude's shared `history.jsonl` remains. Codex's native deletion can also remove descendant threads.

When deleting the invoking session, the script schedules deletion after this turn and cancels if a new turn starts. Report the scheduled deletion and finish the response. For an explicit other session, report the script's result, including partial failures. An active other Claude session must be closed first. Do not substitute `claude rm`: it targets background agents, not a general Claude Code conversation.
