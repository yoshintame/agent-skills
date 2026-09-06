# agent-skills

Personal cross-provider skill package (Claude Code, Codex, Cursor), distributed
by APM. Source of truth is `.apm/skills/<name>/`. The trees under
`.claude/skills`, `.agents/skills`, `.cursor/skills` and `apm_modules` are
generated copies — never edit them.

## Before creating or changing any skill — mandatory

Invoke `/skill-dev` (via the Skill tool) and follow it. It owns editing the
canonical source, authoring content through `/create-skill`, and testing the
change as a global `dev-<name>` copy. This is required: the default agent habit
of editing a materialized copy, or installing the package globally to try a
change, corrupts this repo's source-of-truth and global state.
