#!/usr/bin/env bun
// Canonical anti-slop linter for machine-consumed instruction text (SKILL.md,
// rule-packs, CLAUDE.md). Targets signal density, NOT human-aesthetic detection-
// evasion (em-dashes, contractions, burstiness, perplexity are deliberately absent).
// Single source of truth: the RULES array below exports both the prose rulebook
// (`--rules`, for the authoring LLM) and the auto-detectors (the CLI scan). A drift
// guard rejects any rule that defines neither a detector nor an advisory note.

export type Finding = {
  line: number
  col: number
  id: string
  category: string
  match: string
  fix?: string
}

export type Rule = {
  id: string
  category: string
  prose: string
  fix?: string
  pattern?: RegExp
  scan?: (lines: string[], isCode: boolean[]) => Finding[]
  advisory?: boolean
}

const CATEGORIES = {
  hedge: "epistemic hedge — dilutes a directive into a suggestion; state the rule flat",
  metaPadding: "meta-padding — narrates the text about to be said instead of saying it",
  transition: "filler transition — connective with no load; cut or merge the sentences",
  wordy: "wordy phrase — multi-word stand-in for one word",
  puffery: "puffery buzzword — empty in instruction text; cite the concrete API/fact",
  aiPhrase: "AI set-phrase — overrepresented filler clause",
  opener: "affirmation opener — conversational lead-in; delete",
  antithesis: "antithesis cadence — 'not X, but Y' / 'It is not X. It is Y.' padding",
  boldColon: "bold-colon padding — runs of **Label:** faking structure",
  sameOpener: "same-opener cadence — consecutive bullets starting with the same word",
  restatement: "task restatement — paraphrasing the request back instead of acting on it",
} as const
type Category = keyof typeof CATEGORIES

const word = (alts: string) => new RegExp(`\\b(${alts})\\b`, "gi")
// Russian word/phrase boundary: \b is defined via \w (ASCII only), so it never
// fires next tёo Cyrillic — substrings of inflected forms ("обычно" inside
// "обычном") would over-match. Unicode lookarounds give a real letter boundary.
const ru = (body: string) => new RegExp(`(?<![\\p{L}])(?:${body})(?![\\p{L}])`, "giu")

