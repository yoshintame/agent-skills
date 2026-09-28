#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { defineCommand, runMain } from 'citty@0.2.2'
import $ from 'dax-sh@0.42.0'
import { z } from 'zod@4.6.5'

$.setPrintCommand(false)

const cacheRoot = process.env.GIT_REF_CACHE ?? join(homedir(), '.cache', 'git-ref')
const staleMs = 7 * 24 * 60 * 60 * 1000
const startupTimeoutMs = 30_000
const commitSlackMs = 3000
const nullSha = '0'.repeat(40)

const State = z.object({
  pid: z.number(),
  port: z.number(),
  url: z.string(),
  base: z.string(),
  head: z.string(),
  createdAt: z.number(),
})
type State = z.infer<typeof State>

const Result = z.object({
  decision: z.enum(['approved', 'annotated', 'dismissed']),
  message: z.string(),
})

type Target =
  | { kind: 'range'; base: string; head: string; label: string }
  | { kind: 'set'; commits: string[] }

type Entry = { mode: string; blob: string } | null

function fail(message: string): never {
  process.stderr.write(`git-ref: ${message}\n`)
  process.exit(1)
}

function git(cwd: string, env: Record<string, string> = {}) {
  return (args: string[], stdin?: string) => {
    const cmd = $`git -C ${cwd} ${args}`.env({ GIT_LITERAL_PATHSPECS: '1', ...env })
    return (stdin === undefined ? cmd : cmd.stdinText(stdin)).text()
  }
}

