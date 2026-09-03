import { execSync } from "node:child_process"
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const HOME = homedir()
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude")
export const STATE_DIR = join(HOME, ".local", "state", "cc-reaper")
export const KILLS_LOG = join(STATE_DIR, "kills.jsonl")

export const SESSION_RE = /anthropic\.claude-code.*native-binary/

export type Proc = { pid: number; ppid: number; rss: number; etime: number; start: string; cmd: string }

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/

export const mb = (kb: number) => Math.round(kb / 1024)
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function parseEtime(s: string): number {
  const [days, clock] = s.includes("-") ? s.split("-") : ["0", s]
  const parts = clock.split(":").map(Number)
  const [h, m, sec] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0]
  return ((Number(days) * 24 + h) * 60 + m) * 60 + sec
}

export function snapshot(): Proc[] {
  const out = execSync("ps -axo pid=,ppid=,rss=,etime=,lstart=,command=", {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const procs: Proc[] = []
  for (const line of out.split("\n")) {
    const m = line.match(PS_LINE)
    if (m) procs.push({ pid: +m[1], ppid: +m[2], rss: +m[3], etime: parseEtime(m[4]), start: m[5], cmd: m[6] })
  }
  return procs
}

export const isSession = (p: Proc) => SESSION_RE.test(p.cmd)

export const byPid = (procs: Proc[]) => new Map(procs.map((p) => [p.pid, p]))

export function findAncestor(procs: Proc[], start: number): Proc | undefined {
  const map = byPid(procs)
  const seen = new Set<number>()
  let cur = map.get(start)
  while (cur && cur.pid > 1 && !seen.has(cur.pid)) {
    seen.add(cur.pid)
    if (isSession(cur)) return cur
    cur = map.get(cur.ppid)
  }
  return undefined
}

export function currentSession(procs: Proc[]): Proc | undefined {
  const envPid = Number(process.env.CLAUDE_PID)
  if (envPid) {
    const p = byPid(procs).get(envPid)
    if (p && isSession(p)) return p
  }
  return findAncestor(procs, process.pid)
}

export function children(procs: Proc[], pid: number): Proc[] {
  return procs.filter((p) => p.ppid === pid)
}

export function subtree(procs: Proc[], root: number): Set<number> {
  const kids = new Map<number, number[]>()
  for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p.pid)
  const out = new Set<number>([root])
  const stack = [root]
  while (stack.length) {
    for (const c of kids.get(stack.pop()!) ?? []) {
      if (!out.has(c)) {
        out.add(c)
        stack.push(c)
      }
    }
  }
  return out
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig)
  } catch {}
}

export async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const end = Date.now() + ms
  let alive = pids
  while (alive.length && Date.now() < end) {
    await sleep(250)
    const live = new Set(snapshot().map((p) => p.pid))
    alive = alive.filter((pid) => live.has(pid))
  }
  return alive
}

export type KillResult = { killed: number[]; stuck: number[] }

export async function killGracefully(pids: number[], termMs = 3000, killMs = 2000): Promise<KillResult> {
  if (!pids.length) return { killed: [], stuck: [] }
  for (const pid of pids) signal(pid, "SIGTERM")
  let alive = await waitGone(pids, termMs)
  if (alive.length) {
    for (const pid of alive) signal(pid, "SIGKILL")
    alive = await waitGone(alive, killMs)
  }
  const stuck = new Set(alive)
  return { killed: pids.filter((p) => !stuck.has(p)), stuck: alive }
}

export type TreeKillResult = KillResult & { orphans: number[] }

export async function killSessionTrees(procs: Proc[], roots: number[]): Promise<TreeKillResult> {
  const map = byPid(procs)
  const members = new Set<number>()
  for (const root of roots) for (const pid of subtree(procs, root)) members.add(pid)
  const result = await killGracefully(roots)
  const live = byPid(snapshot())
  const orphans = [...members].filter((pid) => !roots.includes(pid) && live.get(pid)?.start === map.get(pid)?.start)
  if (orphans.length) await killGracefully(orphans, 2000, 1000)
  return { ...result, orphans }
}

export type RegistryEntry = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  kind?: string
  entrypoint?: string
}

const REGISTRY_DIR = join(CLAUDE_DIR, "sessions")

export function registryEntry(pid: number): RegistryEntry | undefined {
  try {
    return JSON.parse(readFileSync(join(REGISTRY_DIR, `${pid}.json`), "utf8"))
  } catch {
    return undefined
  }
}

export function registryEntries(): RegistryEntry[] {
  if (!existsSync(REGISTRY_DIR)) return []
  return readdirSync(REGISTRY_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => registryEntry(Number(f.slice(0, -5))))
    .filter((e): e is RegistryEntry => e !== undefined)
}

export const argvSid = (p: Proc) => p.cmd.match(/--resume[= ]([0-9a-f-]{36})/)?.[1]

export function sessionSid(p: Proc, now = Date.now()): string | undefined {
  const entry = registryEntry(p.pid)
  if (entry?.sessionId && Math.abs(entry.startedAt - (now - p.etime * 1000)) < 15_000) return entry.sessionId
  return argvSid(p)
}

export function findTranscript(sid: string): string | undefined {
  const root = join(CLAUDE_DIR, "projects")
  if (!existsSync(root)) return undefined
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, `${sid}.jsonl`)
    if (existsSync(file)) return file
  }
  return undefined
}

export function tailText(path: string, bytes: number): string {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString("utf8")
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1)
  } finally {
    closeSync(fd)
  }
}

export const tailLines = (path: string, bytes: number) => tailText(path, bytes).split("\n").filter(Boolean)

export function parseLine(line: string): Record<string, any> | undefined {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

export function lastCustomTitle(path: string): string | undefined {
  const lines = tailLines(path, 2 * 1024 * 1024)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"custom-title"')) continue
    const d = parseLine(lines[i])
    if (d?.type === "custom-title" && typeof d.customTitle === "string") return d.customTitle
  }
  return undefined
}

export function appendJsonl(path: string, record: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(record)}\n`)
}