// --- line-level lexical detectors (English core + Russian equivalents) -----------
const lexical: Array<[Category, string, RegExp, string?]> = [
  // hedges
  ["hedge", "h-en", word("generally|typically|arguably|perhaps|somewhat|in most cases|in some cases|you (may|might) want to|it depends"), "state the rule flat"],
  ["hedge", "h-ru", ru("как правило|обычно|пожалуй|в целом|зачастую|возможно стоит|можно было бы|по возможности"), "убери хедж — дай правило прямо"],
  // meta-padding
  ["metaPadding", "m-en", /(it'?s worth noting|it should be noted|worth noting that|it'?s important to (note|remember|understand)|please note|keep in mind|bear in mind|as (mentioned|noted) (earlier|above|previously))/gi, "delete — say the thing, not that you will say it"],
  ["metaPadding", "m-ru", ru("стоит отметить|важно (отметить|понимать|помнить)|следует (учитывать|отметить|помнить)|обрати внимание,? что|нельзя не отметить|как (упоминалось|отмечалось) выше"), "удали — скажи факт, а не анонсируй его"],
  // filler transitions (load-free connectives)
  ["transition", "t-en", word("furthermore|moreover|additionally|that being said|that said|importantly|notably|essentially|basically|ultimately|in conclusion|in summary|to summarize|overall"), "cut or merge sentences"],
  ["transition", "t-ru", ru("более того|кроме того|таким образом|в свою очередь|стоит также|в конечном счёте|в заключение|подводя итог|в целом говоря"), "вырежи или слей предложения"],
  // wordy phrases
  ["wordy", "w-en", /(in order to|due to the fact that|in the event that|for the purpose of|at this point in time|a (large |small )?number of|with (respect|regard) to|in terms of|the fact that)/gi, "→ to / because / if / now / N / about"],
  ["wordy", "w-ru", ru("в целях|в связи с тем,? что|по причине того,? что|в случае,? если|для того,? чтобы|на текущий момент времени|тот факт,? что|в плане того"), "→ чтобы / потому что / если / сейчас"],
  // puffery buzzwords
  ["puffery", "p-en", word("delv(e|ing)|tapestry|realm|paradigm|robust|seamless(ly)?|underscore[sd]?|pivotal|leverage|leveraging|cutting-edge|game-changer|showcase[sd]?|vibrant|meticulous(ly)?|holistic|synerg(y|ies)|streamline|elevate|unlock|harness|empower|foster|facilitate|utiliz(e|ing)|plethora|myriad|testament"), "name the concrete API/fact"],
  // AI set-phrases
  ["aiPhrase", "a-en", /(at its core|plays a (significant|key|vital|crucial) role|in today'?s (fast-paced )?world|navigate the complexities|when it comes to|at the end of the day|a wide range of|a powerful tool|more than just|the world of)/gi, "delete the clause"],
  // affirmation openers (line start)
  ["opener", "o-en", /^\s*(certainly|of course|sure thing|great question|absolutely|let'?s (dive|explore)|here'?s the)\b/gi, "delete the opener"],
  // antithesis cadence
  ["antithesis", "an-en", /\bnot (just|merely|simply|only)\b[^.\n]{1,60}?\b(but|rather)\b/gi, "make the positive claim once"],
  ["antithesis", "an-en2", /\bit'?s not\b[^.\n]{1,60}?\.\s+it'?s\b/gi, "make the positive claim once"],
  ["antithesis", "an-ru", /(не просто[^.\n]{1,60}?,\s*(а|но)\s|дело не в[^.\n]{1,60}?,\s*а\s|это не[^.\n]{1,60}?\.\s+это\s)/gi, "скажи положительное утверждение один раз"],
]

// --- structural / cadence detectors (language-agnostic) --------------------------
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/

function scanBoldColon(lines: string[], isCode: boolean[]): Finding[] {
  const out: Finding[] = []
  let run: number[] = []
  const flush = () => {
    if (run.length >= 3) for (const i of run) out.push({ line: i + 1, col: 1, id: "s-boldcolon", category: "boldColon", match: lines[i].trim().slice(0, 40), fix: "fold labels into prose; keep at most a couple" })
    run = []
  }
  lines.forEach((l, i) => {
    if (isCode[i]) return flush()
    const m = l.match(/^\s*(?:[-*+]\s+)?\*\*[^*\n]{1,40}:\*\*/)
    if (m) run.push(i)
    else flush()
  })
  flush()
  return out
}

function scanSameOpener(lines: string[], isCode: boolean[]): Finding[] {
  const out: Finding[] = []
  let run: number[] = []
  let prevWord = ""
  const flush = () => {
    if (run.length >= 3) for (const i of run) out.push({ line: i + 1, col: 1, id: "s-sameopener", category: "sameOpener", match: lines[i].trim().slice(0, 40), fix: "vary the opener or restructure the list" })
    run = []
  }
  lines.forEach((l, i) => {
    if (isCode[i]) { flush(); prevWord = ""; return }
    const m = l.match(BULLET)
    if (!m) { flush(); prevWord = ""; return }
    const first = (m[1].match(/[\p{L}']+/u)?.[0] ?? "").toLowerCase()
    if (first && first === prevWord) run.push(i)
    else { flush(); if (first) run = [i] }
    prevWord = first
  })
  flush()
  return out
}

export const RULES: Rule[] = [
  ...lexical.map(([category, id, pattern, fix]): Rule => ({
    id,
    category,
    pattern,
    fix,
    prose: `${CATEGORIES[category]} (${id})`,
  })),
  { id: "s-boldcolon", category: "boldColon", prose: CATEGORIES.boldColon, scan: scanBoldColon },
  { id: "s-sameopener", category: "sameOpener", prose: CATEGORIES.sameOpener, scan: scanSameOpener },
  { id: "adv-restatement", category: "restatement", advisory: true, prose: CATEGORIES.restatement + " — restating the user's request, naming output sections, or re-describing an API the model already knows are not auto-detected; cut them by the gap filter (remove the line → is the agent still right by default? then it was slop)." },
]

// drift guard: every rule must do something and carry a prose line; ids unique.
;(() => {
  const seen = new Set<string>()
  for (const r of RULES) {
    if (seen.has(r.id)) throw new Error(`slop-lint: duplicate rule id ${r.id}`)
    seen.add(r.id)
    if (!r.prose) throw new Error(`slop-lint: rule ${r.id} has no prose`)
    if (!r.pattern && !r.scan && !r.advisory) throw new Error(`slop-lint: rule ${r.id} detects nothing and is not advisory`)
  }
})()

// blank out inline-code spans (`literal`) so quoted API names / slop examples a
// skill documents don't trip the lexical detectors; spaces keep column offsets.
const maskInline = (line: string) => line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length))

function markCode(lines: string[]): boolean[] {
  const isCode: boolean[] = []
  let fenced = false
  for (const l of lines) {
    const fence = /^\s*(```|~~~)/.test(l)
    if (fence) { isCode.push(true); fenced = !fenced; continue }
    isCode.push(fenced || /^\s{4,}\S/.test(l))
  }
  return isCode
}

export function lint(text: string): Finding[] {
  const lines = text.split("\n")
  const isCode = markCode(lines)
  const found: Finding[] = []
  for (const r of RULES) {
    if (r.pattern) {
      lines.forEach((raw, i) => {
        if (isCode[i]) return
        const l = maskInline(raw)
        r.pattern!.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = r.pattern!.exec(l))) {
          found.push({ line: i + 1, col: m.index + 1, id: r.id, category: r.category, match: m[0], fix: r.fix })
          if (m.index === r.pattern!.lastIndex) r.pattern!.lastIndex++
        }
      })
    }
    if (r.scan) found.push(...r.scan(lines, isCode))
  }
  return found.sort((a, b) => a.line - b.line || a.col - b.col)
}

export function rulebook(): string {
  const byCat = new Map<string, string[]>()
  for (const c of Object.keys(CATEGORIES) as Category[]) byCat.set(c, [])
  for (const r of RULES) byCat.get(r.category)!.push(r.advisory ? r.prose : `  ${r.id}${r.fix ? `  → ${r.fix}` : ""}`)
  return [...byCat].map(([c, items]) => `[${c}] ${CATEGORIES[c as Category]}\n${items.join("\n")}`).join("\n\n")
}

// --- CLI -------------------------------------------------------------------------
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.includes("--rules")) {
    console.log(rulebook())
    process.exit(0)
  }
  const file = args.find((a) => !a.startsWith("--"))
  if (!file) {
    console.error("usage: bun slop-lint.ts <file.md>   |   bun slop-lint.ts --rules")
    process.exit(2)
  }
  const text = await Bun.file(file).text()
  const findings = lint(text)
  const asJson = args.includes("--json")
  if (asJson) {
    console.log(JSON.stringify(findings, null, 2))
  } else if (findings.length === 0) {
    console.log(`✓ ${file}: no slop tells`)
  } else {
    for (const f of findings) {
      const fix = f.fix ? `  (${f.fix})` : ""
      console.log(`${file}:${f.line}:${f.col}  [${f.category}]  "${f.match}"${fix}`)
    }
    console.error(`\n${findings.length} tell(s). Rewrite from source — do not paraphrase (paraphrase keeps the cadence).`)
  }
  process.exit(findings.length > 0 ? 1 : 0)
}
