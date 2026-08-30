---
name: handoff-create-independent-deep-research
description: Create a handoff for an independent /deep-research session.
---

## Core principle

**Anything in must-read is an anchor.** Independence is not "hide one file" — it is "do not pass conclusions at all". If the next session could derive the current tool stack by reading every must-read'd file, the handoff is broken by construction, regardless of scope-guards.

The load-bearing test before writing: *if the receiving session read every referenced file, could it reconstruct the current architecture and its named tools?* If yes → strip references, inline only what tasks require.

## Delegation

All mechanics — script call, file path, frontmatter, reply format — delegate to `/handoff-create`. This skill only constrains the **body** of the handoff.

## Body structure

Five sections in order. These rules override the defaults in `/handoff-create`.

### 1. Tasks (inline, never by reference)

Extract task formulations INLINE in the handoff body. Never reference a file that describes the tasks — every such file also carries conclusions, and those conclusions are the answer key.

One sentence per task, describing the OUTCOME only. No mention of tools, storage layouts, intermediate artifacts, or methods.

- ❌ "Экспорт чеков в `.eml` через notmuch-запрос и batch-обработку".
- ✅ "Экспорт чеков в структурированные записи (дата, магазин, модель, цена, серийник)".

### 2. Hard external constraints

Only genuinely non-negotiable properties:
- Privacy posture ("local-first", "content not to third-party clouds").
- Platform (OS, package managers).
- User-facing behavioral requirements ("agent never deletes without human confirmation").

NOT: preferred technologies, existing tool commitments, "already tried" lists. Those are anchors dressed as requirements.

### 3. Adjacent projects — mutable, one line each

Each adjacent project referenced as ONE line with explicit mutable status. Never as `[[link]]` in must-read.

```
- [[project-slug]] — <status: not started | drafted | implemented>, <current leaning if any>.
  Reconsiderable if independent findings prove otherwise.
```

The framing must make it explicit that the adjacent decision is up for reconsideration. If findings suggest a unified tool closing both this project and the adjacent one — that is a MAIN finding, not a footnote.

### 4. Task

- **Explicit "independent"** framing. Do NOT use "second opinion", "validation", "verify" — those imply the answer is known.
- Output to a NEW file with `-independent` suffix (or similar unambiguous marker). Never overwrite existing research.
- **If findings conflict with existing project docs → surface in TL;DR, not in "open questions".**

### 5. Scope-guards

Hard don'ts only:
- Do NOT read the target project's own `spec/`, plan docs, or research files. These almost always contain the answer key.
- Do NOT read adjacent-project docs that discuss tool landscape.
- All candidates via web-search / GitHub / community signal — no reliance on "background knowledge".

Do NOT put guards like "don't reconsider decision X" — that IS the anchor, disguised as a guard.

## Self-check before finalizing

Grep the body for:
- Tool names, library names, product names, framework names, cloud service names.
- Language: "already decided", "фиксированные", "не переоценивать", "не пересматривать", "выбран", "committed", "final".

Any hit → remove or rephrase. Prior decisions exist for the next session to CHALLENGE, not to VALIDATE.

## Anti-patterns (from real failures)

- Putting the project's main note in must-read "for context on tasks" — the main note is the anchor. Inline the tasks instead.
- Referencing `[[adjacent-project]]` in must-read — use the mutable-status line in section 3 instead.
- Scope-guard like "X, Y, Z — фиксированные commit'ы, не пересматривать" — this is an answer key disguised as a guard. If truly non-negotiable, restate as a hard external constraint (rare); otherwise strip.
- Multiple must-read files with overlapping content — even if one is scope-guarded, siblings leak the same information. Independence is a property of the whole read-set, not any single file.
- Framing as "second opinion" or "validation" — implies known answer, biases the receiving session toward confirmation.
- "Guarded" file that mentions the same tools by name in adjacent context (`prior finding leaked into commit history, changelog, or unrelated note`) — grep the whole target dir before finalizing.
