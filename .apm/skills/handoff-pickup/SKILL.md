---
name: handoff-pickup
description: Pick up an open handoff file in a new session — stamps consumed metadata and loads the body as context.
---

## Input

The absolute path to a handoff `.md` file (as produced by `/handoff-create`). Optional second token `force` to take a handoff other sessions already hold.

## Run the script

```
bun ~/.agents/skills/handoff-pickup/scripts/handoff-pickup.ts <absolute-path>
```

Run the command outside the project sandbox: handoffs under `~/.agents/handoffs` require host write access.

The script appends the current provider-qualified session reference to the file's `consumed_by` / `consumed_at` lists (inline YAML arrays), sets `status: consumed`, and prints the handoff body to stdout. Unqualified session IDs in legacy handoffs are Claude Code IDs. That body is your starting context — follow its must-read first, then carry out the task.

## Already picked up (exit 3)

When `consumed_by` already holds another session and no `force` was passed, the script writes nothing, prints those sessions with timestamps, and exits 3. A handoff already in progress elsewhere is usually one handed to you by mistake, so the exit-3 output is not context — do not start the task. Report who holds it and ask the user whether to take it anyway. Only after they say yes, re-run with `force`:

```
bun ~/.agents/skills/handoff-pickup/scripts/handoff-pickup.ts <absolute-path> force
```

Same session rerunning is a no-op (already in the list, prints the body, no exit 3). The creator picking up its own file is refused with exit 2 — a handoff is not for the session that wrote it.
