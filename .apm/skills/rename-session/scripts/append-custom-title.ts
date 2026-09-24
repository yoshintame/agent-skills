#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

export enum SessionType {
  Analytics = 'analytics',
  Ask = 'ask',
  Config = 'config',
  Extract = 'extract',
  Fix = 'fix',
  Groom = 'groom',
  Impl = 'impl',
  Investigate = 'investigate',
  Ops = 'ops',
  Research = 'research',
  Review = 'review',
}

export const SESSION_TYPE_SIGNATURES = {
  [SessionType.Impl]: 'implemented a change',
  [SessionType.Fix]: 'repaired broken behavior',
  [SessionType.Groom]: 'analyzed and designed work before implementation',
  [SessionType.Research]: 'discovered external tools, market options, or established practice',
  [SessionType.Investigate]: 'diagnosed a cause inside the system',
  [SessionType.Extract]: 'recorded conclusions from work already completed',
  [SessionType.Review]: 'reviewed quality without making changes',
  [SessionType.Ops]: 'ran production, deployment, backup, or data migration operations',
  [SessionType.Analytics]: 'queried data for an answer without mutations',
  [SessionType.Config]: 'configured the local environment or tooling',
  [SessionType.Ask]: 'answered a one-off question or explanation',
} as const satisfies Record<SessionType, string>

enum SessionStatus {
  Active = 'active',
  Done = 'done',
  Paused = 'paused',
}

interface ParsedArgs {
  feature?: string
  leaves: string[]
  status: SessionStatus
  title: string
}

interface ProviderSession {
  id: string
  kind: 'claude' | 'codex'
}

interface PaseoAgent {
  id: string
  workspaceId: string
}

const STATUS_EMOJI = {
  [SessionStatus.Active]: '🔴',
  [SessionStatus.Paused]: '🟡',
  [SessionStatus.Done]: '🟢',
} as const satisfies Record<SessionStatus, string>
const SESSION_TYPES = Object.values(SessionType)
const TITLE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+){1,4}$/
const FEATURE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COMPOSITE_REGEX = /^(🔴|🟡|🟢) [a-z0-9-]+\/[a-z0-9-]+$/u
const MAX_VISIBLE_LEN = 80
const UNCOMMITTED_GATE = resolve(import.meta.dir, '..', '..', 'session-status', 'scripts', 'session-status.ts')
const GATE_BLOCKING_EXIT = 2

if (import.meta.main) await main()

async function main(): Promise<void> {
  const { feature, leaves, status, title } = parseArgs(process.argv.slice(2))
  validateTitle(title)
  if (feature !== undefined) validateFeature(feature)
  if (leaves.length > 0 && status !== SessionStatus.Done) die('--leave only applies with --status done')
  const customTitle = `${STATUS_EMOJI[status]} ${title}`
  validateCompositeName(customTitle)
  const provider = resolveProviderSession(process.env)
  if (status === SessionStatus.Done) runUncommittedGate(provider, leaves)

  let previousTitle: string | undefined

  if (provider.kind === 'codex') {
    await renameCodexThread(provider.id, customTitle)
  } else {
    const jsonlPath = discoverClaudeJsonl(provider.id)
    previousTitle = readCurrentClaudeTitle(jsonlPath)
    appendClaudeCustomTitle(jsonlPath, provider.id, customTitle)
  }

  updatePaseo(provider.id, customTitle, feature)
  const oldDisplay = previousTitle ?? '(unnamed)'
  process.stdout.write(`${oldDisplay} → ${customTitle}\n`)
  for (const leave of leaves) process.stdout.write(`left uncommitted: ${leave}\n`)
}

function runUncommittedGate(provider: ProviderSession, leaves: readonly string[]): void {
  if (provider.kind === 'codex') {
    process.stderr.write('rename-session: uncommitted gate reads Claude transcripts only; skipped for Codex\n')
    return
  }
  if (!existsSync(UNCOMMITTED_GATE)) die(`uncommitted gate not found at ${UNCOMMITTED_GATE}`)
  const gate = Bun.spawnSync(
    [process.execPath, UNCOMMITTED_GATE, '--uncommitted', ...leaves.flatMap((leave) => ['--leave', leave]), provider.id],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const stdout = gate.stdout.toString()
  const stderr = gate.stderr.toString()
  if (gate.exitCode === 0) {
    process.stderr.write(stderr)
    return
  }
  process.stderr.write(stdout)
  process.stderr.write(stderr)
  if (gate.exitCode === GATE_BLOCKING_EXIT) {
    die('refusing done: the session left uncommitted changes above — commit or discard each, or pass --leave <abs-path>=<reason>')
  }
  die(`uncommitted gate failed with exit ${gate.exitCode}`)
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let status = SessionStatus.Active
  let feature: string | undefined
  const leaves: string[] = []
  const positional: string[] = []

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) break
    if (arg === '--status') {
      status = parseStatus(argv[++index])
    } else if (arg.startsWith('--status=')) {
      status = parseStatus(arg.slice('--status='.length))
    } else if (arg === '--leave') {
      leaves.push(parseLeave(argv[++index]))
    } else if (arg.startsWith('--leave=')) {
      leaves.push(parseLeave(arg.slice('--leave='.length)))
    } else if (arg === '--feature') {
      feature = parseFeature(argv[++index])
    } else if (arg.startsWith('--feature=')) {
      feature = parseFeature(arg.slice('--feature='.length))
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: append-custom-title.ts [--status active|paused|done] [--feature kebab-feature] [--leave <abs-path>=<reason>]... <type/kebab-title>\n',
      )
      process.exit(0)
    } else if (arg.startsWith('-')) {
      die(`unknown flag ${JSON.stringify(arg)}`)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) die('missing positional title: <type>/<kebab-title>')
  if (positional.length > 1) {
    die(`expected single positional title, got ${positional.length}: ${positional.join(' ')}`)
  }

  const title = positional[0]
  if (title === undefined) die('missing positional title: <type>/<kebab-title>')
  return { feature, leaves, status, title }
}

