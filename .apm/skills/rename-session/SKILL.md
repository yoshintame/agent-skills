---
name: rename-session
description: Rename the current AI coding session.
---

Infer one name from the work actually done, then let the bundled script validate and write it. Never edit Claude JSONL or Codex storage directly.

## Format

`<status-emoji> <type>/<slug>`

- Status is `active` → `🔴`, `paused` → `🟡`, or `done` → `🟢`. Use an explicit user argument; otherwise default to `active` and infer `done` only from a clear closing signal.
- Type is required. This table is the human-facing projection of `SESSION_TYPE_SIGNATURES` in `scripts/append-custom-title.ts`; the script is authoritative.
- Slug is 2–5 lowercase English kebab words describing this session's work.

| Type | Observable signature |
| --- | --- |
| `impl` | implemented a change |
| `fix` | repaired broken behavior |
| `groom` | analyzed and designed work before implementation |
| `research` | discovered external tools, market options, or established practice |
| `investigate` | diagnosed a cause inside the system |
| `extract` | recorded conclusions from work already completed |
| `review` | reviewed quality without making changes |
| `ops` | ran production, deployment, backup, or data migration operations |
| `analytics` | queried data for an answer without mutations |
| `config` | configured the local environment or tooling |
| `ask` | answered a one-off question or explanation |

Use the operation, not the artifact, as the discriminator. Documentation is not a type. Refactoring and test-writing are `impl`; a diagnostic test run is `investigate`. External discovery is `research`; diagnosis inside the user's system is `investigate`.

## Rename

Derive a lowercase kebab feature for the workspace-level task, distinct from the session-stage slug. Run the bundled script from this skill's directory (`<skill-dir>` is the directory containing this file):

```bash
bun <skill-dir>/scripts/append-custom-title.ts --status <active|paused|done> --feature <kebab-feature> "<type>/<kebab-slug>"
```

Run outside the project sandbox. The script selects exactly one backend from `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID`, writes the provider name, then best-effort updates a matching Paseo agent and seeds its workspace only when the workspace title is empty. Paseo absence or failure does not undo a provider rename.

Echo the script's stdout. If it exits non-zero, surface stderr verbatim and do not retry with a mutated name unless the user asks.

`--status done` first runs the uncommitted gate (`session-status.ts --uncommitted`) and refuses with its `Blocking` list while a change this session made stays uncommitted. Pass `--leave <abs-path>=<reason>` (repeatable; `stash:<hash>=<reason>` for a stash) only for items `/done` already decided to leave; each is echoed as `left uncommitted:`. On refusal, go back to the gate step of `/done` — never add `--leave` just to get past it.

## Boundaries

Pass no emoji in the positional name; the script owns status mapping. The type is mandatory and restricted to the table. Once a baseline name exists, change its slug only on an explicit request. Existing legacy names are not migrated.
