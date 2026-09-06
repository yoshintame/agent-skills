#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

function die(msg: string): never {
  process.stderr.write(`paseo-import: ${msg}\n`)
  process.exit(1)
}

const claudeId = process.env.CLAUDE_CODE_SESSION_ID
const codexId = process.env.CODEX_SESSION_ID

let provider: "claude" | "codex"
let id: string
if (claudeId) {
  provider = "claude"
  id = claudeId
} else if (codexId) {
  provider = "codex"
  id = codexId
} else {
  die("no CLAUDE_CODE_SESSION_ID or CODEX_SESSION_ID in env — run this from inside a Claude Code or Codex session")
}

const cwd = process.cwd()
const dryRun = process.argv.includes("--dry-run")
const passthrough = process.argv.slice(2).filter((a) => a !== "--dry-run")
const args = ["import", id, "--provider", provider, "--cwd", cwd, ...passthrough]

if (dryRun) {
  process.stdout.write(`paseo ${args.join(" ")}\n`)
  process.exit(0)
}

function lsofPids(path: string): string[] {
  try {
    return execFileSync("lsof", ["-t", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function locksHeldBy(pid: string, lockDir: string): number {
  try {
    const out = execFileSync("lsof", ["-p", pid, "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return out.split("\n").filter((l) => l.startsWith("n") && l.includes(lockDir) && l.endsWith(".lock")).length
  } catch {
    return 99
  }
}

function scheduleDeferredImport(): never {
  const lock = join(homedir(), ".codex", "thread-writer-locks", `${id}.lock`)
  const holders = lsofPids(lock)
  let mode: "kill" | "wait" = "wait"
  let killPid = "-"
  if (holders.length === 1 && locksHeldBy(holders[0]!, dirname(lock)) <= 1) {
    mode = "kill"
    killPid = holders[0]!
  }
  const logPath = `/tmp/paseo-import/${id}.log`
  const helper = join(import.meta.dir, "deferred-import.ts")
  spawn(process.execPath, [helper, lock, mode, killPid, "--", ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PASEO_IMPORT_LOG: logPath },
  }).unref()
  const tail = `A detached helper will import once the lock frees. Log: ${logPath}`
  process.stdout.write(
    mode === "kill"
      ? `paseo-import: terminating the dedicated Codex process (pid ${killPid}) holding this thread; this session will end. ${tail}\n`
      : `paseo-import: thread held by a shared Codex app-server (pids ${holders.join(",") || "unknown"}) — not killing it, close this session in Codex yourself. ${tail}\n`,
  )
  process.exit(0)
}

try {
  process.stdout.write(execFileSync("paseo", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
} catch (err) {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message: string }
  const out = `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`
  if (provider === "codex" && /already has an active writer/i.test(out)) {
    scheduleDeferredImport()
  }
  process.stderr.write(out || `${e.message}\n`)
  if (provider === "codex" && /transport closed|connect to daemon|6767/i.test(out)) {
    process.stderr.write("paseo-import: Codex sandboxes network — re-run with escalated permissions (the daemon is already up)\n")
  }
  process.exit(1)
}
