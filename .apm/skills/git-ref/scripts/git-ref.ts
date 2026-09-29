#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { defineCommand, runMain } from 'citty@0.2.2'
import $ from 'dax-sh@0.42.0'
import { groupBy, inRange } from 'es-toolkit@1.52.0'
import { match, P } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'

$.setPrintCommand(false)

const cacheRoot = process.env.GIT_REF_CACHE ?? join(homedir(), '.cache', 'git-ref')
const staleMs = 7 * 24 * 60 * 60 * 1000
const startupTimeoutMs = 30_000
const commitSlackMs = 3000
const rangePattern = /^(.+?)(\.\.\.?)(.+)$/

const State = z.object({
  pid: z.number(),
  url: z.string(),
  summary: z.array(z.string()),
  createdAt: z.number(),
})
type State = z.infer<typeof State>

const Result = z.object({
  decision: z.enum(['approved', 'annotated', 'dismissed']),
  message: z.string(),
})
type Result = z.infer<typeof Result>

const TranscriptLine = z.object({
  timestamp: z.iso.datetime().transform((iso) => Date.parse(iso)),
  message: z.object({ content: z.array(z.unknown()) }),
})

const TranscriptItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.literal('Bash'), input: z.object({ command: z.string() }) }),
  z.object({ type: z.literal('tool_result'), tool_use_id: z.string() }),
])

interface Materialized {
  base: string
  head: string
  lines: string[]
}

interface Plan {
  identity: string
  materialize: (clone: string, dir: string) => Promise<Materialized>
}

interface CommitCall {
  command: string
  startMs: number
  endMs: number
}

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

