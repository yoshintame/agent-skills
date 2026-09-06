---
name: vscode-marketplace
description: Search VS Code Marketplace or get details for specific extensions. Use when researching, recommending, or comparing VS Code extensions. Pass a search query for full-text search, or exact extension IDs such as publisher.name for detail lookup.
argument-hint: <search query | publisher.ext [publisher.ext ...]>
---

Run:

```bash
if [ -x "$HOME/.agents/skills/vscode-marketplace/vscode-marketplace.py" ]; then
  python3 "$HOME/.agents/skills/vscode-marketplace/vscode-marketplace.py" $ARGUMENTS
else
  python3 "$HOME/.claude/skills/vscode-marketplace/vscode-marketplace.py" $ARGUMENTS
fi
```

Present the output as a markdown table.
