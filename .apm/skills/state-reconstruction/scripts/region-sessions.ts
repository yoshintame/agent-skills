#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HOME = homedir()
const DB = join(HOME, ".claude", "cc.duckdb")
const CC_SQL = join(HOME, ".claude", "skills", "find-session", "assets", "cc.sql")
const PROJECTS = join(HOME, ".claude", "projects")
const HANDOFFS = join(HOME, ".claude", "handoffs")
const BATCH_BYTES = 128 * 1024 * 1024

type Raw = { session_id: string; project: string; ts: string; fp: string | null; tool: string | null; cmd: string | null }
type SessionAgg = { project: string; first: string; last: string; edits: number; writes: number; reads: number; bash: number }
type FileAgg = { last: string; lastSession: string; edits: number; sessions: Set<string> }
type BashAgg = { last: string; hits: number; sample: string }

function usage(): never {
  process.stderr.write(
    "Usage: region-sessions.ts <path-substring> [substring…] [--limit=N]\n" +
      "Substrings match tool file_path and Bash command text (ILIKE, OR).\n",
  )
  process.exit(2)
}

const substrings: string[] = []
let limit = 50
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--limit=")) {
    const n = Number(arg.slice(8))
    if (!Number.isInteger(n) || n <= 0) usage()
    limit = n
  } else if (arg.startsWith("-")) {
    usage()
  } else {
    substrings.push(arg)
  }
}
if (substrings.length === 0) usage()

if (!existsSync(DB)) {
  process.stderr.write(
    `region-sessions: snapshot not found at ${DB}\n` +
      "Build it first: bun ~/.claude/skills/find-session/scripts/search.ts --bm25 --rebuild --sessions \"<anything>\"\n",
  )
  process.exit(1)
}

function sqlLit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`
}

function anyIlike(expr: string): string {
  return "(" + substrings.map((s) => `${expr} ILIKE ${sqlLit(`%${s}%`)}`).join(" OR ") + ")"
}

async function duck(args: string[], sql: string): Promise<Raw[]> {
  const proc = Bun.spawn(["duckdb", ...args, "-json", "-c", sql], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`duckdb exited ${code}: ${err.slice(0, 2000)}`)
  const start = out.indexOf("[")
  if (start < 0) return []
  return JSON.parse(out.slice(start))
}

const FP = "json_extract_string(text, '$.file_path')"
const CMD = "json_extract_string(text, '$.command')"
const MATCH = `((${FP} IS NOT NULL AND ${anyIlike(FP)}) OR (${CMD} IS NOT NULL AND ${anyIlike(CMD)}))`

async function snapshotRows(): Promise<Raw[]> {
  const sql = `
SELECT session_id, project, ts, ${FP} AS fp,
  CASE WHEN ${CMD} IS NOT NULL THEN 'Bash'
       WHEN json_extract_string(text, '$.content') IS NOT NULL THEN 'Write'
       WHEN json_extract_string(text, '$.old_string') IS NOT NULL
         OR json_extract_string(text, '$.edits') IS NOT NULL THEN 'Edit'
       ELSE 'Read' END AS tool,
  ${CMD} AS cmd
FROM msg_cache
WHERE ${anyIlike("text")} AND json_valid(text) AND ${MATCH}`
  return duck([DB, "-readonly"], sql)
}

async function deltaRows(newestMs: number): Promise<{ rows: Raw[]; fileCount: number; bytes: number }> {
  const files: Array<{ path: string; size: number }> = []
  for await (const p of new Bun.Glob("**/*.jsonl").scan({ cwd: PROJECTS, absolute: true })) {
    const st = statSync(p)
    if (st.mtimeMs > newestMs) files.push({ path: p, size: st.size })
  }
  const batches: string[][] = []
  let batch: string[] = []
  let batchBytes = 0
  for (const f of files) {
    if (batch.length > 0 && batchBytes + f.size > BATCH_BYTES) {
      batches.push(batch)
      batch = []
      batchBytes = 0
    }
    batch.push(f.path)
    batchBytes += f.size
  }
  if (batch.length > 0) batches.push(batch)

  const rows: Raw[] = []
  for (const b of batches) {
    const list = b.map(sqlLit).join(", ")
    const sql = `