function nulSplit(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readState(dir: string): State | undefined {
  const path = join(dir, 'state.json')
  if (!existsSync(path)) return undefined
  const parsed = State.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  return parsed.success ? parsed.data : undefined
}

async function responds(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const port = server.port
  server.stop(true)
  if (port === undefined) fail('could not allocate a free port')
  return port
}

async function plannotatorBin(): Promise<string> {
  const onPath = Bun.which('plannotator')
  if (onPath) return onPath
  const viaMise = await $`mise which plannotator`.noThrow().quiet().text()
  if (viaMise) return viaMise
  fail('plannotator not found on PATH or via `mise which plannotator`')
}

async function resolveCommit(repo: string, ref: string): Promise<string> {
  const sha = await $`git -C ${repo} rev-parse --verify --quiet --end-of-options ${`${ref}^{commit}`}`.noThrow().text()
  if (!sha) fail(`not a commit in ${repo}: ${ref}`)
  return sha
}

async function parseTarget(repo: string, specs: string[]): Promise<Target> {
  if (specs.length === 1 && /^\d+$/.test(specs[0])) {
    const n = Number(specs[0])
    if (n < 1) fail('N must be positive')
    return { kind: 'range', base: await resolveCommit(repo, `HEAD~${n}`), head: await resolveCommit(repo, 'HEAD'), label: `HEAD~${n}..HEAD` }
  }
  const range = specs.length === 1 ? /^(.+?)(\.\.\.?)(.+)$/.exec(specs[0]) : null
  if (range) {
    const [, from, dots, to] = range
    const head = await resolveCommit(repo, to)
    const fromSha = await resolveCommit(repo, from)
    const base = dots === '...' ? await git(repo)(['merge-base', fromSha, head]) : fromSha
    return { kind: 'range', base, head, label: specs[0] }
  }
  return { kind: 'set', commits: await Promise.all(specs.map((s) => resolveCommit(repo, s))) }
}

type CommitCall = { command: string; startMs: number; endMs: number }

async function sessionTranscripts(sessionId: string): Promise<string[]> {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  for await (const main of new Bun.Glob(`*/${sessionId}.jsonl`).scan({ cwd: projects, absolute: true })) {
    const paths = [main]
    const subagents = join(dirname(main), basename(main, '.jsonl'), 'subagents')
    if (existsSync(subagents)) {
      for await (const p of new Bun.Glob('**/*.jsonl').scan({ cwd: subagents, absolute: true })) paths.push(p)
    }
    return paths
  }
  fail(`no Claude Code transcript for session ${sessionId}`)
}

async function sessionCommitCalls(sessionId: string): Promise<CommitCall[]> {
  const open = new Map<string, { command: string; startMs: number }>()
  const calls: CommitCall[] = []
  for (const path of await sessionTranscripts(sessionId)) {
    for (const line of (await Bun.file(path).text()).split('\n')) {
      let rec: any
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      const ms = Date.parse(rec?.timestamp ?? '')
      const content = rec?.message?.content
      if (Number.isNaN(ms) || !Array.isArray(content)) continue
      for (const item of content) {
        if (rec.type === 'assistant' && item?.type === 'tool_use' && item.name === 'Bash' && /commit/.test(item.input?.command ?? '')) {
          open.set(item.id, { command: item.input.command, startMs: ms })
        } else if (rec.type === 'user' && item?.type === 'tool_result' && open.has(item.tool_use_id)) {
          calls.push({ ...open.get(item.tool_use_id)!, endMs: ms })
          open.delete(item.tool_use_id)
        }
      }
    }
  }
  return calls
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

async function sessionCommits(repo: string, sessionId: string): Promise<string[]> {
  const calls = await sessionCommitCalls(sessionId)
  if (calls.length === 0) fail(`session ${sessionId} ran no commit commands`)
  const since = new Date(Math.min(...calls.map((c) => c.startMs)) - commitSlackMs).toISOString()
  const log = await git(repo)(['log', `--since=${since}`, '--format=%H%x09%ct%x09%s', 'HEAD'])
  const matched = log
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([, ct, subject]) => {
      const ms = Number(ct) * 1000
      const needle = normalize(subject)
      return needle !== '' && calls.some((c) => ms >= c.startMs - commitSlackMs && ms <= c.endMs + commitSlackMs && normalize(c.command).includes(needle))
    })
    .map(([sha]) => sha)
  if (matched.length === 0) fail(`no commits on HEAD of ${repo} match session ${sessionId}; pass the SHAs explicitly`)
  return matched
}

async function orderSet(repo: string, commits: string[]): Promise<string[]> {
  const g = git(repo)
  const unique = [...new Set(commits)]
  const tips = (await g(['merge-base', '--independent', ...unique])).split('\n').filter(Boolean)
  if (tips.length !== 1) fail(`commits do not lie on one line of history (tips: ${tips.map((t) => t.slice(0, 12)).join(', ')})`)
  const oldest = await g(['merge-base', '--octopus', ...unique])
  const walk = (await g(['rev-list', '--reverse', '--topo-order', tips[0], '--not', `${oldest}^@`])).split('\n')
  const wanted = new Set(unique)
  return walk.filter((sha) => wanted.has(sha))
}

async function lsTree(g: ReturnType<typeof git>, rev: string, files: string[]): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>(files.map((f) => [f, null]))
  for (const record of nulSplit(await g(['ls-tree', '-z', '--full-tree', rev, '--', ...files]))) {
    const tab = record.indexOf('\t')
    const [mode, , blob] = record.slice(0, tab).split(' ')
    entries.set(record.slice(tab + 1), { mode, blob })
  }
  return entries
}

async function entriesAt(g: ReturnType<typeof git>, revOf: Map<string, string>): Promise<Map<string, Entry>> {
  const byRev = new Map<string, string[]>()
  for (const [file, rev] of revOf) byRev.set(rev, [...(byRev.get(rev) ?? []), file])
  const result = new Map<string, Entry>()
  for (const [rev, files] of byRev) for (const [f, e] of await lsTree(g, rev, files)) result.set(f, e)
  return result
}

async function buildTree(clone: string, parent: string, entries: Map<string, Entry>, indexFile: string): Promise<string> {
  const g = git(clone, { GIT_INDEX_FILE: indexFile })
  await g(['read-tree', parent])
  const info = [...entries].map(([f, e]) => (e ? `${e.mode} ${e.blob}\t${f}` : `0 ${nullSha}\t${f}`)).join('\0')
  await g(['update-index', '-z', '--index-info'], `${info}\0`)
  const tree = await g(['write-tree'])
  rmSync(indexFile, { force: true })
  return tree
}

