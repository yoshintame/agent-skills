#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import {
  appendJsonl,
  byPid,
  CLAUDE_DIR,
  currentSession,
  findTranscript,
  isSession,
  KILLS_LOG,
  killSessionTrees,
  lastCustomTitle,
  mb,
  parseLine,
  type Proc,
  sleep,
  snapshot,
  STATE_DIR,
  subtree,
  tailLines,
} from "./lib.ts"

const SELF_LOG = join(STATE_DIR, "self.log")
const SELF_CAP_MS = 5 * 60_000
const SELF_RENDER_MS = 3000

function die(msg: string): never {
  process.stderr.write(`reset-sessions: ${msg}\n`)
  process.exit(1)
}

async function reset(all: boolean, dryRun: boolean) {
  const before = snapshot()
  const sessions = before.filter(isSession)
  const beforeMem = sessions.reduce((s, p) => s + p.rss, 0)

  let spare = new Set<number>()
  let mine: Proc | undefined
  if (!all) {
    mine = currentSession(before)
    if (mine) spare = subtree(before, mine.pid)
  }
  const targets = sessions.filter((p) => !spare.has(p.pid))

  console.log(`Sessions found: ${sessions.length} (${mb(beforeMem)} MB)`)
  if (mine) console.log(`Current pid=${mine.pid} + subtree (${spare.size} procs) — sparing`)
  else if (!all) console.log(`Current session not detected (running outside a session) — targeting all`)

  if (targets.length === 0) {
    console.log("Nothing to kill.")
    return
  }

  if (dryRun) {
    console.log(`\n[dry-run] Would kill ${targets.length}:`)
    for (const p of targets) console.log(`  pid=${p.pid}  ${mb(p.rss)} MB`)
    return
  }

  const result = await killSessionTrees(
    before,
    targets.map((p) => p.pid),
  )
  const stuck = new Set(result.stuck)
  const killed = targets.filter((p) => !stuck.has(p.pid))
  const freedMem = killed.reduce((s, p) => s + p.rss, 0)
  const after = snapshot().filter(isSession)
  const afterMem = after.reduce((s, p) => s + p.rss, 0)
  const ts = new Date().toISOString()
  for (const p of killed) appendJsonl(KILLS_LOG, { ts, source: "reset", pid: p.pid, rssMb: mb(p.rss) })

  console.log(
    `\nKilled: ${killed.length}/${targets.length}. Freed ~${mb(freedMem)} MB. Remaining sessions: ${after.length} (${mb(afterMem)} MB).`,
  )
  if (result.orphans.length) console.log(`Orphaned child processes killed: ${result.orphans.length}`)
  if (result.stuck.length) console.log(`Unresponsive even after SIGKILL (zombie/reparent): ${result.stuck.join(", ")}`)
}

function selfSpawn() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID
  if (!sid) {
    console.log("ok: no CLAUDE_CODE_SESSION_ID")
    return
  }
  const procs = snapshot()
  const me = currentSession(procs)
  if (!me) {
    console.log("ok: no native-binary process")
    return
  }
  const transcript = findTranscript(sid)
  if (!transcript) die(`transcript ${sid} not found in ${CLAUDE_DIR}/projects`)

  mkdirSync(STATE_DIR, { recursive: true })
  const log = openSync(SELF_LOG, "a")
  const child = spawn(
    process.execPath,
    [import.meta.path, "--self-worker", "--pid", String(me.pid), "--sid", sid, "--start", me.start, "--transcript", transcript],
    { detached: true, stdio: ["ignore", log, log] },
  )
  child.unref()
  closeSync(log)

  console.log(
    `Session ${sid.slice(0, 8)} (pid=${me.pid}, ${mb(me.rss)} MB) will be killed after end_turn while title is 🟢; cap ${SELF_CAP_MS / 60_000} min. Worker pid=${child.pid}, log ${SELF_LOG}.`,
  )
}

function turnEndedAfter(transcript: string, sinceMs: number): boolean {
  const lines = tailLines(transcript, 2 * 1024 * 1024)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"end_turn"')) continue
    const d = parseLine(lines[i])
    if (d?.type === "assistant" && d.message?.stop_reason === "end_turn" && Date.parse(d.timestamp) > sinceMs) return true
  }
  return false
}

async function selfWorker(pid: number, sid: string, start: string, transcript: string) {
  const t0 = Date.now()
  const log = (msg: string) => console.log(`${new Date().toISOString()} [${pid} ${sid.slice(0, 8)}] ${msg}`)
  log("start")

  let reason = "cap"
  while (Date.now() - t0 < SELF_CAP_MS) {
    await sleep(1000)
    if (turnEndedAfter(transcript, t0)) {
      reason = "end_turn"
      break
    }
  }
  if (reason === "end_turn") await sleep(SELF_RENDER_MS)

  const title = lastCustomTitle(transcript)
  if (!title?.startsWith("🟢")) {
    log(`abort: title=${title ?? "<none>"}`)
    return
  }
  const procs = snapshot()
  const me = byPid(procs).get(pid)
  if (!me || !isSession(me) || me.start !== start) {
    log("abort: session process gone or pid reused")
    return
  }

  const result = await killSessionTrees(procs, [pid])
  appendJsonl(KILLS_LOG, {
    ts: new Date().toISOString(),
    source: "done",
    pid,
    sid,
    rssMb: mb(me.rss),
    reason,
    orphans: result.orphans.length,
    stuck: result.stuck,
  })
  log(`killed (${reason}) rss=${mb(me.rss)} MB orphans=${result.orphans.length} stuck=${result.stuck.length}`)
}

const { values: args } = parseArgs({
  options: {
    all: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    self: { type: "boolean", default: false },
    "self-worker": { type: "boolean", default: false },
    pid: { type: "string" },
    sid: { type: "string" },
    start: { type: "string" },
    transcript: { type: "string" },
    help: { type: "boolean", default: false },
  },
})

if (args.help) {
  console.log("Usage: reset-sessions [--all] [--dry-run] [--self] [--help]")
} else if (args["self-worker"]) {
  await selfWorker(Number(args.pid), String(args.sid), String(args.start), String(args.transcript))
} else if (args.self) {
  selfSpawn()
} else {
  await reset(args.all, args["dry-run"])
}