function parseStatus(value: unknown): SessionStatus {
  if (value === SessionStatus.Active) return value
  if (value === SessionStatus.Paused) return value
  if (value === SessionStatus.Done) return value
  die(`--status must be active|paused|done, got ${JSON.stringify(value)}`)
}

function parseLeave(value: unknown): string {
  if (typeof value === 'string' && /^[^=]+=\s*\S/.test(value)) return value
  die(`--leave expects <abs-path>=<reason>, got ${JSON.stringify(value)}`)
}

function parseFeature(value: unknown): string {
  if (typeof value === 'string') return value
  die(`--feature requires a value, got ${JSON.stringify(value)}`)
}

function validateTitle(raw: string): void {
  const [rawType, rawTitle, extra] = raw.split('/')
  if (rawType === undefined || rawTitle === undefined || extra !== undefined) {
    die(`session type must be one of: ${SESSION_TYPES.join(', ')}; use <type>/<kebab-title>`)
  }

  parseSessionType(rawType)
  validateKebabTitle(rawTitle)
}

function parseSessionType(value: string): SessionType {
  const sessionType = SESSION_TYPES.find((candidate) => candidate === value)
  if (sessionType === undefined) die(`session type must be one of: ${SESSION_TYPES.join(', ')}`)
  return sessionType
}

function validateKebabTitle(value: string): void {
  if (!TITLE_REGEX.test(value)) {
    die('kebab title must contain 2-5 lowercase English words separated by single hyphens')
  }
}

function validateFeature(value: string): void {
  if (!FEATURE_REGEX.test(value)) {
    die('feature must be lowercase English kebab-case')
  }

  const workspaceName = `${STATUS_EMOJI[SessionStatus.Active]} ${value}`
  if ([...workspaceName].length > MAX_VISIBLE_LEN) {
    die(`workspace name length exceeds ${MAX_VISIBLE_LEN}: ${JSON.stringify(workspaceName)}`)
  }
}

function validateCompositeName(value: string): void {
  if (!COMPOSITE_REGEX.test(value)) {
    die(`composed name failed final regex check: ${JSON.stringify(value)}`)
  }

  const visibleLength = [...value].length
  if (visibleLength > MAX_VISIBLE_LEN) {
    die(`composed name length ${visibleLength} > ${MAX_VISIBLE_LEN}: ${JSON.stringify(value)}`)
  }
}

function resolveProviderSession(env: NodeJS.ProcessEnv): ProviderSession {
  const codexId = env.CODEX_THREAD_ID
  const claudeId = env.CLAUDE_CODE_SESSION_ID

  if (codexId !== undefined && claudeId !== undefined) {
    die('both CODEX_THREAD_ID and CLAUDE_CODE_SESSION_ID are set; refusing ambiguous rename')
  }
  if (codexId !== undefined) return { id: codexId, kind: 'codex' }
  if (claudeId !== undefined) return { id: claudeId, kind: 'claude' }
  die('neither CODEX_THREAD_ID nor CLAUDE_CODE_SESSION_ID is set')
}

function discoverClaudeJsonl(sessionId: string): string {
  const projectsRoot = join(homedir(), '.claude', 'projects')
  if (!existsSync(projectsRoot)) die(`projects root not found: ${projectsRoot}`)

  const direct = join(projectsRoot, hashCwd(process.cwd()), `${sessionId}.jsonl`)
  if (existsSync(direct)) return direct

  for (const project of readdirSync(projectsRoot)) {
    const candidate = join(projectsRoot, project, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }

  die(
    `CLAUDE_CODE_SESSION_ID=${sessionId} set, but ${sessionId}.jsonl not found under ${projectsRoot}`,
  )
}

function hashCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function readCurrentClaudeTitle(jsonlPath: string): string | undefined {
  const content = readFileSync(jsonlPath, 'utf8')
  let lastTitle: string | undefined
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (
        isRecord(parsed) &&
        parsed.type === 'custom-title' &&
        typeof parsed.customTitle === 'string'
      ) {
        lastTitle = parsed.customTitle
      }
    } catch {
      continue
    }
  }
  return lastTitle
}

