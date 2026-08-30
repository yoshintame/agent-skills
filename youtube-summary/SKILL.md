---
name: youtube-summary
description: Fetch a YouTube video's transcript and save a summary as a video note in the Obsidian vault. Use when the user shares a YouTube link and wants the gist without watching, asks to summarize a video, or types /youtube-summary.
---

# YouTube Summary

Turn a YouTube video into a `video`-type note in the vault, summarized from its
transcript — for videos the user wants the information from but does not want to
watch.

## Steps

1. Take the YouTube URL or ID from the user's message (or skill argument).

2. Fetch the transcript and metadata:

   ```bash
   "$HOME/.claude/skills/youtube-summary/scripts/yt-transcript" "<url>" --json
   ```

   The script prints a JSON object: `title`, `channel`, `url`, `thumbnail`,
   `duration_minutes`, `published`, `subtitle_lang`, `subtitle_kind`,
   `transcript`.

   - Exit code 2 means no `en`/`ru` subtitles exist. Tell the user and offer to
     retry with `--langs <code>` for another language.
   - If `subtitle_kind` is `auto-generated`, the transcript has no punctuation
     and minor word repetition — that is expected, summarize through it.

3. Read the `transcript`. Write, in Russian:
   - a **Summary**: 2–4 paragraphs covering what the video argues or explains
     and the concrete takeaways — not "the video discusses X" filler;
   - **Highlights**: 3–7 bullet points with the specific claims, facts, numbers
     or steps worth remembering.

4. Decide the note path. The note lives at `videos/<slug>.md` where `<slug>` is
   the title lowercased, ASCII-only, non-alphanumerics collapsed to single `-`.
   If a note for this video already exists (same `url` in any vault note),
   update its `## Summary` and `## Highlights` sections instead of creating a
   duplicate.

5. Create the note with this exact shape (it matches `_types/video.type` and
   the `Videos` base):

   ```md
   ---
   type: video
   title: "<title>"
   url: <url>
   channel: "<channel>"
   duration: <duration_minutes>
   published: <published>
   rating:
   cover: <thumbnail>
   status: inbox
   parent:
   linked:
   tags:
   ---

   ![](<thumbnail>)

   ## Summary

   <Russian summary>

   ## Highlights

   - <point>

   ## Notes
   ```

6. Report back: the note path as a clickable link, plus a 2–3 sentence verdict
   on whether the video is worth the user's time given what they were after.

## Rules

- Always get the transcript via the bundled `yt-transcript` script — never
  scrape YouTube by hand or guess the content from the title.
- The summary is built only from the transcript; do not invent facts.
- Do not run web research as part of this skill. If the user wants the topic
  expanded beyond the video, point them to `/deep-research`.
- Leave `rating`, `parent`, `linked`, `tags` empty for the user to fill.
