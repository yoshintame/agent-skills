#!/usr/bin/env bun
// Production friction miner for /analyze-friction.
//
// Scans ~/.claude/projects/**/*.jsonl via the find-session DuckDB engine, using
// a sibling init (friction.sql) that exposes tool_use_id so a violation
// (tool_result) can be correlated back to the tool_use that caused it. Emits
// ranked candidate config-diffs, not a raw log.
//
// Two event classes:
//   bypass    = tool_use Bash with $.dangerouslyDisableSandbox='true'
//   violation = tool_result matching an OS/proxy signature (ground truth)
//
// Pipeline: chunked scan (<=128MB) -> friction table (correlated) -> decompose
// compound commands (reusing smart_approve.py) -> extract address from
// signature -> rollup into candidate diffs per fix axis.
import { readdirSync, statSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INIT = fileURLToPath(new URL("../assets/friction.sql", import.meta.url));
const DECOMPOSE = fileURLToPath(new URL("./decompose.py", import.meta.url));
const PROJECTS = `${process.env.HOME}/.claude/projects`;
const TMP = process.env.TMPDIR?.replace(/\/$/, "") || "/tmp/claude";
const DB = `${TMP}/friction.duckdb`;

const sq = (s: string) => s.replace(/'/g, "''");

function duck(sql: string, init = false): string {
  const cmd = ["duckdb"];
  if (init) cmd.push("-init", INIT);
  cmd.push(DB, "-c", sql);
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    process.stderr.write(r.stderr.toString());
    process.exit(1);
  }
  return r.stdout.toString();
}

// ─── signatures → violation class ───
const SIGS: [string, string][] = [
  ["sandbox_violations", "sandbox-violations"],
  ["operation not permitted", "fs-perm-denied"],
  ["failed to verify certificate", "tls-osstatus"],
  ["OSStatus -26276", "tls-osstatus"],
  ["IncompleteRead", "proxy-incompleteread"],
  ["Connection refused", "net-refused"],
];
const sigCase = `CASE ${SIGS.map(([m, k]) => `WHEN text ILIKE '%${sq(m)}%' THEN '${k}'`).join(" ")} END`;
const sigWhere = SIGS.map(([m]) => `text ILIKE '%${sq(m)}%'`).join(" OR ");

// --rollup-only reuses the last scan (DB + dumped rows) so rollup logic can be
// iterated without re-reading the 4GB corpus.
const ROLLUP_ONLY = Bun.argv.includes("--rollup-only");
const jsonl = `${TMP}/friction-rows.json`;

// ─── scan ───
if (!ROLLUP_ONLY) {
rmSync(DB, { force: true });
duck(
  `CREATE TABLE friction(project VARCHAR, session_id VARCHAR, ts VARCHAR, evt VARCHAR,
     tool VARCHAR, cmd VARCHAR, klass VARCHAR, vtext VARCHAR);`,
);

const files = (readdirSync(PROJECTS, { recursive: true }) as string[])
  .filter((p) => p.endsWith(".jsonl"))
  .map((p) => `${PROJECTS}/${p}`);
const batches: string[][] = [];
let cur: string[] = [];
let size = 0;
for (const f of files) {
  let s: number;
  try {
    s = statSync(f).size;
  } catch {
    continue;
  }
  if (cur.length && size + s > 128 * 1024 * 1024) {
    batches.push(cur);
    cur = [];
    size = 0;
  }
  cur.push(f);
  size += s;
}
if (cur.length) batches.push(cur);

console.error(`friction: scanning ${files.length} files in ${batches.length} batches…`);
for (let i = 0; i < batches.length; i++) {
  const list = batches[i].map((p) => `'${sq(p)}'`).join(",");
  duck(
    `CREATE OR REPLACE TABLE _blk AS
       SELECT project, session_id, ts, kind, tool, tuid, text FROM fr_src([${list}]);
     INSERT INTO friction
       SELECT DISTINCT ON (session_id, tuid)
         project, session_id, ts, 'bypass' AS evt, tool,
         regexp_replace(json_extract_string(text,'$.command'), '\\s+', ' ', 'g') AS cmd,
         NULL AS klass, NULL AS vtext
       FROM _blk
       WHERE kind='tool_use' AND tool='Bash'
         AND json_extract_string(text,'$.dangerouslyDisableSandbox')='true';
     INSERT INTO friction
       SELECT DISTINCT ON (v.session_id, v.tuid)
         v.project, v.session_id, v.ts, 'violation' AS evt, u.tool,
         coalesce(regexp_replace(json_extract_string(u.itext,'$.command'), '\\s+', ' ', 'g'),
                  json_extract_string(u.itext,'$.file_path'),
                  json_extract_string(u.itext,'$.path'),
                  json_extract_string(u.itext,'$.url')) AS cmd,
         v.klass, left(v.text, 800) AS vtext
       FROM (SELECT session_id, tuid, ts, project, ${sigCase} AS klass, text
             FROM _blk WHERE kind='tool_result' AND (${sigWhere})) v
       LEFT JOIN (SELECT session_id, tuid, any_value(tool) AS tool, any_value(text) AS itext
                  FROM _blk WHERE kind='tool_use' GROUP BY session_id, tuid) u
         ON v.session_id=u.session_id AND v.tuid=u.tuid
       -- Read/Grep/Glob return file content or search hits that may QUOTE a
       -- signature string (docs about the very incident) — not a real failure.
       -- Only tools that execute or touch the network/FS can produce a violation.
       WHERE u.tool IS NULL OR u.tool NOT IN
         ('Read','Grep','Glob','LS','NotebookRead','TodoWrite','Task','ExitPlanMode','WebSearch');
     DROP TABLE _blk;`,
    true,
  );
  if ((i + 1) % 10 === 0 || i === batches.length - 1)
    console.error(`  batch ${i + 1}/${batches.length}`);
}
duck(`COPY (SELECT * FROM friction) TO '${sq(jsonl)}' (FORMAT json);`);
} // end !ROLLUP_ONLY

// ─── pull rows ───
type Row = {
  project: string;
  session_id: string;
  ts: string;
  evt: "bypass" | "violation";
  tool: string | null;
  cmd: string | null;
  klass: string | null;
  vtext: string | null;
};
const rows: Row[] = readFileSync(jsonl, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// ─── decompose commands (reuse smart_approve.py) ───
const uniqCmds = [...new Set(rows.map((r) => r.cmd).filter((c): c is string => !!c))];
const decIn = `${TMP}/friction-cmds.json`;
writeFileSync(decIn, JSON.stringify(uniqCmds));
const dr = Bun.spawnSync(["python3", DECOMPOSE], {
  stdin: readFileSync(decIn),
  stdout: "pipe",
  stderr: "pipe",
});
if (dr.exitCode !== 0) {
  process.stderr.write(dr.stderr.toString());
  process.exit(1);
}
const decomposed: { leader: string; families: string[] }[] = JSON.parse(dr.stdout.toString());
const decMap = new Map<string, { leader: string; families: string[] }>();
uniqCmds.forEach((c, i) => decMap.set(c, decomposed[i]));
const leaderOf = (cmd: string | null) => (cmd ? decMap.get(cmd)?.leader ?? "?" : "(uncorrelated)");

// ─── address extraction per class ───
function fsPath(v: string | null, cmd: string | null): string | null {
  if (v) {
    // Structured forms first (quoted/JSON preserve paths with spaces such as
    // …/Library/Application Support/…); greedy fallbacks last.
    for (const re of [
      /operation not permitted,\s*\w+\s*'([^']+)'/i, // Node EPERM: mkdir '/p'
      /"path"\s*:\s*"([^"]+)"/, // JSON path field
      /path:\s*'([^']+)'/i,
      /(?:unable to (?:unlink|create|write|open)(?: old| new)?|error:)\s*'([^']+)':\s*Operation not permitted/i, // git
      /open\s+(\/[^\s:'"]+):\s*Operation not permitted/i, // git open /abs
      /^\s*(\S+)\s+internalError\/io/im, // Biome: "<path> internalError/io … Operation not permitted"
      /(?:lock|write) config file\s+(\S+):\s*Operation not permitted/i, // git config
      /failed on\s+([^\s:]+):\s*Operation not permitted/i, // mktemp
      /'([^']*\/[^']+)':\s*Operation not permitted/i, // 'quoted path': Operation…
      /([^\s:'"]*\/[^\s:'"]+):\s*Operation not permitted/i, // bare full path token
      /Operation not permitted[^/\n]{0,40}(\/[^\s:'"\n]+)/i,
    ]) {
      const m = v.match(re);
      if (m) return m[1];
    }
  }
  return null;
}
function netHost(v: string | null, cmd: string | null): string | null {
  const src = `${v ?? ""}\n${cmd ?? ""}`;
  for (const re of [
    /(\d{1,3}(?:\.\d{1,3}){3}:\d+)/, // ip:port
    /(localhost:\d+)/i,
    /(127\.0\.0\.1:\d+)/,
    /https?:\/\/([a-z0-9.-]+(?::\d+)?)/i, // url host
    /Connection refused[^0-9a-z]{0,20}([a-z0-9.-]+:\d+)/i,
  ]) {
    const m = src.match(re);
    if (m) return m[1];
  }
  return null;
}
// collapse volatile path segments so addresses aggregate
function normPath(p: string): string {
  return p
    .replace(process.env.HOME ?? "~", "~")
    .replace(/\/[0-9T]{6,}[^/]*/g, "/<ts>")
    .replace(/\/tmp\.[A-Za-z0-9]+/g, "/tmp.<rand>")
    .replace(/\/[0-9a-f]{8,}(?=\/|$)/g, "/<hash>");
}

const addrOf = (r: Row): string | null => {
  if (r.klass === "fs-perm-denied") {
    const p = fsPath(r.vtext, r.cmd);
    return p ? normPath(p) : null;
  }
  if (r.klass === "net-refused" || r.klass === "sandbox-violations") return netHost(r.vtext, r.cmd);
  return null; // tls/proxy addressed by command binary, not host/path
};

// ─── rollup helpers ───
type Tally = { n: number; sessions: Set<string> };
function tally(rs: Row[], key: (r: Row) => string | null): [string, number, number][] {
  const m = new Map<string, Tally>();
  for (const r of rs) {
    const k = key(r);
    if (k == null) continue;
    let t = m.get(k);
    if (!t) m.set(k, (t = { n: 0, sessions: new Set() }));
    t.n++;
    t.sessions.add(r.session_id);
  }
  return [...m.entries()]
    .map(([k, t]) => [k, t.n, t.sessions.size] as [string, number, number])
    .sort((a, b) => b[1] - a[1]);
}
const shortProj = (p: string) => p.replace(/^-Users-yoshintame-/, "").replace(/^-/, "");
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
function table(rows: [string, number, number][], limit: number, col = "key") {
  const out = [`  ${pad(col, 52)} ${"n".padStart(6)} ${"sess".padStart(6)}`];
  for (const [k, n, s] of rows.slice(0, limit)) out.push(`  ${pad(k, 52)} ${String(n).padStart(6)} ${String(s).padStart(6)}`);
  return out.join("\n");
}

const bypass = rows.filter((r) => r.evt === "bypass");
const viol = rows.filter((r) => r.evt === "violation");
const byClass = (k: string) => viol.filter((r) => r.klass === k);
const corr = viol.filter((r) => r.cmd);

// ─── report ───
const L = (s = "") => console.log(s);
L("\n========== FRICTION MINER ==========");
if (ROLLUP_ONLY) L("(--rollup-only: reusing last scan)");
L(
  duck(
    `SELECT evt, count(*) AS events, count(DISTINCT session_id) AS sessions,
       min(ts)::date AS first, max(ts)::date AS last
     FROM friction GROUP BY evt ORDER BY events DESC;`,
  ),
);
L(`violation→command correlation: ${corr.length}/${viol.length} (${((100 * corr.length) / (viol.length || 1)).toFixed(0)}%) violations carry a command`);

L("\n===== VIOLATION CLASSES (ground truth) =====");
L(table(tally(viol, (r) => r.klass), 10, "class"));

L("\n===== CANDIDATE DIFFS: allowWrite (fs-perm-denied → paths) =====");
L(table(tally(byClass("fs-perm-denied"), addrOf), 15, "path (normalized)"));
L("  — leaders (command) behind fs-perm-denied —");
L(table(tally(byClass("fs-perm-denied"), (r) => leaderOf(r.cmd)), 12, "command"));

L("\n===== CANDIDATE DIFFS: allowedDomains (net-refused → host:port) =====");
L(table(tally(byClass("net-refused"), addrOf), 15, "host:port"));
L("  — leaders (command) behind net-refused —");
L(table(tally(byClass("net-refused"), (r) => leaderOf(r.cmd)), 12, "command"));

L("\n===== CANDIDATE DIFFS: excludedCommands (tls-osstatus + proxy-incompleteread) =====");
L("  tls-osstatus (Go binaries, cert verify):");
L(table(tally(byClass("tls-osstatus"), (r) => leaderOf(r.cmd)), 12, "command"));
L("  proxy-incompleteread (non-HTTPS via proxy):");
L(table(tally(byClass("proxy-incompleteread"), (r) => leaderOf(r.cmd)), 12, "command"));

L("\n===== BYPASS LEADERS (dangerouslyDisableSandbox, decomposed) =====");
L("  (refining slice: which command triggers a bypass; NOT ground truth)");
L(table(tally(bypass, (r) => leaderOf(r.cmd)), 25, "command"));

// tool-invocation bucket: retry clusters (same leader bypassed >=3x in a session)
L("\n===== TOOL-INVOCATION CANDIDATES (skill/wrapper fix, NOT config) =====");
// Repeat friction = the SAME verbatim command bypassed many times in one
// session (agent stuck re-running an invocation) — a skill/wrapper fix, not a
// config change. Keyed on the full normalized command, not the leader, so it
// is not just a frequency ranking of naturally-common commands.
const perSess = new Map<string, Map<string, number>>();
for (const r of bypass) {
  if (!r.cmd) continue;
  let m = perSess.get(r.session_id);
  if (!m) perSess.set(r.session_id, (m = new Map()));
  m.set(r.cmd, (m.get(r.cmd) ?? 0) + 1);
}
const repeat = new Map<string, { repeats: number; sessions: Set<string>; maxRun: number }>();
for (const [sid, m] of perSess) {
  for (const [cmd, c] of m) {
    if (c < 3) continue; // same verbatim command run >=3x in one session
    let t = repeat.get(cmd);
    if (!t) repeat.set(cmd, (t = { repeats: 0, sessions: new Set(), maxRun: 0 }));
    t.repeats += c;
    t.sessions.add(sid);
    t.maxRun = Math.max(t.maxRun, c);
  }
}
L("  repeat clusters — same verbatim command bypassed ≥3× within one session:");
L(`  ${pad("command", 60)} ${"reps".padStart(6)} ${"sess".padStart(5)} ${"max".padStart(4)}`);
for (const [cmd, t] of [...repeat.entries()].sort((a, b) => b[1].repeats - a[1].repeats).slice(0, 15))
  L(`  ${pad(cmd.replace(/\s+/g, " "), 60)} ${String(t.repeats).padStart(6)} ${String(t.sessions.size).padStart(5)} ${String(t.maxRun).padStart(4)}`);
L("  — by leader (which tool the repeat loops cluster on) —");
const repeatLeader = new Map<string, Tally>();
for (const [cmd, t] of repeat) {
  const l = leaderOf(cmd);
  let e = repeatLeader.get(l);
  if (!e) repeatLeader.set(l, (e = { n: 0, sessions: new Set() }));
  e.n += t.repeats;
  for (const s of t.sessions) e.sessions.add(s);
}
L(
  table(
    [...repeatLeader.entries()].map(([k, t]) => [k, t.n, t.sessions.size] as [string, number, number]).sort((a, b) => b[1] - a[1]),
    12,
    "leader",
  ),
);

L("\n===== FRICTION BY PROJECT =====");
L(
  duck(
    `SELECT regexp_replace(project,'^-Users-yoshintame-','') AS project,
       sum(CASE WHEN evt='bypass' THEN 1 ELSE 0 END) AS bypass,
       sum(CASE WHEN evt='violation' THEN 1 ELSE 0 END) AS violation, count(*) AS total
     FROM friction GROUP BY project ORDER BY total DESC LIMIT 20;`,
  ),
);

L("\n===== CORRELATION SAMPLES (class → command → address) =====");
for (const k of ["fs-perm-denied", "net-refused", "tls-osstatus", "proxy-incompleteread"]) {
  const ex = byClass(k).filter((r) => r.cmd).slice(0, 3);
  for (const r of ex) L(`  ${pad(k, 20)} ${pad(leaderOf(r.cmd), 22)} → ${addrOf(r) ?? r.cmd?.slice(0, 50)}`);
}
L(`\nrows dumped: ${jsonl}  (raw friction rows for iteration)`);
