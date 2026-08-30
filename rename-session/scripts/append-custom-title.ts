#!/usr/bin/env bun
import { closeSync, existsSync, openSync, readdirSync, statSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

const STATUS_EMOJI = { active: "🔴", paused: "🟡", done: "🟢" } as const
type Status = keyof typeof STATUS_EMOJI

const SEGMENT_REGEX = /^[a-z0-9-]+$/
const COMPOSITE_REGEX = /^(🔴|🟡|🟢) ([a-z0-9-]+\/)?[a-z0-9-]+$/u
const MAX_VISIBLE_LEN = 80

function die(msg: string): never {
  process.stderr.write(`rename-session: ${msg}\n`)
  process.exit(1)
}

function isStatus(v: unknown): v is Status {
  return v === "active" || v === "paused" || v === "done"
}

function parseArgs(argv: readonly string[]): { status: Status; title: string } {
  let status: Status = "active"
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--status") {
      const value = argv[++i]
      if (!isStatus(value)) die(`--status must be active|paused|done, got ${JSON.stringify(value)}`)
      status = value
    } else if (arg.startsWith("--status=")) {
      const value = arg.slice("--status=".length)
      if (!isStatus(value)) die(`--status must be active|paused|done, got ${JSON.stringify(value)}`)
      status = value
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: append-custom-title.ts [--status active|paused|done] <[prefix/]kebab-title>\n",
      )
      process.exit(0)
    } else if (arg.startsWith("-")) {
      die(`unknown flag ${JSON.stringify(arg)}`)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length === 0) die("missing positional title: [<prefix>/]<kebab-title>")
  if (positional.length > 1) {
    die(`expected single positional title, got ${positional.length}: ${positional.join(" ")}`)
  }
  return { status, title: positional[0]! }
}

function validateTitle(raw: string): void {
  if (raw.length === 0) die("title must not be empty")
  const parts = raw.split("/")
  if (parts.length > 2) die(`title may contain at most one '/' separator: ${JSON.stringify(raw)}`)
  for (const part of parts) {
    if (!SEGMENT_REGEX.test(part)) {
      die(`segment ${JSON.stringify(part)} must match [a-z0-9-]+ (lowercase kebab-case)`)
    }
  }
}

function hashCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

function discoverJsonl(): string {
  const projectsRoot = join(homedir(), ".claude", "projects")
  if (!existsSync(projectsRoot)) die(`projects root not found: ${projectsRoot}`)
  const cwdDir = join(projectsRoot, hashCwd(process.cwd()))
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID

  if (sessionId) {
    const direct = join(cwdDir, `${sessionId}.jsonl`)
    if (existsSync(direct)) return direct
    for (const project of readdirSync(projectsRoot)) {
      const candidate = join(projectsRoot, project, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
    die(
      `CLAUDE_CODE_SESSION_ID=${sessionId} set, but ${sessionId}.jsonl not found under ${projectsRoot}`,
    )
  }

  if (!existsSync(cwdDir)) {
    die(
      `no project dir for cwd ${process.cwd()} (expected ${cwdDir}); set CLAUDE_CODE_SESSION_ID or run from the session's cwd`,
    )
  }
  const candidates = readdirSync(cwdDir)
    .filter(name => name.endsWith(".jsonl"))
    .map(name => {
      const full = join(cwdDir, name)
      return { full, mtimeMs: statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (candidates.length === 0) die(`no .jsonl files in ${cwdDir}`)
  return candidates[0]!.full
}

function appendCustomTitle(jsonl: string, sessionId: string, customTitle: string): void {
  const line = `${JSON.stringify({ type: "custom-title", sessionId, customTitle })}\n`
  const fd = openSync(jsonl, "a")
  try {
    writeSync(fd, line)
  } finally {
    closeSync(fd)
  }
}

const { status, title } = parseArgs(process.argv.slice(2))
validateTitle(title)
const customTitle = `${STATUS_EMOJI[status]} ${title}`
if (!COMPOSITE_REGEX.test(customTitle)) {
  die(`composed name failed final regex check: ${JSON.stringify(customTitle)}`)
}
const visibleLen = [...customTitle].length
if (visibleLen > MAX_VISIBLE_LEN) {
  die(`composed name length ${visibleLen} > ${MAX_VISIBLE_LEN}: ${JSON.stringify(customTitle)}`)
}

const jsonlPath = discoverJsonl()
const sessionId = basename(jsonlPath, ".jsonl")
appendCustomTitle(jsonlPath, sessionId, customTitle)
process.stdout.write(`${customTitle}\n`)
