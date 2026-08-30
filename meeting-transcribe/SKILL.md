---
name: meeting-transcribe
description: Transcribe a meeting recording into the vault.
---

Never hand-roll transcription — no direct Deepgram/curl, no ad-hoc whisper. The vault has a pipeline: `$OBSIDIAN_VAULT/_scripts/meeting-import.ts` (Deepgram transcription → speaker-id → AI summary, written into vault note format). Drive it; don't replace it.

Vault root: `$OBSIDIAN_VAULT`, fallback `~/Documents/obsidian/yoshintame`.

Argument: one or more recording file paths (usually in `~/Downloads`). One recording per meeting; the import uses the first media file it finds.

## Steps

1. **Find the meeting note.** The stub is created by `_scripts/meeting-note.ts create` (run at meeting start: `status: scheduled`, empty body, slug `meeting-<date>-<HHMM>`), so it usually already exists under `events/meetings/<slug>/` — match the recording to it by date/time. If missing, create it (no `.env` needed, any cwd):

   ```sh
   bun "$OBSIDIAN_VAULT/_scripts/meeting-note.ts" create --type ad-hoc
   ```

   It prints the path and stamps the current time; for an older recording, fix the folder name and `date:` to match.

2. **Fill the stub frontmatter** — only what a human knows: `title`, and `attendees` as `"[[person-slug]]"` for everyone who was actually in the room, the vault owner included: Михаил is `[[mikhail]]`, an ordinary person note like any other. Attendance is a per-meeting fact — he is on most Senate calls and off many VTB ones — so read it off the recording's participant list, never assume it either way. Omitting someone costs speaker identification: the pipeline can only put names to voices it was given, and anyone left out stays `Speaker N` in the transcript. Each slug must resolve to `persons/<slug>.md` or the import aborts — create the missing person note first (skill `obsidian-vault`). Optional: `parent: "[[org]]"`, `language:`.

3. **Copy the recording into the folder**, named after the slug. The import picks the first file with extension `mp4 mkv webm mov m4a mp3 wav` — the name is free, but `<slug>.<ext>` is what the archive will hold, so use it from the start and skip a rename later:

   ```sh
   cp "<recording>" "$OBSIDIAN_VAULT/events/meetings/<slug>/<slug>.mp4"
   ```

   The copy is transient: it lives in the vault only while the import reads it.

4. **Run the import.** Do not `cd` into `_scripts` — `--cwd` makes bun load `_scripts/.env` (the `DEEPGRAM_API_KEY`) while you stay put:

   ```sh
   bun --cwd="$OBSIDIAN_VAULT/_scripts" "$OBSIDIAN_VAULT/_scripts/meeting-import.ts" "$OBSIDIAN_VAULT/events/meetings/<slug>"
   ```

   Run it in the background — a 45-minute recording takes ~8 minutes end to end and a foreground call dies on the tool timeout. Transcription is only cached when `MP_CACHE_DIR` is set, so a run killed midway bills Deepgram again on retry.

   The AI summary runs through the `claude-code` provider (Claude Max subscription, $0, no key). Never add `ANTHROPIC_API_KEY` to `_scripts/.env` — it trips the subscription guard.

5. **Archive the recording.** Raw media does not live in the vault — move it out once the import has read it:

   ```sh
   mv "$OBSIDIAN_VAULT/events/meetings/<slug>/<slug>.mp4" ~/Video/meetings/
   ```

   `~/Video` is outside iCloud and is covered by the restic `home` profile. Leaving the file in the vault re-creates the problem the archive exists to solve — see `[[meeting-recordings-inflate-vault]]`.

## Output

The run writes three files:

- `events/meetings/<slug>/<slug>.md` — stub filled with body, `duration`, `status: completed`, tags
- `meeting-transcripts/<slug>-summary.md` — summary, decisions, action items, topic timeline
- `meeting-transcripts/<slug>-transcript.md`

Check the `speaker-id.done` line before committing: `identified` below `total` means leftover `Speaker N` labels in the transcript. Usually diarization split one person into two clusters (a mid-call audio-device change does it). Work out the mapping from the transcript, confirm it with the user, and relabel — plain byte-level `perl -pi -e`, no `-CSD`, which double-encodes Cyrillic.

Commit only those three. The recording never reaches the index: `*.mp4` and `*.m4a` are gitignored, and step 5 takes it out of the vault entirely. If the recording is another format, leave it unstaged rather than `git add -f`.