function appendClaudeCustomTitle(jsonl: string, sessionId: string, customTitle: string): void {
  const line = `${JSON.stringify({ type: 'custom-title', sessionId, customTitle })}\n`
  const file = openSync(jsonl, 'a')

  try {
    writeSync(file, line)
  } finally {
    closeSync(file)
  }
}

function renameCodexThread(threadId: string, name: string): Promise<void> {
  const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  let stderr = ''

  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(
      () => fail('Codex App Server timed out during thread/name/set'),
      10_000,
    )

    function fail(message: string): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      reject(new Error(message))
    }

    function succeed(): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.stdin.end()
      resolve()
    }

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => fail(`Codex App Server failed: ${error.message}`))
    child.once('exit', (code) => {
      const detail = stderr.trim()
      fail(
        `Codex App Server exited with ${code ?? 'unknown status'} before thread/name/set completed${detail.length === 0 ? '' : `: ${detail}`}`,
      )
    })
    lines.on('line', (line) =>
      handleCodexResponse(line, threadId, name, child.stdin, fail, succeed),
    )

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          capabilities: { experimentalApi: true },
          clientInfo: { name: 'rename-session', version: '0.1.0' },
        },
      })}\n`,
    )
  }).catch((error: unknown) => {
    die(error instanceof Error ? error.message : String(error))
  })
}

function handleCodexResponse(
  line: string,
  threadId: string,
  name: string,
  stdin: NodeJS.WritableStream,
  fail: (message: string) => void,
  succeed: () => void,
): void {
  const response = parseJsonRpcLine(line, fail)
  if (response === undefined) return

  if (response.id === 1) {
    if ('error' in response) {
      fail(`Codex App Server initialize failed: ${formatError(response.error)}`)
      return
    }
    if (!('result' in response)) {
      fail('Codex App Server returned an invalid initialize response')
      return
    }
    stdin.write(
      `${JSON.stringify({ id: 2, method: 'thread/name/set', params: { threadId, name } })}\n`,
    )
  }

  if (response.id === 2) {
    if ('error' in response) {
      fail(`Codex App Server thread/name/set failed: ${formatError(response.error)}`)
      return
    }
    if (!('result' in response)) {
      fail('Codex App Server returned an invalid thread/name/set response')
      return
    }
    succeed()
  }
}

function parseJsonRpcLine(
  line: string,
  fail: (message: string) => void,
): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    fail(`Codex App Server returned invalid JSON: ${JSON.stringify(line)}`)
    return undefined
  }
}

function updatePaseo(providerId: string, sessionName: string, feature: string | undefined): void {
  try {
    const agent = findPaseoAgent(providerId)
    if (agent === undefined) return

    runPaseo(['agent', 'update', agent.id, '--name', sessionName])
    if (feature === undefined) return
    if (!isWorkspaceUntitled(agent.workspaceId)) return
    runPaseo(['workspace', 'rename', agent.workspaceId, feature])
  } catch {
    return
  }
}

function findPaseoAgent(providerId: string): PaseoAgent | undefined {
  const agentsRoot = join(homedir(), '.paseo', 'agents')
  if (!existsSync(agentsRoot)) return undefined

  const matches = walkJsonFiles(agentsRoot)
    .map((path) => readPaseoAgent(path, providerId))
    .filter((agent): agent is PaseoAgent => agent !== undefined)
  if (matches.length !== 1) return undefined
  return matches[0]
}

function readPaseoAgent(path: string, providerId: string): PaseoAgent | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(value)) return undefined

    const persistence = isRecord(value.persistence) ? value.persistence : undefined
    const runtimeInfo = isRecord(value.runtimeInfo) ? value.runtimeInfo : undefined
    const nativeHandle = readString(persistence?.nativeHandle)
    const runtimeSessionId = readString(runtimeInfo?.sessionId)
    if ((nativeHandle ?? runtimeSessionId) !== providerId) return undefined

    const id = readString(value.id)
    const workspaceId = readString(value.workspaceId)
    if (id === undefined || workspaceId === undefined) return undefined
    return { id, workspaceId }
  } catch {
    return undefined
  }
}

function walkJsonFiles(root: string): string[] {
  const files: string[] = []

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkJsonFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path)
  }

  return files
}

function isWorkspaceUntitled(workspaceId: string): boolean {
  const path = join(homedir(), '.paseo', 'projects', 'workspaces.json')
  if (!existsSync(path)) return false

  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value)) return false
  const workspace = value.find(
    (candidate) => isRecord(candidate) && candidate.workspaceId === workspaceId,
  )
  if (!isRecord(workspace)) return false
  return workspace.title === null || workspace.title === ''
}

function runPaseo(args: string[]): void {
  Bun.spawnSync(['paseo', ...args])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function formatError(value: unknown): string {
  if (isRecord(value) && typeof value.message === 'string') return value.message
  return JSON.stringify(value)
}

function die(message: string): never {
  process.stderr.write(`rename-session: ${message}\n`)
  process.exit(1)
}
