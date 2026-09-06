#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const WORD = (alts: string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join("|")})(?![\\p{L}\\p{N}_])`, "iu");

const HIGH: { re: RegExp; name: string }[] = [
  { re: /было\s+ошибкой|оказал\w*\s+ошибкой|по\s+ошибке/iu, name: "ошибкой" },
  { re: /пересмотр\w*/iu, name: "пересмотр…" },
  { re: /переосмысл\w*/iu, name: "переосмысл…" },
  { re: /прежн\w*/iu, name: "прежн…" },
  { re: WORD(["изначально", "ранее", "раньше", "первоначально"]), name: "раньше/ранее" },
  { re: /больше\s+не|уже\s+не/iu, name: "больше не" },
  { re: /теперь\s+вместо|вместо\s+прежн\w*/iu, name: "теперь вместо" },
  { re: WORD(["previously", "formerly", "originally"]), name: "previously" },
  { re: /used\s+to|no\s+longer|instead\s+of\s+the/iu, name: "used to / no longer" },
];

const MEDIUM: { re: RegExp; name: string }[] = [
  { re: /убра[нл]\w*/iu, name: "убрано/убрали" },
  { re: /удал(и|е)\w*/iu, name: "удалили" },
  { re: /замен(и|е)\w*/iu, name: "заменили" },
];

const CUR_TYPES = ["business-spec", "implementation-spec"];
const HIST_TYPES = ["analysis", "task", "idea", "open-question", "decision", "incident"];

const HIST_SEG = ["/analysis/", "/archive/", "/tasks/", "/task/", "/ideas/", "/idea/", "/decisions", "/incidents", "/open-question", "/log", "/changelog"];
const CUR_SEG = ["/business-spec/", "/implementation-spec/", "/spec/", "/specs/", "/business/", "/technical/", "/reference/"];

function frontmatterType(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const m = text.slice(0, end).match(/^type:\s*\[?\s*["']?([a-z-]+)/im);
  return m ? m[1] : null;
}

function classify(path: string, text: string): "current" | "history" | "unknown" {
  const t = frontmatterType(text);
  if (t) {
    if (CUR_TYPES.includes(t)) return "current";
    if (HIST_TYPES.includes(t)) return "history";
    return "unknown";
  }
  const p = path.toLowerCase();
  if (HIST_SEG.some((s) => p.includes(s))) return "history";
  if (CUR_SEG.some((s) => p.includes(s))) return "current";
  return "unknown";
}

function* walk(p: string): Generator<string> {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      yield* walk(join(p, e));
    }
  } else if (p.endsWith(".md") || p.endsWith(".mdx")) {
    yield p;
  }
}

function scan(text: string) {
  const hits: { line: number; tier: string; name: string; text: string }[] = [];
  let fenced = false;
  let inFm = text.startsWith("---");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (inFm) { if (i > 0 && ln.trim() === "---") inFm = false; continue; }
    if (ln.trimStart().startsWith("```")) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const m of HIGH) if (m.re.test(ln)) hits.push({ line: i + 1, tier: "HIGH", name: m.name, text: ln.trim() });
    for (const m of MEDIUM) if (m.re.test(ln)) hits.push({ line: i + 1, tier: "med", name: m.name, text: ln.trim() });
  }
  return hits;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("использование: history-lint.ts <файл|папка> [...]  — ловит разворотные/исторические маркеры в current-state доках");
  process.exit(2);
}

let scanned = 0, skipped = 0, unknown = 0, highTotal = 0;
for (const root of args) {
  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8");
    const kind = classify(file, text);
    if (kind === "history") { skipped++; continue; }
    if (kind === "unknown") unknown++;
    scanned++;
    const hits = scan(text);
    if (hits.length === 0) continue;
    const high = hits.filter((h) => h.tier === "HIGH").length;
    highTotal += high;
    console.log(`\n${file}${kind === "unknown" ? "  (тип не подтверждён — убедись, что это current-state)" : ""}`);
    for (const h of hits) {
      const trimmed = h.text.length > 120 ? h.text.slice(0, 117) + "…" : h.text;
      console.log(`  L${h.line} [${h.tier}] «${h.name}»  ${trimmed}`);
    }
  }
}

console.log(`\n— просканировано current-state файлов: ${scanned} (не подтверждено: ${unknown}), пропущено history-allowed: ${skipped}, HIGH-маркеров: ${highTotal}.`);
process.exit(highTotal > 0 ? 1 : 0);
