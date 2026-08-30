#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ASSET = fileURLToPath(new URL("../assets/cc.sql", import.meta.url));
const DB = `${process.env.HOME}/.claude/cc.duckdb`;
const PROJECTS = `${process.env.HOME}/.claude/projects`;

const RU_STOP = new Set("для и во в на с со по к ко у о об что как это не но а же ли от до из за при я мне меня мной ты".split(" "));
const EN_STOP = new Set("the for a an to of in on and or with is are my me i it this that".split(" "));

const DEEP_LINK = "vscode://anthropic.claude-code/open?session=";

type Args = {
  synonyms: string[];
  kind?: string;
  tool?: string;
  limit: number;
  sessions: boolean;
  link: boolean;
  noStem: boolean;
  showSql: boolean;
  distinct: boolean;
  bm25: boolean;
  full: boolean;
  rebuild: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { synonyms: [], limit: 40, sessions: false, link: false, noStem: false, showSql: false, distinct: false, bm25: false, full: false, rebuild: false };
  for (const t of argv) {
    if (t === "--sessions") a.sessions = true;
    else if (t === "--link" || t === "--resume") { a.sessions = true; a.link = true; }
    else if (t === "--no-stem") a.noStem = true;
    else if (t === "--distinct") a.distinct = true;
    else if (t === "--sql") a.showSql = true;
    else if (t === "--bm25") a.bm25 = true;
    else if (t === "--full") { a.full = true; a.bm25 = true; }
    else if (t === "--rebuild") { a.rebuild = true; a.bm25 = true; }
    else if (t.startsWith("--kind=")) a.kind = t.slice(7);
    else if (t.startsWith("--tool=")) { a.tool = t.slice(7); a.kind ??= "tool_use"; }
    else if (t.startsWith("--limit=")) a.limit = Math.max(1, parseInt(t.slice(8), 10) || 40);
    else if (t.startsWith("--")) { console.error(`unknown flag: ${t}`); process.exit(2); }
    else a.synonyms.push(t);
  }
  if (a.synonyms.length === 0) {
    console.error('usage: search.ts "<words>" [...] [--bm25 [--full] [--rebuild]] [--kind=K] [--tool=NAME] [--sessions] [--link] [--distinct] [--limit=N] [--no-stem] [--sql]');
    console.error('       open-session.ts <session-id>   # actually open it, in a window on its own cwd');
    process.exit(2);
  }
  return a;
}

const tokenize = (phrase: string): string[] =>
  phrase.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !RU_STOP.has(w) && !EN_STOP.has(w));

const lang = (w: string): "russian" | "english" => (/[а-яё]/i.test(w) ? "russian" : "english");

// one synonym -> ordered loose-phrase ILIKE over its stemmed tokens: %a%b%
function clause(phrase: string, stem: boolean): string | null {
  const toks = tokenize(phrase);
  if (toks.length === 0) return null;
  const parts = toks.map((w) => (stem ? `stem('${w}','${lang(w)}')` : `'${w}'`));
  return `m.text ILIKE '%' || ${parts.join(" || '%' || ")} || '%'`;
}

type DuckOpts = { init?: boolean; db?: string; csv?: boolean };
function duck(sql: string, opts: DuckOpts = {}): { ok: boolean; out: string; err: string } {
  const cmd = ["duckdb"];
  if (opts.init) cmd.push("-init", ASSET);
  if (opts.csv) cmd.push("-csv", "-noheader");
  if (opts.db) cmd.push(opts.db);
  cmd.push("-c", sql);
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}

const args = parseArgs(Bun.argv.slice(2));

