#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { join } from "node:path"
import { defineCommand, runMain } from "citty"
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

  console.log(`Сессий найдено: ${sessions.length} (${mb(beforeMem)} MB)`)
  if (mine) console.log(`Текущая pid=${mine.pid} + поддерево (${spare.size} проц.) — щажу`)
  else if (!all) console.log(`Текущая сессия не определена (запуск вне сессии) — под нож все`)

  if (targets.length === 0) {
    console.log("Нечего убивать.")
    return
  }

  if (dryRun) {
    console.log(`\n[dry-run] Убил бы ${targets.length}:`)
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
    `\nУбито: ${killed.length}/${targets.length}. Освобождено ~${mb(freedMem)} MB. Осталось сессий: ${after.length} (${mb(afterMem)} MB).`,
  )
  if (result.orphans.length) console.log(`Добиты осиротевшие дочерние процессы: ${result.orphans.length}`)
  if (result.stuck.length) console.log(`Не отозвались даже на SIGKILL (зомби/reparent): ${result.stuck.join(", ")}`)
}

function selfSpawn() {
  const procs = snapshot()
  const me = currentSession(procs)
  const sid = process.env.CLAUDE_CODE_SESSION_ID
  if (!me || !sid) die("не внутри сессии Claude Code: нужны CLAUDE_PID/CLAUDE_CODE_SESSION_ID или предок native-binary")
  const transcript = findTranscript(sid)
  if (!transcript) die(`транскрипт ${sid} не найден в ${CLAUDE_DIR}/projects`)

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
    `Сессия ${sid.slice(0, 8)} (pid=${me.pid}, ${mb(me.rss)} MB) будет убита после конца хода, пока титул 🟢; кап ${SELF_CAP_MS / 60_000} мин. Worker pid=${child.pid}, лог ${SELF_LOG}.`,
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
    log("abort: процесс сессии ушёл или pid переиспользован")
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

const main = defineCommand({
  meta: {
    name: "reset-sessions",
    description: "Гасит процессы сессий Claude Code (VSCode-расширение): все, кроме текущей, или собственную после конца хода.",
  },
  args: {
    all: { type: "boolean", default: false, description: "Не щадить текущую сессию (запуск вне сессии)" },
    "dry-run": { type: "boolean", default: false, description: "Показать цели, ничего не трогая" },
    self: {
      type: "boolean",
      default: false,
      description: "Убить собственную сессию после конца хода, если титул 🟢 (последний шаг /done)",
    },
    "self-worker": { type: "boolean", default: false, description: "Внутренний режим: отцепленный worker для --self" },
    pid: { type: "string", description: "(self-worker) pid процесса сессии" },
    sid: { type: "string", description: "(self-worker) id сессии" },
    start: { type: "string", description: "(self-worker) lstart процесса сессии" },
    transcript: { type: "string", description: "(self-worker) путь к JSONL сессии" },
  },
  async run({ args }) {
    if (args["self-worker"]) return selfWorker(Number(args.pid), String(args.sid), String(args.start), String(args.transcript))
    if (args.self) return selfSpawn()
    return reset(args.all, args["dry-run"])
  },
})

runMain(main)