async function synthesize(clone: string, dir: string, commits: string[]) {
  const g = git(clone)
  const parent = await $`git -C ${clone} rev-parse --verify --quiet ${`${commits[0]}^`}`.noThrow().text()
  if (!parent) fail(`cannot review from a root commit: ${commits[0]}`)
  const touched = new Map<string, string[]>()
  for (const c of commits) {
    for (const f of nulSplit(await g(['diff-tree', '--no-commit-id', '-r', '--name-only', '-z', `${c}^`, c]))) {
      touched.set(f, [...(touched.get(f) ?? []), c])
    }
  }
  const oldRev = new Map([...touched].map(([f, cs]) => [f, `${cs[0]}^`]))
  const newRev = new Map([...touched].map(([f, cs]) => [f, cs.at(-1)!]))
  const inSet = new Set(commits)
  const interleaved: Array<{ file: string; foreign: string[] }> = []
  for (const [file, cs] of touched) {
    if (cs.length < 2) continue
    const between = (await g(['rev-list', `${cs[0]}^..${cs.at(-1)}`, '--', file])).split('\n').filter((sha) => sha && !inSet.has(sha))
    if (between.length > 0) interleaved.push({ file, foreign: between })
  }
  const tip = commits.at(-1)!
  const date = await g(['show', '-s', '--format=%cI', tip])
  const identity = {
    GIT_AUTHOR_NAME: 'git-ref',
    GIT_AUTHOR_EMAIL: 'git-ref@localhost',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'git-ref',
    GIT_COMMITTER_EMAIL: 'git-ref@localhost',
    GIT_COMMITTER_DATE: date,
  }
  const commitTree = git(clone, identity)
  const baseTree = await buildTree(clone, parent, await entriesAt(g, oldRev), join(dir, 'base.idx'))
  const headTree = await buildTree(clone, parent, await entriesAt(g, newRev), join(dir, 'head.idx'))
  const oneline = await g(['log', '--no-walk=unsorted', '--format=%h %s', ...commits])
  const base = await commitTree(['commit-tree', baseTree, '-p', parent], 'git-ref review base\n')
  const head = await commitTree(['commit-tree', headTree, '-p', base], `git-ref review: ${commits.length} commits\n\n${oneline}\n`)
  return { base, head, interleaved }
}

function reviewDir(root: string, key: string): string {
  const repoKey = `${basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`
  return join(cacheRoot, repoKey, key)
}

function removeReview(dir: string) {
  rmSync(dir, { recursive: true, force: true })
  if (readdirSync(dirname(dir)).length === 0) rmSync(dirname(dir), { recursive: true })
}

function prune() {
  if (!existsSync(cacheRoot)) return
  for (const repoKey of readdirSync(cacheRoot)) {
    for (const key of readdirSync(join(cacheRoot, repoKey))) {
      const dir = join(cacheRoot, repoKey, key)
      const state = readState(dir)
      if (!state || Date.now() - state.createdAt < staleMs) continue
      if (isAlive(state.pid)) process.kill(state.pid)
      removeReview(dir)
    }
  }
}

