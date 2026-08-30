---
name: analyze-permissions
description: Analyze Claude Code permission request logs and optimize the allow list. Cleans up hardcoded one-off entries, finds redundant rules, and adds missing safe patterns. Use when the user wants to review or fix permission settings.
---

# Analyze Permissions

Analyze the permission request log and optimize the allow list in `settings.json`.

## Usage

Run the bundled analysis script:

```bash
python3 ~/.claude/skills/analyze-permissions/scripts/analyze-permissions.py
```

Present the output to the user. Highlight the most impactful findings:
- How many redundant/hardcoded entries will be removed
- Which safe tools are missing from the allow list (Edit, Write, Glob, Grep)
- Any review items that need the user's decision

## With `--apply`

If the user passes `--apply` (or says "apply", "fix", "clean up"):

```bash
python3 ~/.claude/skills/analyze-permissions/scripts/analyze-permissions.py --apply
```

After the script runs, show a summary of what changed (removed, added, log marked as processed).

## Rules

- Always run WITHOUT `--apply` first to show the report
- Only run with `--apply` after the user confirms or explicitly asks to apply
- If there are "review" items (ssh, python3, new domains), ask the user whether to add them manually
- For review items the user approves, edit `~/.dotfiles/modules/claude/config/settings.json` directly to add the rules
- Never add rules from the "dangerous" category
- The script creates a backup before modifying settings — mention the backup path
