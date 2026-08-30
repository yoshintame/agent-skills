#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, extname, join, relative } from "node:path"
import $ from "dax-sh"

$.setPrintCommand(false)

const PROJECTS = join(homedir(), ".claude", "projects")
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const WINDOW_BUFFER_MS = 60 * 60 * 1000

const DOC_EXT = new Set([".md", ".txt", ".rst"])
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".swift", ".rb", ".php",
])
const CONFIG_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".lock"])
const NOISE = ["/node_modules/", "/.next/", "/dist/", "/build/", "/.git/", "/coverage/", "/.turbo/"]

type FileClass = "doc" | "code" | "config" | "other"
type ToolEdit = { filePath: string; timestamp: string; tool: string }
type Parsed = {
  sessionId: string | null
  edits: ToolEdit[]
  startMs: number | null
  endMs: number | null
}

function cwdHash(): string {
  return process.cwd().replace(/[^a-zA-Z0-9]/g, "-")
}

async function findSessionJsonl(sessionId: string | null): Promise<string | null> {
  const id = sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? null
  if (id) {
    for await (const p of new Bun.Glob(`**/${id}.jsonl`).scan({ cwd: PROJECTS, absolute: true })) {
      return p
    }
    if (sessionId) return null
  }
  const projDir = join(PROJECTS, cwdHash())
  if (!existsSync(projDir)) return null
  const files: string[] = []
  for await (const p of new Bun.Glob("*.jsonl").scan({ cwd: projDir, absolute: true })) {
    files.push(p)
  }
  if (files.length === 0) return null
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return files[0]
}

function isoToUnix(ts: string): number | null {
  if (!ts) return null
  const ms = Date.parse(ts)
  return Number.isNaN(ms) ? null : ms
}

function* toolEdits(rec: any): Generator<ToolEdit> {
  if (rec?.type !== "assistant") return
  const content = rec.message?.content
  if (!Array.isArray(content)) return
  for (const item of content) {
    if (!(item && typeof item === "object" && item.type === "tool_use")) continue
    if (!EDIT_TOOLS.has(item.name)) continue
    const filePath = item.input?.file_path
    if (filePath) yield { filePath, timestamp: rec.timestamp ?? "", tool: item.name }
  }
}

async function parseSession(path: string): Promise<Parsed> {
  const edits: ToolEdit[] = []
  let sessionId: string | null = null
  let startMs: number | null = null
  let endMs: number | null = null
  const text = await Bun.file(path).text()
  for (const line of text.split("\n")) {
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!sessionId) sessionId = rec.sessionId ?? null
    const ms = isoToUnix(rec.timestamp ?? "")
    if (ms !== null) {
      if (startMs === null || ms < startMs) startMs = ms
      if (endMs === null || ms > endMs) endMs = ms
    }
    for (const e of toolEdits(rec)) edits.push(e)
  }
  return { sessionId, edits, startMs, endMs }
}

async function findLaterTouches(
  filePath: string,
  currentSessionId: string | null,
  afterTs: string,
): Promise<Array<[sessionId: string, timestamp: string]>> {
  const afterUnix = isoToUnix(afterTs)
  const later: Array<[string, string]> = []
  for await (const jsonl of new Bun.Glob("**/*.jsonl").scan({ cwd: PROJECTS, absolute: true })) {
    const stem = basename(jsonl, ".jsonl")
    if (currentSessionId && stem === currentSessionId) continue
    if (afterUnix !== null && statSync(jsonl).mtimeMs < afterUnix) continue
    let text: string
    try {
      text = await Bun.file(jsonl).text()
    } catch {
      continue
    }
    let matched = false
    for (const line of text.split("\n")) {
      let rec: any
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      for (const e of toolEdits(rec)) {
        if (e.filePath !== filePath) continue
        if (e.timestamp > afterTs) {
          later.push([stem, e.timestamp])
          matched = true
          break
        }
      }
      if (matched) break
    }
  }
  return later
}

function classify(absPath: string): FileClass {
  const base = basename(absPath)
  const ext = extname(absPath).toLowerCase()
  if (DOC_EXT.has(ext)) return "doc"
  if (/^(README|CHANGELOG|LICENSE)/i.test(base)) return "doc"
  if (absPath.includes("/docs/")) return "doc"
  if (CONFIG_EXT.has(ext) || base === ".gitignore") return "config"
  if (CODE_EXT.has(ext)) return "code"
  return "other"
}

function isNoise(absPath: string): boolean {
  return NOISE.some((n) => absPath.includes(n))
}

