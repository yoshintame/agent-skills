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
  project?: string;
  since?: string;
  until?: string;
  limit: number;
  sessions: boolean;
  link: boolean;
  noStem: boolean;
  showSql: boolean;
  distinct: boolean;
  bm25: boolean;
  full: boolean;
  rebuild: boolean;
  noFold: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { synonyms: [], limit: 40, sessions: false, link: false, noStem: false, showSql: false, distinct: false, bm25: false, full: false, rebuild: false, noFold: false };
  for (const t of argv) {
    if (t === "--sessions") a.sessions = true;
    else if (t === "--link" || t === "--resume") { a.sessions = true; a.link = true; }
    else if (t === "--no-stem") a.noStem = true;
    else if (t === "--distinct") a.distinct = true;
    else if (t === "--sql") a.showSql = true;
    else if (t === "--bm25") a.bm25 = true;
    else if (t === "--full") { a.full = true; a.bm25 = true; }
    else if (t === "--rebuild") { a.rebuild = true; a.bm25 = true; }
    else if (t === "--no-fold") a.noFold = true;
    else if (t.startsWith("--kind=")) a.kind = t.slice(7);
    else if (t.startsWith("--tool=")) { a.tool = t.slice(7); a.kind ??= "tool_use"; }
    else if (t.startsWith("--project=")) a.project = t.slice(10);
    else if (t.startsWith("--since=")) a.since = t.slice(8);
    else if (t.startsWith("--until=")) a.until = t.slice(8);
    else if (t.startsWith("--limit=")) a.limit = Math.max(1, parseInt(t.slice(8), 10) || 40);
    else if (t.startsWith("--")) { console.error(`unknown flag: ${t}`); process.exit(2); }
    else a.synonyms.push(t);
  }
  if (a.synonyms.length === 0) {
    console.error('usage: search.ts "<words>" [...] [--bm25 [--full] [--rebuild] [--no-fold]] [--kind=K] [--tool=NAME] [--project=SLUG] [--since=DATE] [--until=DATE] [--sessions] [--link] [--distinct] [--limit=N] [--no-stem] [--sql]');
    console.error('       open-session.ts <session-id>   # actually open it, in a window on its own cwd');
    process.exit(2);
  }
  return a;
}

const sq = (s: string): string => s.replace(/'/g, "''");

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
  // --kind/--tool need the tool columns, which only msg_cache carries.
  const needsMsg = args.full || !!args.kind || !!args.tool;
  const table = needsMsg ? "msg_cache" : "me_cache";
  const q = sq(args.synonyms.join(" "));

  // Metadata filters live OUTSIDE match_bm25 so IDF stays global (rare terms
  // stay rare); candidates are just restricted to the slice afterwards.
  const filters: string[] = [];
  if (args.project) filters.push(`project ILIKE '%${sq(args.project)}%'`);
  if (args.since) filters.push(`ts::date >= '${sq(args.since)}'`);
  if (args.until) filters.push(`ts::date <= '${sq(args.until)}'`);
  if (args.kind && needsMsg) filters.push(`kind = '${sq(args.kind)}'`);
  if (args.tool && needsMsg) filters.push(`tool = '${sq(args.tool)}'`);
  const filterSql = filters.length ? ` AND ${filters.join(" AND ")}` : "";

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
    const parts = fileBatches(128 * 1024 * 1024);
    console.error(`bm25: building ${table} (cleaned + fork-deduped, chunked scan, ${parts.length} batches)…`);
    const ddl = needsMsg
      ? `CREATE OR REPLACE TABLE ${table}(project VARCHAR, session_id VARCHAR, ts VARCHAR, kind VARCHAR, tool VARCHAR, text VARCHAR);`
      : `CREATE OR REPLACE TABLE ${table}(project VARCHAR, session_id VARCHAR, ts VARCHAR, text VARCHAR);`;
    const b0 = duck(ddl, { db: DB });
    if (!b0.ok) { process.stderr.write(b0.err); process.exit(1); }
    for (let i = 0; i < parts.length; i++) {
      const list = parts[i].map((p) => `'${sq(p)}'`).join(",");
      // index_text() cleans prose and tool_use, drops tool_result/self-tooling;
      // GROUP BY (session, text) collapses byte-identical branch copies so a
      // common parentUuid prefix stops inflating term frequency.
      const ins = needsMsg
        ? `INSERT INTO ${table}
             SELECT project, session_id, min(ts) AS ts, any_value(kind) AS kind, any_value(tool) AS tool, txt
             FROM (SELECT project, session_id, ts, kind, tool, index_text(kind, text) AS txt FROM msg_src([${list}]))
             WHERE txt IS NOT NULL AND length(txt) > 0
             GROUP BY project, session_id, txt;`
        : `INSERT INTO ${table}
             SELECT project, session_id, min(ts) AS ts, txt
             FROM (SELECT project, session_id, ts, nullif(strip_injections(text), '') AS txt FROM me_src([${list}]))
             WHERE txt IS NOT NULL AND length(txt) > 0
             GROUP BY project, session_id, txt;`;
      const b1 = duck(ins, { init: true, db: DB });
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
  // Inter-file fork fold: clones of one conversation share their peak (top-scoring)
  // message, so md5(peak) groups them; keep the best-scoring/latest, count the rest
  // as `forks`. Short generic peaks fall back to session_id so distinct sessions
  // that merely share a "продолжай" don't collapse into one.
  const querySql = args.sessions
    ? `LOAD fts;
       WITH scored AS (${scored}),
       hit AS (SELECT * FROM scored WHERE score IS NOT NULL${filterSql}),
       per_session AS (
         SELECT project, session_id, max(score) AS score, sum(score) AS total, count(*) AS hits,
           min(ts)::date AS first_seen, max(ts)::date AS last_seen, arg_max(text, score) AS peak
         FROM hit GROUP BY project, session_id),
       keyed AS (SELECT *, md5(CASE WHEN length(peak) >= 40 THEN peak ELSE session_id END) AS fk FROM per_session),
       folded AS (
         SELECT *, count(*) OVER (PARTITION BY fk) - 1 AS forks,
           row_number() OVER (PARTITION BY fk ORDER BY score DESC, last_seen DESC) AS rn
         FROM keyed)
       SELECT project, session_id, round(score, 2) AS score, round(total, 2) AS total, hits, forks,
         first_seen, last_seen, '${DEEP_LINK}' || session_id AS link
       FROM folded${args.noFold ? "" : " WHERE rn = 1"} ORDER BY score DESC LIMIT ${args.limit};`
    : `LOAD fts;
       SELECT ts::date AS dt, project,${needsMsg ? " kind, tool," : ""} round(score, 2) AS score,
         left(regexp_replace(text, '\\s+', ' ', 'g'), 160) AS snippet
       FROM (${scored}) s WHERE score IS NOT NULL${filterSql} ORDER BY score DESC LIMIT ${args.limit};`;

  if (args.showSql) { console.log(querySql); process.exit(0); }

  if (args.rebuild) build();
  let r = duck(querySql, { db: DB });
  if (!r.ok && /does not exist|Catalog Error|fts_main_|Binder Error|Referenced column/i.test(r.err)) { build(); r = duck(querySql, { db: DB }); }

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
if (args.kind && view === "msg") where.push(`m.kind = '${sq(args.kind)}'`);
if (args.tool) where.push(`m.tool = '${sq(args.tool)}'`);
if (args.project) where.push(`m.project ILIKE '%${sq(args.project)}%'`);
if (args.since) where.push(`m.ts::date >= '${sq(args.since)}'`);
if (args.until) where.push(`m.ts::date <= '${sq(args.until)}'`);

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
