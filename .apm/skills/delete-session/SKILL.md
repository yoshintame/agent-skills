---
name: delete-session
description: Delete selected coding session and Paseo components.
---

Ask which components to remove before running the script. In Claude Code, use `AskUserQuestion` with one `multiSelect: true` question and these three options. In Codex, use the available structured user-input tool with three independent delete/keep questions in one form: put **Delete** first for the session and agent, **Keep** first for the workspace, and disable auto-resolution when supported. Use the user's language for labels and keep these meanings:

- **Claude Code/Codex session** → delete the provider conversation; Codex may also delete descendant threads.
- **Paseo agent** → permanently delete the matching Paseo agent.
- **Paseo workspace** → archive the linked workspace, its agents and terminals; Paseo may remove an owned worktree. Workspace archive is not permanent deletion.

Wait for the submitted answer; an asynchronous question tool returning immediately is not an answer. A cancelled or empty selection means no deletion. If a structured form tool is unavailable, ask the user to select components and wait; do not infer consent from the direct script's defaults. Pass the chosen components exactly as `session,agent,workspace` names, omitting unchosen names.

Run the bundled script from this skill's directory, first with `--dry-run` and then with the same selection without it:

```bash
bun <skill-dir>/scripts/delete-session.ts [<session-uuid>] [--provider claude|codex] --components <comma-separated-selection> [--dry-run]
```

Omit the UUID to target the invoking session. For an explicit UUID, pass `--provider` if both providers contain it. Check the dry-run's provider, UUID, selected operations, Paseo IDs, and worktree path. If it fails, stop without mutation. The submitted form authorizes the matching deletion call; do not ask again.

Run the deletion call outside the Codex sandbox: it writes provider session state and Paseo needs its local daemon connection. The script's direct CLI default remains `session,agent`; `--archive-workspace` is the legacy shortcut for all three. Claude's shared `history.jsonl` remains.

When operating on the invoking session, the script schedules the selected operations after this turn and cancels if a new turn starts. Report the scheduled operation and finish the response. For another session, report the result, including partial failures. Do not substitute `claude rm`: it targets background agents, not a general Claude Code conversation.
