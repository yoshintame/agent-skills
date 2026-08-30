---
name: create-skill
description: Write or revise a Claude Code skill.
---

# create-skill

A skill is a diff: the gap between what the agent does by default and what you
need. Everything outside that diff is dead weight. The body loads whole when the
skill triggers and crowds the real instruction out of the attention window, and
the model mirrors the register of its instructions, so a padded skill yields
padded output. Write the diff and nothing else.

## 1. Baseline before you write

Run the target task on the agent **without** any skill.

- If it already does the task right, don't write the skill. It would only repeat
  what the model already knows.
- If it fails, the skill is exactly that failure, with no hypothetical extras.

Keep the test case **outside** the skill folder; it goes stale fast and most
skills won't have a clean one. With no reproducible case, judge one live run by eye.

## 2. What goes in the body (gap filter)

Read each line and ask: if I cut this, is the agent still right by default?

- Yes, still right: cut the line. It repeats the training corpus.
- No, now wrong: keep it. It encodes a real gap, a project or team convention
  that doesn't follow from the library's own idiom.

Quote the API exactly (`Config.redacted('KEY')`) rather than describing it in
words. One correct example per rule, not three that are right in different ways.
A skill that reads like a tutorial is wrong; one that reads like a patch to
default behavior is right.

## 3. What becomes a script

Before writing an algorithm in prose ("group by X, classify each Y"), ask whether
code can compute it once for every run. Parsing, grouping, classification, and
per-file `git diff` are deterministic and repeatable, so they belong in `scripts/`
(bun), and the body keeps only how to read the result.

- Simple glue (one call, no branching): write it in `scripts/` now.
- Complex domain script (parses a format, hits git or an API, has edge cases):
  delegate. Don't write it here. Hand off a short spec (purpose, run command,
  input, exact output, edge cases, done-when) plus an init-prompt, and let a fresh
  session build it in the normal dev flow.
- Anti-slop is already shared at `~/.claude/skills/create-skill/scripts/slop-lint.ts`.
  Point new skills at that path; don't copy the linter into each one.

## 4. Density

Run the linter on the draft:

```
bun ~/.claude/skills/create-skill/scripts/slop-lint.ts SKILL.md
```

Fix every tell. Rewrite the line from source instead of paraphrasing, because a
paraphrase keeps the same cadence. The goal is signal density, not human-sounding
prose: em-dashes, a dry register, and missing contractions are fine and left alone.

## 5. description

Skills are invoked by name — you or the agent runs `/skill`, not a pattern-match
on what the user typed. Auto-triggering off the `description` is a rare exception,
not the default; assume it does not happen. So the `description` does no triggering
work: never list trigger phrases or `Use when …` / `Use on …` clauses, no workflow
summary, no output-section names. The description sits in every session's system
prompt, and one that lists triggers or sketches a plan gets the agent acting from
it and skipping the body. One bare clause for the autocomplete UI, nothing more.
The schema rejects an empty string, so minimize rather than delete.

```
Bad:  Summarize a PDF — pull title, sections, key quotes, and a TL;DR. Use when the user shares a PDF.
Good: Summarize a PDF.
```

Avoid `disable-model-invocation: true` on a /-invokable skill. Docs frame it as
just blocking auto-invocation, but in practice the flag also hides the skill from
the listing the model uses to resolve slash commands — typing `/skill` then
injects the text but the model can't link it to the skill and improvises an
ad-hoc version (the `/` UI dropdown still shows it, masking the breakage). The
bare-description rule above already prevents trigger-style behavior; the flag
adds slash breakage on top with no upside for a normal slash-invoked skill.

Invocation already happened by the time the body runs, so the body never
re-explains what the skill is or when to use it — open with the first instruction,
not a preamble.

## 6. Layout

- Frontmatter holds only `name` and `description`.
- SKILL.md stays under 500 lines. Push depth into `references/` one level deep and
  link to it; don't inline it.
- Folders: `scripts/` for code, `references/` for deep docs, `assets/` for templates.
- Keep the skill self-contained: link only to its own bundled files. No
  `[[wiki-links]]` to your vault, no pointers to docs in another repo — the skill
  is shared and versioned apart from them, and may run where neither exists.

## Done when

- The linter reports no tells.
- Re-running the task **with** the skill changed the behavior; check it against the
  reference by eye if one exists.
- The file passes its own linter and reads as a patch to default behavior, not a tutorial.