SELECT session_id, project, ts, ${FP} AS fp, tool, ${CMD} AS cmd
FROM msg_src([${list}])
WHERE kind = 'tool_use' AND ${MATCH}`
    rows.push(...(await duck(["-init", CC_SQL], sql)))
  }
  return { rows, fileCount: files.length, bytes: files.reduce((n, f) => n + f.size, 0) }
}

function fpMatches(fp: string | null): boolean {
  if (!fp) return false
  const lower = fp.toLowerCase()
  return substrings.some((s) => lower.includes(s.toLowerCase()))
}

type Bucket = "write" | "edit" | "read" | "bash" | null
function bucket(r: Raw): Bucket {
  if (r.cmd) return "bash"
  if (!fpMatches(r.fp)) return null
  if (r.tool === "Write" || r.tool === "NotebookEdit") return "write"
  if (r.tool === "Edit" || r.tool === "MultiEdit") return "edit"
  if (r.tool === "Read") return "read"
  return null
}

function short(ts: string): string {
  return ts.slice(0, 16)
}

const newestQ = await duck([DB, "-readonly"], "SELECT max(ts) AS ts FROM msg_cache")
const newest: string = (newestQ[0] as any)?.ts ?? ""
const newestMs = Date.parse(newest)
if (!newest || Number.isNaN(newestMs)) {
  process.stderr.write("region-sessions: snapshot msg_cache is empty or has no timestamps\n")
  process.exit(1)
}

const [snap, delta] = await Promise.all([snapshotRows(), deltaRows(newestMs)])
const deltaSessions = new Set(delta.rows.map((r) => r.session_id))
const rows = [...snap.filter((r) => !deltaSessions.has(r.session_id)), ...delta.rows]

const sessions = new Map<string, SessionAgg>()
const filesAgg = new Map<string, FileAgg>()
const handoffsAgg = new Map<string, FileAgg>()
const bashAgg = new Map<string, BashAgg>()

for (const r of rows) {
  const b = bucket(r)
  if (!b) continue
  const s = sessions.get(r.session_id) ?? {
    project: r.project,
    first: r.ts,
    last: r.ts,
    edits: 0,
    writes: 0,
    reads: 0,
    bash: 0,
  }
  if (r.ts < s.first) s.first = r.ts
  if (r.ts > s.last) s.last = r.ts
  if (b === "write") {
    s.writes++
    s.edits++
  } else if (b === "edit") {
    s.edits++
  } else if (b === "read") {
    s.reads++
  } else {
    s.bash++
  }
  sessions.set(r.session_id, s)

  if ((b === "write" || b === "edit") && r.fp) {
    const agg = r.fp.startsWith(HANDOFFS + "/") ? handoffsAgg : filesAgg
    const f = agg.get(r.fp) ?? { last: r.ts, lastSession: r.session_id, edits: 0, sessions: new Set() }
    if (r.ts >= f.last) {
      f.last = r.ts
      f.lastSession = r.session_id
    }
    f.edits++
    f.sessions.add(r.session_id)
    agg.set(r.fp, f)
  }

  if (b === "bash" && r.cmd) {
    const g = bashAgg.get(r.session_id) ?? { last: r.ts, hits: 0, sample: "" }
    g.hits++
    if (r.ts >= g.last || !g.sample) {
      g.last = r.ts
      g.sample = r.cmd.replaceAll("\n", " ").slice(0, 120)
    }
    bashAgg.set(r.session_id, g)
  }
}

let out = ""
out += `# Region sessions: ${substrings.join(", ")}\n`
out += `generated: ${new Date().toISOString()} | snapshot newest: ${newest} | delta: ${delta.fileCount} files (${Math.round(delta.bytes / 1024 / 1024)} MB) parsed live\n`
out += "⚠ as-of the generated timestamp above; if you read this report in a later turn, re-run before trusting any state claim\n\n"

