#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const [lock, mode, killPid, , ...paseoArgs] = process.argv.slice(2)
const logPath = process.env.PASEO_IMPORT_LOG ?? "/tmp/paseo-import/deferred.log"
mkdirSync(dirname(logPath), { recursive: true })
const log = (m: string) => appendFileSync(logPath, `[${new Date().toISOString()}] ${m}\n`)

function holders(): string[] {
  try {
    return execFileSync("lsof", ["-t", lock!], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

log(`start mode=${mode} killPid=${killPid} lock=${lock}`)

if (mode === "kill" && killPid && killPid !== "-") {
  try {
    process.kill(Number(killPid), "SIGTERM")
    log(`SIGTERM ${killPid}`)
  } catch (e) {
    log(`kill ${killPid} failed: ${(e as Error).message}`)
  }
}

const timeoutSec = mode === "kill" ? 60 : 1800
let waited = 0
while (holders().length > 0 && waited < timeoutSec) {
  Bun.sleepSync(1000)
  waited++
}

if (holders().length > 0) {
  log(`lock still held after ${timeoutSec}s; aborting import`)
  process.exit(1)
}

log(`lock free after ${waited}s; importing: paseo ${paseoArgs.join(" ")}`)
try {
  const out = execFileSync("paseo", paseoArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  log(`import ok: ${out.trim()}`)
} catch (err) {
  const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message: string }
  log(`import failed: ${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}${e.message}`)
  process.exit(1)
}
