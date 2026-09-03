#!/usr/bin/env bun
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { defineCommand, runMain } from "citty"
import {
  appendJsonl,
  children,
  CLAUDE_DIR,
  currentSession,
  findTranscript,
  isSession,
  KILLS_LOG,
  killSessionTrees,
  mb,
  parseLine,
  type Proc,
  sessionSid,
  snapshot,
  subtree,
  tailLines,
} from "./lib.ts"

const SCHEDULED_TASKS = join(CLAUDE_DIR, "scheduled_tasks.json")
const SIDECAR_WINDOW_S = 120
const LOOP_GRACE_MS = 10 * 60_000

type Verdict = { proc: Proc; sid?: string; idleMin?: number; kill: boolean; reason: string }

function lastActivityMs(transcript: string): number {
  let t = statSync(transcript).mtimeMs
  const dir = transcript.slice(0, -".jsonl".length)
  if (!existsSync(dir)) return t
  t = Math.max(t, statSync(dir).mtimeMs)
  for (const sub of readdirSync(dir)) {
    const path = join(dir, sub)
    const st = statSync(path)
    t = Math.max(t, st.mtimeMs)
    if (st.isDirectory()) for (const f of readdirSync(path)) t = Math.max(t, statSync(join(path, f)).mtimeMs)
  }
  return t
}

const busyChildren = (procs: Proc[], session: Proc) =>
  children(procs, session.pid).filter((c) => c.etime < session.etime - SIDECAR_WINDOW_S)

function loopWaiting(transcript: string, now: number): string | undefined {
  const lines = tailLines(transcript, 2 * 1024 * 1024)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("ScheduleWakeup")) continue
    const d = parseLine(lines[i])
    if (d?.type !== "assistant") continue
    const call = (d.message?.content ?? []).find((b: any) => b.type === "tool_use" && b.name === "ScheduleWakeup")
    if (!call) continue
    if (call.input?.stop === true) return undefined
    const delay = Math.min(3600, Math.max(60, Number(call.input?.delaySeconds) || 60))
    const until = Date.parse(d.timestamp) + delay * 1000 + LOOP_GRACE_MS
    return now < until ? `loop: wakeup через ${Math.round((until - now) / 60_000)} мин` : undefined
  }
  return undefined
}

async function artifactWatchOpen(transcript: string): Promise<boolean> {
  let open = 0
  const rl = createInterface({ input: createReadStream(transcript), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"Artifact"')) continue
    const d = parseLine(line)
    if (d?.type !== "assistant") continue
    for (const b of d.message?.content ?? []) {
      if (b.type !== "tool_use" || b.name !== "Artifact") continue
      const action = b.input?.action ?? "publish"
      if (action === "publish" || action === "watch") open++
      else if (action === "unwatch") open = Math.max(0, open - 1)
    }
  }
  return open > 0
}

function cronScheduled(sid: string): boolean {
  try {
    return readFileSync(SCHEDULED_TASKS, "utf8").includes(sid)
  } catch {
    return false
  }
}

const summarize = (c: Proc) => `${c.pid}:${c.cmd.split(" ")[0].split("/").pop()}`

async function judge(procs: Proc[], p: Proc, spare: Set<number>, idleMs: number, now: number): Promise<Verdict> {
  const skip = (reason: string, extra: Partial<Verdict> = {}): Verdict => ({ proc: p, kill: false, reason, ...extra })
  if (spare.has(p.pid)) return skip("own session")
  const sid = sessionSid(p, now)
  if (!sid) return skip("no pid→sid mapping")
  const transcript = findTranscript(sid)
  if (!transcript) return skip("no transcript", { sid })
  const procStart = now - p.etime * 1000
  const idle = now - Math.max(lastActivityMs(transcript), procStart)
  const idleMin = Math.round(idle / 60_000)
  if (idle < idleMs) return skip(`active ${idleMin}m ago`, { sid, idleMin })
  const busy = busyChildren(procs, p)
  if (busy.length) return skip(`busy: ${busy.map(summarize).join(", ")}`, { sid, idleMin })
  const loop = loopWaiting(transcript, now)
  if (loop) return skip(loop, { sid, idleMin })
  if (cronScheduled(sid)) return skip("cron task scheduled", { sid, idleMin })
  if (await artifactWatchOpen(transcript)) return skip("artifact watch open", { sid, idleMin })
  return { proc: p, sid, idleMin, kill: true, reason: `idle ${idleMin}m` }
}

async function reap(idleMinutes: number, dryRun: boolean, verbose: boolean) {
  const now = Date.now()
  const procs = snapshot()
  const sessions = procs.filter(isSession)
  const me = currentSession(procs)
  const spare = me ? subtree(procs, me.pid) : new Set<number>()

  const verdicts: Verdict[] = []
  for (const p of sessions) verdicts.push(await judge(procs, p, spare, idleMinutes * 60_000, now))
  const targets = verdicts.filter((v) => v.kill)

  if (dryRun || verbose) {
    console.log(`${new Date(now).toISOString()} sessions=${sessions.length} threshold=${idleMinutes}m${dryRun ? " [dry-run]" : ""}`)
    for (const v of verdicts) {
      const tag = v.kill ? "KILL" : "keep"
      console.log(`  ${tag} pid=${v.proc.pid} ${mb(v.proc.rss)}MB sid=${v.sid?.slice(0, 8) ?? "-"} ${v.reason}`)
    }
  }
  if (!targets.length || dryRun) return

  const result = await killSessionTrees(
    procs,
    targets.map((v) => v.proc.pid),
  )
  const stuck = new Set(result.stuck)
  const ts = new Date().toISOString()
  let freed = 0
  for (const v of targets) {
    if (stuck.has(v.proc.pid)) continue
    freed += v.proc.rss
    appendJsonl(KILLS_LOG, {
      ts,
      source: "reaper",
      pid: v.proc.pid,
      sid: v.sid,
      idleMin: v.idleMin,
      rssMb: mb(v.proc.rss),
    })
  }
  console.log(
    `${ts} killed ${targets.length - stuck.size}/${targets.length} (${mb(freed)} MB): ${targets
      .map((v) => `${v.sid?.slice(0, 8)}@${v.proc.pid}`)
      .join(" ")}${result.orphans.length ? ` orphans=${result.orphans.length}` : ""}${stuck.size ? ` stuck=${[...stuck].join(",")}` : ""}`,
  )
}

const main = defineCommand({
  meta: {
    name: "session-reaper",
    description: "Гасит простаивающие процессы сессий Claude Code (VSCode-расширение) по порогу простоя.",
  },
  args: {
    "idle-minutes": { type: "string", default: "15", description: "Порог простоя в минутах" },
    "dry-run": { type: "boolean", default: false, description: "Показать вердикты, ничего не трогая" },
    verbose: { type: "boolean", default: false, description: "Печатать вердикт по каждой сессии" },
  },
  run({ args }) {
    const idle = Number(args["idle-minutes"])
    if (!Number.isFinite(idle) || idle <= 0) throw new Error(`--idle-minutes: ожидалось положительное число, получено ${args["idle-minutes"]}`)
    return reap(idle, args["dry-run"], args.verbose)
  },
})

runMain(main)