out += "## Sessions (file-touch first, bash-only mentions after)\n"
out += "`jsonl dir` = slug of where the transcript sits now (a valid `--resume` cwd); for renamed/linked sessions this is the link target, not necessarily the session's original working dir.\n"
const sessionRows = [...sessions.entries()]
  .filter(([, s]) => s.edits > 0 || s.reads > 0 || s.bash > 0)
  .sort((a, b) => {
    const at = a[1].edits + a[1].reads > 0 ? 1 : 0
    const bt = b[1].edits + b[1].reads > 0 ? 1 : 0
    if (at !== bt) return bt - at
    return b[1].last.localeCompare(a[1].last)
  })
if (sessionRows.length === 0) {
  out += "(none)\n"
} else {
  out += "| session | jsonl dir | first | last | edits | writes | reads | bash |\n"
  out += "|---|---|---|---|---|---|---|---|\n"
  for (const [id, s] of sessionRows.slice(0, limit)) {
    out += `| ${id} | ${s.project} | ${short(s.first)} | ${short(s.last)} | ${s.edits} | ${s.writes} | ${s.reads} | ${s.bash} |\n`
  }
  if (sessionRows.length > limit) out += `… and ${sessionRows.length - limit} more (raise --limit)\n`
}
out += "\n"

out += "## Files (edited in region, by last edit)\n"
const fileRows = [...filesAgg.entries()].sort((a, b) => b[1].last.localeCompare(a[1].last))
if (fileRows.length === 0) {
  out += "(none)\n"
} else {
  const fileLimit = limit * 2
  out += "| file | last edit | by session | edits | sessions |\n"
  out += "|---|---|---|---|---|\n"
  for (const [fp, f] of fileRows.slice(0, fileLimit)) {
    out += `| ${fp} | ${short(f.last)} | ${f.lastSession.slice(0, 8)} | ${f.edits} | ${f.sessions.size} |\n`
  }
  if (fileRows.length > fileLimit) out += `… and ${fileRows.length - fileLimit} more (raise --limit)\n`
}
out += "\n"

function handoffStatus(fp: string): string {
  if (!existsSync(fp)) return "gone"
  const head = readFileSync(fp, "utf8").slice(0, 600)
  if (!head.startsWith("---")) return "no-frontmatter"
  return head.match(/^status:\s*(\S+)/m)?.[1] ?? "no-status-field"
}

out += "## Handoffs (region meta-artifacts, not region content)\n"
const handoffRows = [...handoffsAgg.entries()].sort((a, b) => b[1].last.localeCompare(a[1].last))
if (handoffRows.length === 0) {
  out += "(none)\n"
} else {
  out += "| handoff | status | last edit | by session |\n"
  out += "|---|---|---|---|\n"
  for (const [fp, f] of handoffRows) {
    out += `| ${fp} | ${handoffStatus(fp)} | ${short(f.last)} | ${f.lastSession.slice(0, 8)} |\n`
  }
}
out += "\n"

out += "## Bash touches (files created/moved outside Write/Edit live here)\n"
const bashRows = [...bashAgg.entries()].sort((a, b) => b[1].last.localeCompare(a[1].last))
if (bashRows.length === 0) {
  out += "(none)\n"
} else {
  out += "| session | last | hits | sample command |\n"
  out += "|---|---|---|---|\n"
  for (const [id, g] of bashRows.slice(0, limit)) {
    out += `| ${id.slice(0, 8)} | ${short(g.last)} | ${g.hits} | \`${g.sample.replaceAll("|", "\\|").replaceAll("`", "'")}\` |\n`
  }
  if (bashRows.length > limit) out += `… and ${bashRows.length - limit} more (raise --limit)\n`
}

process.stdout.write(out)
