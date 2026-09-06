---
name: skill-dev
description: Test a change to an APM-managed skill through a global dev copy.
---

Every skill in this producer lives in `.apm/skills/<name>/`. The copies under
`.claude/skills`, `.agents/skills`, `.cursor/skills` and `apm_modules` are
generated output — edit the source, never them.

Author or revise the content with `/create-skill` first: it owns the behavioral
gap, density, and the skill's own quality gates.

To exercise the change with real project context — `/dev-<name>` sitting beside
the production skill in every project, for both Claude and Codex — run from the
producer root:

```
bun scripts/skill-dev.ts <name>            # materialize or resync global dev-<name>
bun scripts/skill-dev.ts <name> --remove   # drop it
bun scripts/skill-dev.ts --list            # what is materialized now
```

It copies the source to `~/.claude/skills/dev-<name>` and
`~/.agents/skills/dev-<name>`, rewriting the frontmatter `name` and
self-referential `skills/<name>/` paths, and touches neither the production skill
nor the APM manifest and lock. Re-run after each source edit to resync. The copy
is a snapshot, not a live link, so a removed worktree leaves it behind until you
`--remove` it.

Shipping the change to the real global skill is the normal APM release — tag the
producer, then promote the global consumer through `mise run dot:apm` — and is
outside this skill.
