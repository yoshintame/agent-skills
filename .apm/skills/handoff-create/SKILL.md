---
name: handoff-create
description: Create a handoff / init-prompt file for the next session from the current session's context.
---

## Input

One argument: a short description of what the next session does. If none is given, ask — never guess.

## Run the script — it owns the file

Derive a short ascii kebab-slug from the description, then:

```
bun ~/.agents/skills/handoff-create/scripts/handoff-create.ts <slug>
```

Run the command outside the project sandbox: the shared mutable store under `~/.agents/handoffs` requires host write access.

The script writes `~/.agents/handoffs/<cwd>/<slug>.md` with the frontmatter (`status: open`, provider-qualified `created_by`, `created_at`) and a `<!-- handoff body -->` placeholder. Stdout is two lines:

- line 1: absolute path to the new file
- line 2: the pickup command for the next session, with path already substituted

Read the file, then `Edit` to replace `<!-- handoff body -->` with the body content. Do NOT use `Write` and do NOT touch the frontmatter — the script owns it.

Reply (no body in chat):

1. inline clickable link to line 1's path
2. line 2 wrapped in a triple-backtick code block — so the chat UI renders a copy button on it

The file is an editable artifact: the user opens it, selects parts, asks for fixes — apply those with `Edit` on the file, do not regenerate.

## Skills referenced in arguments

If the description or arguments mention `/skill-name`, load each via Skill tool before writing the body — you need their conventions to write the handoff correctly. The next session will invoke these skills itself; your job is to reference them accurately (in Goal, Must-read, Conventions), not to execute them now.

## What goes in the file

From the live conversation, not the session JSONL. Include only blocks that apply, shortest first:

- **Goal** — `# Init: <one-line goal>`. If a stage skill was named, reference it here as `/skill-name`.
- **Context** — what's done, current state, what's merged.
- **Must-read first** — the load-bearing block: absolute file paths, `/skill` references, vault notes to load before acting.
- **Working tree** — repo, branch, worktree, uncommitted (code sessions only).
- **Task** — what to do, linking the plan doc by path.
- **Conventions** — only non-default ones (e.g. `/git-commit`, TDD).
- **Scope-guards** — only session-specific don'ts; stage guards live in the referenced skill.

## Rules

- Don't duplicate what already lives in a PRD, plan, ADR, issue, commit, or diff — reference it by absolute path or URL.