const open = defineCommand({
  meta: { name: 'open', description: 'Build the review checkout and serve it with Plannotator' },
  args: {
    repo: { type: 'string', alias: 'C', description: 'Repository (default: cwd)', default: '.' },
    session: { type: 'string', description: 'Review commits made by this Claude Code session ("current" for this one)' },
    targets: { type: 'positional', required: false, description: 'SHAs/refs, A..B, A...B, or N' },
  },
  async run({ args }) {
    prune()
    const root = await git(args.repo)(['rev-parse', '--show-toplevel'])
    const specs = args._.map(String)
    let target: Target
    if (args.session !== undefined) {
      if (specs.length > 0) fail('--session takes no other targets')
      const id = args.session === 'current' || args.session === '' ? process.env.CLAUDE_CODE_SESSION_ID : args.session
      if (!id) fail('--session current needs CLAUDE_CODE_SESSION_ID; pass the SHAs explicitly')
      target = { kind: 'set', commits: await sessionCommits(root, id) }
    } else if (specs.length > 0) {
      target = await parseTarget(root, specs)
    } else {
      fail('nothing to review: pass SHAs, A..B, A...B, N, or --session current')
    }
    if (target.kind === 'set') target.commits = await orderSet(root, target.commits)

    const identity = target.kind === 'range' ? `range ${target.base} ${target.head}` : `set ${target.commits.join(' ')}`
    const dir = reviewDir(root, createHash('sha256').update(identity).digest('hex').slice(0, 12))
    const clone = join(dir, basename(root))
    const running = readState(dir)
    if (running && isAlive(running.pid) && (await responds(running.url))) {
      process.stdout.write(`url: ${running.url}\nreview: ${dir}\nrange: ${running.base}..${running.head}\nreused: true\n`)
      return
    }

    mkdirSync(dir, { recursive: true })
    if (!existsSync(join(clone, '.git'))) await $`git clone --quiet --shared --no-checkout ${root} ${clone}`
    let base: string
    let head: string
    let interleaved: Array<{ file: string; foreign: string[] }> = []
    if (target.kind === 'range') {
      ;({ base, head } = target)
    } else {
      ;({ base, head, interleaved } = await synthesize(clone, dir, target.commits))
    }
    const g = git(clone)
    await g(['update-ref', 'refs/review/base', base])
    await g(['checkout', '--quiet', '--force', '--detach', head])

    const port = freePort()
    const url = `http://localhost:${port}`
    const resultFile = join(dir, 'result.json')
    const child = spawn(
      await plannotatorBin(),
      ['review', '--git', '--base', 'refs/review/base', '--diff-type', 'branch', '--no-git-remote-check', '--json'],
      {
        cwd: clone,
        detached: true,
        stdio: ['ignore', openSync(resultFile, 'w'), openSync(join(dir, 'plannotator.log'), 'w')],
        env: {
          ...process.env,
          PLANNOTATOR_BROWSER: '/usr/bin/true',
          PLANNOTATOR_AI: 'disabled',
          PLANNOTATOR_PORT: String(port),
          PLANNOTATOR_GIT_REMOTE_CHECK: '0',
        },
      },
    )
    child.unref()
    if (child.pid === undefined) fail('failed to start plannotator')
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ pid: child.pid, port, url, base, head, createdAt: Date.now() } satisfies State))

    const deadline = Date.now() + startupTimeoutMs
    while (!(await responds(url))) {
      if (!isAlive(child.pid) || Date.now() > deadline) {
        fail(`plannotator did not come up on ${url}; log: ${join(dir, 'plannotator.log')}`)
      }
      await Bun.sleep(200)
    }

    const stat = await g(['diff', '--shortstat', base, head])
    const lines = [`url: ${url}`, `review: ${dir}`, `range: ${base}..${head}`, `stat: ${stat || 'no changes'}`]
    if (target.kind === 'range') lines.push(`source: ${target.label}`)
    else lines.push(...(await g(['log', '--no-walk=unsorted', '--format=commit: %h %s', ...target.commits])).split('\n'))
    for (const { file, foreign } of interleaved) {
      lines.push(`interleaved: ${file} (foreign: ${foreign.map((sha) => sha.slice(0, 12)).join(', ')})`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
  },
})

const wait = defineCommand({
  meta: { name: 'wait', description: 'Block until the review is submitted, print the feedback, remove the checkout' },
  args: {
    review: { type: 'positional', required: true, description: 'Review directory printed by open' },
  },
  async run({ args }) {
    const dir = args.review
    const state = readState(dir)
    if (!state) fail(`no review state in ${dir}`)
    while (isAlive(state.pid)) await Bun.sleep(1000)
    const raw = readFileSync(join(dir, 'result.json'), 'utf8').trim()
    const parsed = raw ? Result.safeParse(JSON.parse(raw.split('\n').at(-1)!)) : undefined
    if (!parsed?.success) fail(`plannotator exited without a decision; checkout kept at ${dir}`)
    process.stdout.write(`decision: ${parsed.data.decision}\n\n${parsed.data.message}\n`)
    removeReview(dir)
  },
})

const close = defineCommand({
  meta: { name: 'close', description: 'Stop the review server and remove the checkout without a decision' },
  args: {
    review: { type: 'positional', required: true, description: 'Review directory printed by open' },
  },
  run({ args }) {
    const state = readState(args.review)
    if (!state) fail(`no review state in ${args.review}`)
    if (isAlive(state.pid)) process.kill(state.pid)
    removeReview(args.review)
  },
})

runMain(
  defineCommand({
    meta: { name: 'git-ref', description: 'Review a commit set or range in Plannotator via a synthetic checkout' },
    subCommands: { open, wait, close },
  }),
)
