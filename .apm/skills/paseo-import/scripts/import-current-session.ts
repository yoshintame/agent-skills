#!/usr/bin/env bun
import { execFileSync } from "node:child_process"

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

try {
  process.stdout.write(execFileSync("paseo", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))
} catch (err) {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message: string }
  const out = `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`
  process.stderr.write(out || `${e.message}\n`)
  if (provider === "codex" && /transport closed|connect to daemon|6767/i.test(out)) {
    process.stderr.write("paseo-import: Codex sandboxes network — re-run with escalated permissions (the daemon is already up)\n")
  }
  process.exit(1)
}