function nearestExistingDir(dir: string): string {
  let d = dir
  while (!existsSync(d)) {
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return d
}

const toplevelCache = new Map<string, string | null>()
async function gitToplevel(fileDir: string): Promise<string | null> {
  const dir = nearestExistingDir(fileDir)
  const cached = toplevelCache.get(dir)
  if (cached !== undefined) return cached
  const res = await $`git -C ${dir} rev-parse --show-toplevel`.noThrow().stdout("piped").stderr("null")
  const top = res.code === 0 ? res.stdout.trim() : null
  toplevelCache.set(dir, top)
  return top
}

async function gitLogDatesForAdd(repo: string, relpath: string): Promise<number[]> {
  const res = await $`git -C ${repo} log --diff-filter=A --format=%cI -- ${relpath}`.noThrow().stdout("piped").stderr("null")
  if (res.code !== 0) return []
  return res.stdout.split("\n").map((l) => Date.parse(l.trim())).filter((n) => !Number.isNaN(n))
}

async function gitLogCommitsForPath(repo: string, relpath: string): Promise<Array<{ hash: string; ms: number; iso: string }>> {
  const res = await $`git -C ${repo} log --format=%h%x09%cI -- ${relpath}`.noThrow().stdout("piped").stderr("null")
  if (res.code !== 0) return []
  const out: Array<{ hash: string; ms: number; iso: string }> = []
  for (const line of res.stdout.split("\n")) {
    if (!line) continue
    const [hash, iso] = line.split("\t")
    const ms = Date.parse(iso ?? "")
    if (hash && !Number.isNaN(ms)) out.push({ hash, ms, iso: iso! })
  }
  return out
}

async function gitWindowCommits(repo: string, sinceIso: string, untilIso: string): Promise<Array<{ hash: string; subject: string }>> {
  const res = await $`git -C ${repo} log --since=${sinceIso} --until=${untilIso} --format=%h%x09%s`.noThrow().stdout("piped").stderr("null")
  if (res.code !== 0) return []
  const out: Array<{ hash: string; subject: string }> = []
  for (const line of res.stdout.split("\n")) {
    if (!line) continue
    const tab = line.indexOf("\t")
    if (tab < 0) continue
    out.push({ hash: line.slice(0, tab), subject: line.slice(tab + 1) })
  }
  return out
}

async function gitCommitFiles(repo: string, hash: string): Promise<string[]> {
  const res = await $`git -C ${repo} show --name-only --format= ${hash}`.noThrow().stdout("piped").stderr("null")
  if (res.code !== 0) return []
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
}

function keyPaths(relpaths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of relpaths) {
    const d = dirname(r)
    const key = d === "." ? r : `${d}/`
    if (!seen.has(key)) {
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

async function fileAction(opts: {
  abs: string
  repo: string | null
  relpath: string | null
  wasWritten: boolean
  deleted: boolean
  startMs: number
}): Promise<string> {
  if (opts.deleted) return "deleted?"
  if (!opts.wasWritten) return "changed"
  if (!opts.repo || !opts.relpath) return "created"
  const addDates = await gitLogDatesForAdd(opts.repo, opts.relpath)
  if (addDates.length === 0) return "created"
  return Math.min(...addDates) < opts.startMs ? "rewrote" : "created"
}

type FileModel = {
  abs: string
  repo: string | null
  relpath: string | null
  cls: FileClass
  action: string
  lastTouch: string
}

function line(s = ""): string {
  return `${s}\n`
}

async function report(sessionIdArg: string | null): Promise<string | null> {
  const jsonl = await findSessionJsonl(sessionIdArg)
  if (!jsonl) {
    const target = sessionIdArg ? `id=${sessionIdArg}` : `cwd=${process.cwd()}`
    process.stderr.write(`No session JSONL found for ${target}\n`)
    return null
  }

  const parsed = await parseSession(jsonl)

  const editMs = parsed.edits.map((e) => isoToUnix(e.timestamp)).filter((m): m is number => m !== null)
  const startMs = editMs.length > 0 ? Math.min(...editMs) : (parsed.startMs ?? 0)
  const endMs = editMs.length > 0 ? Math.max(...editMs) : (parsed.endMs ?? 0)
  const thresholdMs = endMs + WINDOW_BUFFER_MS
  const sinceIso = new Date(startMs - WINDOW_BUFFER_MS).toISOString()
  const untilIso = new Date(thresholdMs).toISOString()

  const agg = new Map<string, { tools: Set<string>; lastTouch: string }>()
  for (const e of parsed.edits) {
    if (isNoise(e.filePath)) continue
    const cur = agg.get(e.filePath)
    if (!cur) {
      agg.set(e.filePath, { tools: new Set([e.tool]), lastTouch: e.timestamp })
    } else {
      cur.tools.add(e.tool)
      if (e.timestamp > cur.lastTouch) cur.lastTouch = e.timestamp
    }
  }

  const files: FileModel[] = []
  for (const [abs, info] of agg) {
    const repo = await gitToplevel(dirname(abs))
    const relpath = repo ? relative(repo, abs) : null
    const cls = classify(abs)
    const deleted = !existsSync(abs)
    const wasWritten = info.tools.has("Write")
    const action = await fileAction({ abs, repo, relpath, wasWritten, deleted, startMs })
    files.push({ abs, repo, relpath, cls, action, lastTouch: info.lastTouch })
  }
  files.sort((a, b) => a.abs.localeCompare(b.abs))

  const repos = [...new Set(files.map((f) => f.repo).filter((r): r is string => r !== null))]

  let out = ""
  out += line(`# Session ${parsed.sessionId}`)
  out += line(`Window: ${startMs ? new Date(startMs).toISOString() : "?"} → ${endMs ? new Date(endMs).toISOString() : "?"}`)
  out += line()

  out += line("## Documentation")
  const docFiles = files.filter((f) => f.repo && f.cls === "doc")
  if (docFiles.length === 0) {
    out += line("(none)")
  } else {
    for (const repo of repos) {
      const inRepo = docFiles.filter((f) => f.repo === repo)
      if (inRepo.length === 0) continue
      out += line(`### ${basename(repo)} (${repo})`)
      for (const f of inRepo) out += line(`- ${f.relpath} — ${f.action}`)
    }
  }
  out += line()

  out += line("## Code (commits)")
  let anyCode = false
  for (const repo of repos) {
    const commits = await gitWindowCommits(repo, sinceIso, untilIso)
    const rows: string[] = []
    for (const c of commits) {
      const cf = await gitCommitFiles(repo, c.hash)
      const visible = cf.filter((p) => !isNoise(join(repo, p)))
      const codePaths = visible.filter((p) => classify(join(repo, p)) !== "doc")
      if (codePaths.length === 0) continue
      rows.push(`- ${c.hash} \`${c.subject}\` — ${keyPaths(codePaths).join(", ")}`)
    }
    if (rows.length > 0) {
      anyCode = true
      out += line(`### ${basename(repo)}`)
      for (const r of rows) out += line(r)
    }
  }
  if (!anyCode) out += line("(none)")
  out += line()

  out += line("## Staleness vs HEAD")
  const tracked = files.filter((f) => f.repo && f.action !== "deleted?")
  if (tracked.length === 0) {
    out += line("(none)")
  } else {
    const staleRows: Array<{ relpath: string; hash: string; iso: string; sid: string | null }> = []
    const identicalLines: string[] = []
    for (const f of tracked) {
      const commits = await gitLogCommitsForPath(f.repo!, f.relpath!)
      const stale = commits.filter((c) => c.ms > thresholdMs)
      if (stale.length === 0) {
        identicalLines.push(`- ${f.relpath}: BYTE-IDENTICAL`)
      } else {
        const top = stale[0]
        const later = await findLaterTouches(f.abs, parsed.sessionId, f.lastTouch)
        const sid = later.length > 0 ? later[0][0].slice(0, 8) : null
        staleRows.push({ relpath: f.relpath!, hash: top.hash, iso: top.iso, sid })
      }
    }
    const sidByHash = new Map<string, string>()
    for (const r of staleRows) if (r.sid) sidByHash.set(r.hash, r.sid)
    const changedLines = staleRows.map((r) => {
      const sid = r.sid ?? sidByHash.get(r.hash) ?? "unknown"
      return `- ${r.relpath}: CHANGED-LATER by ${r.hash} (${sid}, ${r.iso.slice(0, 10)}) — re-read needed`
    })
    for (const l of [...changedLines, ...identicalLines]) out += line(l)
  }
  out += line()

  out += line("## Non-git / scratch")
  const scratch = files.filter((f) => !f.repo)
  if (scratch.length === 0) {
    out += line("(none)")
  } else {
    for (const f of scratch) out += line(`- ${f.abs} (${f.action})`)
  }

  return out
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2)
  if (ids.length === 0) {
    const out = await report(null)
    if (out === null) process.exit(1)
    process.stdout.write(out)
    return
  }
  const reports: string[] = []
  for (const id of ids) {
    const out = await report(id)
    if (out !== null) reports.push(out)
  }
  if (reports.length === 0) process.exit(1)
  process.stdout.write(reports.join("\n---\n\n"))
}

await main()
