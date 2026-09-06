---
name: fetch-reddit
description: Fetch Reddit post content and comments. Use when the user shares a reddit.com link or asks to read a Reddit post or thread.
---

# Fetch Reddit

Fetch Reddit posts and comments via an anonymous Reddit Android-app OAuth token
(`oauth.reddit.com`), with an RSS fallback. No app, credentials, or API key needed.

## Usage

Run the bundled script with the Reddit URL:

```bash
if [ -x "$HOME/.agents/skills/fetch-reddit/scripts/fetch-reddit.py" ]; then
  python3 "$HOME/.agents/skills/fetch-reddit/scripts/fetch-reddit.py" "<reddit-url>"
else
  python3 "$HOME/.claude/skills/fetch-reddit/scripts/fetch-reddit.py" "<reddit-url>"
fi
```

Present the output in a readable format.

## Rules

- Always use this script, do not fetch Reddit via raw web search or curl
- Works on any reddit.com thread URL; the script picks the transport (Android-token OAuth → RSS) itself
- Comments come with scores via OAuth; on the RSS fallback the output is flat and score-less (noted inline)