function lines(out: string): string[] {
  return out.split('\n').filter(Boolean)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function readParsed<T>(path: string, schema: z.ZodType<T>, pick: (text: string) => string = (text) => text): T | undefined {
  if (!existsSync(path)) return undefined
  const parsed = schema.safeParse(parseJson(pick(readFileSync(path, 'utf8'))))
  return parsed.success ? parsed.data : undefined
}

function readState(dir: string): State | undefined {
  return readParsed(join(dir, 'state.json'), State)
}

function readResult(dir: string): Result | undefined {
  return readParsed(join(dir, 'result.json'), Result, (text) => lines(text).at(-1) ?? '')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function responds(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

async function isServing({ pid, url }: State): Promise<boolean> {
  return isAlive(pid) ? responds(url) : false
}

async function reusableSummary(state: State | undefined): Promise<string[] | undefined> {
  if (state === undefined) return undefined
  return (await isServing(state)) ? state.summary : undefined
}

async function stopServer(state: State) {
  if (await isServing(state)) process.kill(state.pid)
}

function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const port = server.port ?? fail('could not allocate a free port')
  server.stop(true)
  return port
}

async function resolveCommit(repo: string, ref: string): Promise<string> {
  const sha = await $`git -C ${repo} rev-parse --verify --quiet --end-of-options ${`${ref}^{commit}`}`.noThrow().text()
  return sha || fail(`not a commit in ${repo}: ${ref}`)
}

async function sessionTranscripts(sessionId: string): Promise<string[]> {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  for await (const main of new Bun.Glob(`*/${sessionId}.jsonl`).scan({ cwd: projects, absolute: true })) {
    const subagents = join(dirname(main), basename(main, '.jsonl'), 'subagents')
    const nested = existsSync(subagents) ? await Array.fromAsync(new Bun.Glob('**/*.jsonl').scan({ cwd: subagents, absolute: true })) : []
    return [main, ...nested]
  }
  fail(`no Claude Code transcript for session ${sessionId}`)
}

async function sessionCommitCalls(sessionId: string): Promise<CommitCall[]> {
  const pending = new Map<string, Omit<CommitCall, 'endMs'>>()
  const calls: CommitCall[] = []
  for (const path of await sessionTranscripts(sessionId)) {
    for (const raw of lines(await Bun.file(path).text())) {
      const line = TranscriptLine.safeParse(parseJson(raw))
      if (!line.success) continue
      for (const content of line.data.message.content) {
        const item = TranscriptItem.safeParse(content)
        if (!item.success) continue
        match(item.data)
          .with({ type: 'tool_use', input: { command: P.string.regex(/commit/) } }, ({ id, input }) => {
            pending.set(id, { command: input.command, startMs: line.data.timestamp })
          })
          .with({ type: 'tool_use' }, () => {})
          .with({ type: 'tool_result' }, ({ tool_use_id }) => {
            const call = pending.get(tool_use_id)
            if (call === undefined) return
            calls.push({ ...call, endMs: line.data.timestamp })
            pending.delete(tool_use_id)
          })
          .exhaustive()
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
  const log = await git(repo)(['log', `--since=${since}`, '--format=%H%x09%at%x09%s', 'HEAD'])
  const matched = lines(log)
    .map((line) => line.split('\t'))
    .filter(([, authoredAt, subject]) => {
      const ms = Number(authoredAt) * 1000
      const needle = normalize(subject)
      if (needle === '') return false
      return calls
        .filter(({ startMs, endMs }) => inRange(ms, startMs - commitSlackMs, endMs + commitSlackMs + 1))
        .some(({ command }) => normalize(command).includes(needle))
    })
    .map(([sha]) => sha)
  return matched.length > 0 ? matched : fail(`no commits on HEAD of ${repo} match session ${sessionId}; pass the SHAs explicitly`)
}

async function orderSet(repo: string, commits: string[]): Promise<string[]> {
  const g = git(repo)
  const unique = [...new Set(commits)]
  const tips = lines(await g(['merge-base', '--independent', ...unique]))
  if (tips.length !== 1) fail(`commits do not lie on one line of history (tips: ${tips.map((t) => t.slice(0, 12)).join(', ')})`)
  const oldest = await g(['merge-base', '--octopus', ...unique])
  const walk = lines(await g(['rev-list', '--reverse', '--topo-order', tips[0], '--not', `${oldest}^@`]))
  const wanted = new Set(unique)
  const ordered = walk.filter((sha) => wanted.has(sha))
  const parent = await $`git -C ${repo} rev-parse --verify --quiet ${`${ordered[0]}^`}`.noThrow().quiet().text()
  if (!parent) fail(`cannot review from a root commit: ${ordered[0]}`)
  return ordered
}

async function buildTree(clone: string, parent: string, revByFile: Map<string, string>, indexFile: string): Promise<string> {
  const g = git(clone, { GIT_INDEX_FILE: indexFile })
  await g(['read-tree', parent])
  await g(['update-index', '-z', '--force-remove', '--stdin'], `${[...revByFile.keys()].join('\0')}\0`)
  for (const [rev, entries] of Object.entries(groupBy([...revByFile], ([, rev]) => rev))) {
    const tree = await g(['ls-tree', '-z', '--full-tree', rev, '--', ...entries.map(([file]) => file)])
    if (tree) await g(['update-index', '-z', '--index-info'], tree)
  }
  const tree = await g(['write-tree'])
  rmSync(indexFile, { force: true })
  return tree
}

async function interleaved(g: ReturnType<typeof git>, touchedBy: Map<string, string[]>, commits: string[]): Promise<string[]> {
  const inSet = new Set(commits)
  const reports = await Promise.all(
    [...touchedBy].map(async ([file, cs]) => {
      if (cs.length < 2) return undefined
      const foreign = lines(await g(['rev-list', `${cs[0]}^..${cs[cs.length - 1]}`, '--', file])).filter((sha) => !inSet.has(sha))
      return foreign.length > 0 ? `interleaved: ${file} (foreign: ${foreign.map((sha) => sha.slice(0, 12)).join(', ')})` : undefined
    }),
  )
  return reports.filter((report) => report !== undefined)
}

async function synthesize(clone: string, dir: string, commits: string[]): Promise<Materialized> {
  const g = git(clone)
  const touchedFiles = await Promise.all(commits.map(async (c) => (await g(['diff-tree', '--no-commit-id', '-r', '--name-only', '-z', `${c}^`, c])).split('\0').filter(Boolean)))
  const touchedBy = new Map<string, string[]>()
  commits.forEach((c, i) => touchedFiles[i].forEach((f) => touchedBy.set(f, [...(touchedBy.get(f) ?? []), c])))

  const parent = await g(['rev-parse', `${commits[0]}^`])
  const date = await g(['show', '-s', '--format=%cI', commits[commits.length - 1]])
  const identity = {
    GIT_AUTHOR_NAME: 'git-ref',
    GIT_AUTHOR_EMAIL: 'git-ref@localhost',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'git-ref',
    GIT_COMMITTER_EMAIL: 'git-ref@localhost',
    GIT_COMMITTER_DATE: date,
  }
  const baseTree = await buildTree(clone, parent, new Map([...touchedBy].map(([f, cs]) => [f, `${cs[0]}^`])), join(dir, 'base.idx'))
  const headTree = await buildTree(clone, parent, new Map([...touchedBy].map(([f, cs]) => [f, cs[cs.length - 1]])), join(dir, 'head.idx'))
  const oneline = await g(['log', '--no-walk=unsorted', '--format=%h %s', ...commits])
  const commitTree = git(clone, identity)
  const base = await commitTree(['commit-tree', baseTree, '-p', parent], 'git-ref review base\n')
  const head = await commitTree(['commit-tree', headTree, '-p', base], `git-ref review: ${commits.length} commits\n\n${oneline}\n`)
  return { base, head, lines: [...lines(oneline).map((l) => `commit: ${l}`), ...(await interleaved(g, touchedBy, commits))] }
}

async function rangePlan(root: string, spec: string): Promise<Plan> {
  const [, from, dots, to] = rangePattern.exec(spec) ?? fail(`not a range: ${spec}`)
  const head = await resolveCommit(root, to)
  const fromSha = await resolveCommit(root, from)
  const base = dots === '...' ? await git(root)(['merge-base', fromSha, head]) : fromSha
  return { identity: `range ${base} ${head}`, materialize: async () => ({ base, head, lines: [`source: ${spec}`] }) }
}

async function setPlan(root: string, refs: string[]): Promise<Plan> {
  const commits = await orderSet(root, await Promise.all(refs.map((ref) => resolveCommit(root, ref))))
  return { identity: `set ${commits.join(' ')}`, materialize: (clone, dir) => synthesize(clone, dir, commits) }
}

function sessionId(session: string): string {
  return session === 'current' ? (process.env.CLAUDE_CODE_SESSION_ID ?? fail('--session current needs CLAUDE_CODE_SESSION_ID; pass the SHAs explicitly')) : session
}

function resolvePlan(root: string, session: string | undefined, specs: string[]): Promise<Plan> {
  return match({ session, specs })
    .with({ session: P.string, specs: [] }, async ({ session }) => setPlan(root, await sessionCommits(root, sessionId(session))))
    .with({ session: P.string }, () => fail('--session takes no other targets'))
    .with({ specs: [] }, () => fail('nothing to review: pass SHAs, A..B, A...B, N, or --session current'))
    .with({ specs: [P.string.regex(/^\d{1,6}$/)] }, ({ specs: [n] }) => rangePlan(root, `HEAD~${n}..HEAD`))
    .with({ specs: [P.string.regex(rangePattern)] }, ({ specs: [spec] }) => rangePlan(root, spec))
    .otherwise(() => setPlan(root, specs))
}

function reviewDir(root: string, identity: string): string {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  return join(cacheRoot, `${basename(root)}-${hash(root).slice(0, 8)}`, hash(identity).slice(0, 12))
}

function removeReview(dir: string) {
  rmSync(dir, { recursive: true, force: true })
  if (readdirSync(dirname(dir)).length === 0) rmSync(dirname(dir), { recursive: true })
}

async function prune() {
  if (!existsSync(cacheRoot)) return
  const dirs = readdirSync(cacheRoot).flatMap((repoKey) => readdirSync(join(cacheRoot, repoKey)).map((key) => join(cacheRoot, repoKey, key)))
  for (const dir of dirs) {
    const state = readState(dir)
    if (Date.now() - (state?.createdAt ?? statSync(dir).mtimeMs) < staleMs) continue
    if (state !== undefined) await stopServer(state)
    removeReview(dir)
  }
}

function plannotatorBin(): string {
  return Bun.which('plannotator') ?? fail('plannotator not found on PATH')
}

function serve(bin: string, clone: string, dir: string, port: number): number {
  const child = spawn(bin, ['review', '--git', '--base', 'refs/review/base', '--diff-type', 'branch', '--no-git-remote-check', '--json'], {
    cwd: clone,
    detached: true,
    stdio: ['ignore', openSync(join(dir, 'result.json'), 'w'), openSync(join(dir, 'plannotator.log'), 'w')],
    env: {
      ...process.env,
      PLANNOTATOR_BROWSER: '/usr/bin/true',
      PLANNOTATOR_AI: 'disabled',
      PLANNOTATOR_PORT: String(port),
      PLANNOTATOR_GIT_REMOTE_CHECK: '0',
    },
  })
  child.unref()
  return child.pid ?? fail('failed to start plannotator')
}

async function waitForServer(state: State, dir: string) {
  const deadline = Date.now() + startupTimeoutMs
  while (!(await responds(state.url))) {
    const alive = Date.now() > deadline ? false : isAlive(state.pid)
    if (!alive) fail(`plannotator did not come up on ${state.url}; log: ${join(dir, 'plannotator.log')}`)
    await Bun.sleep(200)
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
    const bin = plannotatorBin()
    await prune()
    const root = await git(args.repo)(['rev-parse', '--show-toplevel'])
    const plan = await resolvePlan(root, args.session, args._.map(String))
    const dir = reviewDir(root, plan.identity)
    const reused = await reusableSummary(readState(dir))
    if (reused !== undefined) {
      process.stdout.write(`${[...reused, 'reused: true'].join('\n')}\n`)
      return
    }

    const clone = join(dir, basename(root))
    mkdirSync(dir, { recursive: true })
    if (!existsSync(join(clone, '.git'))) await $`git clone --quiet --shared --no-checkout ${root} ${clone}`
    const { base, head, lines: details } = await plan.materialize(clone, dir)
    const g = git(clone)
    await g(['update-ref', 'refs/review/base', base])
    await g(['checkout', '--quiet', '--force', '--detach', head])

    const port = freePort()
    const url = `http://localhost:${port}`
    const stat = await g(['diff', '--shortstat', base, head])
    const summary = [`url: ${url}`, `review: ${dir}`, `range: ${base}..${head}`, `stat: ${stat || 'no changes'}`, ...details]
    const state: State = { pid: serve(bin, clone, dir, port), url, summary, createdAt: Date.now() }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
    await waitForServer(state, dir)
    process.stdout.write(`${summary.join('\n')}\n`)
  },
})

const reviewArg = { review: { type: 'positional', required: true, description: 'Review directory printed by open' } } as const

const wait = defineCommand({
  meta: { name: 'wait', description: 'Block until the review is submitted, print the feedback, remove the checkout' },
  args: reviewArg,
  async run({ args }) {
    const state = readState(args.review) ?? fail(`no review state in ${args.review}`)
    while (isAlive(state.pid)) await Bun.sleep(1000)
    const result = readResult(args.review) ?? fail(`plannotator exited without a decision; checkout kept at ${args.review}`)
    process.stdout.write(`decision: ${result.decision}\n\n${result.message}\n`)
    removeReview(args.review)
  },
})

const close = defineCommand({
  meta: { name: 'close', description: 'Stop the review server and remove the checkout without a decision' },
  args: reviewArg,
  async run({ args }) {
    await stopServer(readState(args.review) ?? fail(`no review state in ${args.review}`))
    removeReview(args.review)
  },
})

runMain(
  defineCommand({
    meta: { name: 'git-ref', description: 'Review a commit set or range in Plannotator via a synthetic checkout' },
    subCommands: { open, wait, close },
  }),
)
