---
name: delete-session
description: Permanently delete one Claude Code or Codex session and its Paseo agent.
---

Run the bundled script from this skill's directory:

```bash
bun <skill-dir>/scripts/delete-session.ts [<session-uuid>] [--provider claude|codex] [--dry-run] [--archive-workspace]
```

Omit the UUID to target the invoking session. For an explicit UUID, pass `--provider` if both providers contain it. Add `--archive-workspace` only when the user also wants the linked Paseo workspace removed from the active list. Paseo exposes workspace archive, not hard deletion. This option refuses a workspace containing other Paseo agents. An owned Paseo worktree may be removed during archive. Run `--dry-run` first, check the provider, UUID, agent IDs, workspace ID, and worktree path, then run the same command without `--dry-run`. The request to delete authorizes that second call; do not ask again.

Run the deletion call outside the Codex sandbox: it writes provider session state and Paseo needs its local daemon connection. Without `--archive-workspace`, the workspace and repository stay in place. Claude's shared `history.jsonl` remains. Codex's native deletion can also remove descendant threads.

When deleting the invoking session, the script schedules deletion after this turn and cancels if a new turn starts. Report the scheduled deletion and finish the response. For an explicit other session, report the script's result, including partial failures. An active other Claude session must be closed first. Do not substitute `claude rm`: it targets background agents, not a general Claude Code conversation.