// ─── BM25 path: ranked shortlist over a persistent snapshot + FTS index ───
if (args.bm25) {
  const table = args.full ? "msg_cache" : "me_cache";
  const q = args.synonyms.join(" ").replace(/'/g, "''");

  // The JSON reader's buffers don't spill to disk: one CTAS over the full glob
  // OOMs on a large corpus regardless of memory_limit. Scan in bounded batches
  // of whole files instead, INSERT INTO per batch via the *_src(files) macro.
  const fileBatches = (maxBytes: number): string[][] => {
    const files = (readdirSync(PROJECTS, { recursive: true }) as string[])
      .filter((p) => p.endsWith(".jsonl"))
      .map((p) => `${PROJECTS}/${p}`);
    const out: string[][] = [];
    let cur: string[] = [];
    let size = 0;
    for (const f of files) {
      let s: number;
      try { s = statSync(f).size; } catch { continue; }
      if (cur.length > 0 && size + s > maxBytes) { out.push(cur); cur = []; size = 0; }
      cur.push(f); size += s;
    }
    if (cur.length > 0) out.push(cur);
    return out;
  };

  const build = () => {
    const src = args.full ? "msg_src" : "me_src";
    const parts = fileBatches(128 * 1024 * 1024);
    console.error(`bm25: building ${table} via ${src} (chunked scan, ${parts.length} batches)…`);
    const b0 = duck(`CREATE OR REPLACE TABLE ${table}(project VARCHAR, session_id VARCHAR, ts VARCHAR, text VARCHAR);`, { db: DB });
    if (!b0.ok) { process.stderr.write(b0.err); process.exit(1); }
    for (let i = 0; i < parts.length; i++) {
      const list = parts[i].map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
      const b1 = duck(`INSERT INTO ${table} SELECT project, session_id, ts, text FROM ${src}([${list}]);`, { init: true, db: DB });
      if (!b1.ok) { process.stderr.write(b1.err); process.exit(1); }
      console.error(`  batch ${i + 1}/${parts.length}`);
    }
    // id via sequence (NOT row_number() OVER () — global window hangs the scan)
    const b2 = duck(
      `ALTER TABLE ${table} ADD COLUMN id BIGINT;
       CREATE OR REPLACE SEQUENCE seq_${table};
       UPDATE ${table} SET id = nextval('seq_${table}');
       LOAD fts;
       PRAGMA create_fts_index('${table}', 'id', 'text', stemmer='russian', overwrite=1);`,
      { db: DB },
    );
    if (!b2.ok) { process.stderr.write(b2.err); process.exit(1); }
  };

  const scored = `SELECT *, fts_main_${table}.match_bm25(id, '${q}') AS score FROM ${table}`;
  const querySql = args.sessions
    ? `LOAD fts;
       SELECT project, session_id, round(max(score), 2) AS score, round(sum(score), 2) AS total, count(*) AS hits,
         min(ts)::date AS first_seen, max(ts)::date AS last_seen,
         '${DEEP_LINK}' || session_id AS link
       FROM (${scored}) s WHERE score IS NOT NULL
       GROUP BY project, session_id ORDER BY score DESC LIMIT ${args.limit};`
    : `LOAD fts;
       SELECT ts::date AS dt, project, round(score, 2) AS score,
         left(regexp_replace(text, '\\s+', ' ', 'g'), 160) AS snippet
       FROM (${scored}) s WHERE score IS NOT NULL ORDER BY score DESC LIMIT ${args.limit};`;

  if (args.showSql) { console.log(querySql); process.exit(0); }

  if (args.rebuild) build();
  let r = duck(querySql, { db: DB });
  if (!r.ok && /does not exist|Catalog Error|fts_main_/i.test(r.err)) { build(); r = duck(querySql, { db: DB }); }

  const meta = duck(`SELECT count(*), max(ts)::date FROM ${table};`, { db: DB, csv: true }).out.trim().split(",");
  console.error(`bm25 ${table} rows=${meta[0] ?? "?"} newest=${meta[1] ?? "?"} (reuse; --rebuild to refresh)\nq: ${args.synonyms.join(" ")}`);

  process.stdout.write(r.out);
  const realErr = r.err.split("\n").filter((l) => l.trim() && !l.includes("Loading resources")).join("\n");
  if (realErr) { process.stderr.write(realErr + "\n"); if (!r.ok) process.exit(1); }
  process.exit(0);
}

// ─── ILIKE path: agent-supplied synonyms, Snowball-stemmed, OR'd ───
const stem = !args.noStem && duck("LOAD fts; SELECT 1;").ok;

const clauses = args.synonyms.map((s) => clause(s, stem)).filter((c): c is string => c !== null);
if (clauses.length === 0) { console.error("all synonyms reduced to stopwords"); process.exit(2); }

const view = args.kind && args.kind !== "user" ? "msg" : "me";
const where = [`(${clauses.join(") OR (")})`];
if (args.kind && view === "msg") where.push(`m.kind = '${args.kind}'`);
if (args.tool) where.push(`m.tool = '${args.tool}'`);

// dedup key: strip <ide_selection> block (dotall) + collapse whitespace
const NORM = "regexp_replace(regexp_replace(m.text, '<ide_selection>.*?</ide_selection>', '', 'gs'), '\\s+', ' ', 'g')";

const select = args.sessions
  ? `SELECT m.project, m.session_id, ${args.distinct ? `count(DISTINCT ${NORM})` : "count(*)"} AS hits,
       min(m.ts)::date AS first_seen, max(m.ts)::date AS last_seen${args.link ? `,
       '${DEEP_LINK}' || m.session_id AS link` : ""}
   FROM ${view} m WHERE ${where.join(" AND ")}
   GROUP BY m.project, m.session_id ORDER BY last_seen DESC LIMIT ${args.limit}`
  : `SELECT m.ts::date AS dt, m.project,
       left(regexp_replace(m.text, '\\s+', ' ', 'g'), 160) AS snippet
   FROM ${view} m WHERE ${where.join(" AND ")}
   ${args.distinct ? `QUALIFY row_number() OVER (PARTITION BY ${NORM} ORDER BY m.ts) = 1` : ""}
   ORDER BY m.ts DESC LIMIT ${args.limit}`;

const sql = `${stem ? "LOAD fts;\n" : ""}${select};`;

if (args.showSql) { console.log(sql); process.exit(0); }

const stems = stem
  ? args.synonyms.map((s) => `${s} → %${tokenize(s).map((w) => `${w}:${lang(w)[0]}`).join("%")}%`)
  : args.synonyms;
console.error(`view=${view} stem=${stem} distinct=${args.distinct} limit=${args.limit}\nterms: ${stems.join("  |  ")}`);

const r = duck(select.replace(/^/, stem ? "LOAD fts;\n" : ""), { init: true });
process.stdout.write(r.out);
const realErr = r.err.split("\n").filter((l) => l.trim() && !l.includes("Loading resources")).join("\n");
if (realErr) { process.stderr.write(realErr + "\n"); if (!r.ok) process.exit(1); }
