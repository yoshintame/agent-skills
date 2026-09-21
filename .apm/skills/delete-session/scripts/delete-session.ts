#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

type Provider = 'claude' | 'codex'
type Component = 'session' | 'agent' | 'workspace'
interface PaseoAgent {
  id: string
  workspaceId?: string
}
interface PaseoWorkspace {
  id: string
  cwd: string
  ownedWorktree: boolean
  worktreeRoot?: string
}
interface Plan {
  id: string
  provider: Provider
  self: boolean
  components: ReadonlySet<Component>
  artifacts: string[]
  agents: PaseoAgent[]
  workspace?: PaseoWorkspace
  watchFile?: string
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const home = process.env.DELETE_SESSION_HOME ?? homedir()
const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
const codexRoot = process.env.CODEX_HOME ?? join(home, '.codex')
const paseoRoot =
  process.env.DELETE_SESSION_PASEO_ROOT ?? join(home, '.paseo', 'agents')
const codexCommand = process.env.DELETE_SESSION_CODEX_COMMAND ?? 'codex'
const paseoCommand = process.env.DELETE_SESSION_PASEO_COMMAND ?? 'paseo'

function fail(message: string): never {
  process.stderr.write(`delete-session: ${message}\n`)
  process.exit(1)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function kind(path: string): 'file' | 'dir' | 'link' | undefined {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) return 'link'
    if (info.isDirectory()) return 'dir'
    if (info.isFile()) return 'file'
    return undefined
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !rel.startsWith(sep)
  )
}

function walk(
  root: string,
  visit: (path: string, entryKind: 'file' | 'dir' | 'link') => void,
): void {
  if (kind(root) !== 'dir') return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      visit(path, 'dir')
      walk(path, visit)
    } else if (entry.isFile()) visit(path, 'file')
    else if (entry.isSymbolicLink()) visit(path, 'link')
  }
}

function claudeArtifacts(id: string): string[] {
  const projects = join(claudeRoot, 'projects')
  const paths = new Set<string>()
  if (kind(projects) === 'dir') {
    for (const project of readdirSync(projects)) {
      const projectRoot = join(projects, project)
      if (kind(projectRoot) !== 'dir') continue
      const transcript = join(projectRoot, `${id}.jsonl`)
      if (kind(transcript)) paths.add(transcript)
      const sidecar = join(projectRoot, id)
      if (kind(sidecar)) paths.add(sidecar)
    }
  }
  for (const group of ['tasks', 'file-history']) {
    const path = join(claudeRoot, group, id)
    if (kind(path)) paths.add(path)
  }
  const todos = join(claudeRoot, 'todos')
  if (kind(todos) === 'dir') {
    for (const entry of readdirSync(todos)) {
      if (!entry.startsWith(`${id}-agent-`) || !entry.endsWith('.json'))
        continue
      const path = join(todos, entry)
      if (kind(path)) paths.add(path)
    }
  }
  return [...paths].sort()
}

function codexRollouts(id: string): string[] {
  const paths: string[] = []
  for (const group of ['sessions', 'archived_sessions']) {
    walk(join(codexRoot, group), (path, entryKind) => {
      if (entryKind === 'file' && basename(path).endsWith(`-${id}.jsonl`))
        paths.push(path)
    })
  }
  return paths.sort()
}

function paseoAgents(provider: Provider, id: string): PaseoAgent[] {
  const agentsById = new Map<string, PaseoAgent>()
  walk(paseoRoot, (path, entryKind) => {
    if (entryKind !== 'file' || !path.endsWith('.json')) return
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return
    }
    const data = record(value)
    const persistence = record(data.persistence)
    const runtime = record(data.runtimeInfo)
    const actualProvider =
      data.provider ?? persistence.provider ?? runtime.provider
    if (actualProvider !== provider) return
    if (
      [persistence.nativeHandle, runtime.sessionId, persistence.sessionId].some(
        (field) => field === id,
      )
    ) {
      if (typeof data.id !== 'string' || !uuidRe.test(data.id))
        fail(`invalid Paseo agent ID in ${path}`)
      const workspaceId =
        typeof data.workspaceId === 'string' ? data.workspaceId : undefined
      const previous = agentsById.get(data.id)
      if (
        previous?.workspaceId !== undefined &&
        previous.workspaceId !== workspaceId
      )
        fail(`conflicting Paseo workspace IDs for agent ${data.id}`)
      agentsById.set(data.id, { id: data.id, workspaceId })
    }
  })
  return [...agentsById.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function linkedWorkspace(agents: PaseoAgent[]): PaseoWorkspace {
  if (!agents.length) fail('--archive-workspace requires a linked Paseo agent')
  const workspaceIds = new Set(agents.map((agent) => agent.workspaceId))
  if (workspaceIds.size !== 1 || workspaceIds.has(undefined))
    fail('--archive-workspace requires one unambiguous Paseo workspace ID')
  const id = [...workspaceIds][0]!
  const selectedIds = new Set(agents.map((agent) => agent.id))
  const peers: string[] = []
  walk(paseoRoot, (path, entryKind) => {
    if (entryKind !== 'file' || !path.endsWith('.json')) return
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      fail(`cannot verify workspace agents: invalid JSON in ${path}`)
    }
    const data = record(value)
    if (data.workspaceId !== id) return
    if (typeof data.id !== 'string')
      fail(`cannot verify workspace agents: missing ID in ${path}`)
    if (!selectedIds.has(data.id)) peers.push(data.id)
  })
  if (peers.length)
    fail(`workspace ${id} has other Paseo agents: ${peers.sort().join(', ')}`)
  const path = join(dirname(paseoRoot), 'projects', 'workspaces.json')
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    fail(`cannot read Paseo workspaces at ${path}`)
  }
  if (!Array.isArray(value)) fail(`invalid Paseo workspaces at ${path}`)
  const matches = value.filter(
    (entry) => isRecord(entry) && entry.workspaceId === id,
  )
  if (matches.length !== 1)
    fail(`workspace ${id} is not uniquely registered in Paseo`)
  const data = record(matches[0])
  if (data.archivedAt != null) fail(`workspace ${id} is already archived`)
  if (typeof data.cwd !== 'string' || !data.cwd)
    fail(`workspace ${id} has no valid cwd`)
  const ownedWorktree = data.isPaseoOwnedWorktree === true
  const worktreeRoot =
    typeof data.worktreeRoot === 'string' ? data.worktreeRoot : undefined
  if (ownedWorktree && !worktreeRoot)
    fail(`Paseo-owned workspace ${id} has no worktree root`)
  return { id, cwd: data.cwd, ownedWorktree, worktreeRoot }
}

function environmentSessions(): Array<{ provider: Provider; id: string }> {
  const entries: Array<{ provider: Provider; id: string }> = []
  const claude = process.env.CLAUDE_CODE_SESSION_ID
  const codex = process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID
  if (
    process.env.CODEX_THREAD_ID &&
    process.env.CODEX_SESSION_ID &&
    process.env.CODEX_THREAD_ID !== process.env.CODEX_SESSION_ID
  ) {
    fail('CODEX_THREAD_ID and CODEX_SESSION_ID disagree')
  }
  if (claude) entries.push({ provider: 'claude', id: claude.toLowerCase() })
  if (codex) entries.push({ provider: 'codex', id: codex.toLowerCase() })
  for (const entry of entries)
    if (!uuidRe.test(entry.id))
      fail(`invalid ${entry.provider} session UUID in environment`)
  return entries
}

function resolveTarget(
  explicitId: string | undefined,
  requestedProvider: Provider | undefined,
): { provider: Provider; id: string; self: boolean } {
  const env = environmentSessions()
  if (explicitId === undefined) {
    const candidates = requestedProvider
      ? env.filter((entry) => entry.provider === requestedProvider)
      : env
    if (candidates.length !== 1)
      fail(
        candidates.length
          ? 'both provider session IDs are set; pass a UUID and --provider'
          : 'no current session ID in environment; pass a UUID',
      )
    return { ...candidates[0]!, self: true }
  }
  if (!uuidRe.test(explicitId)) fail(`invalid session UUID: ${explicitId}`)
  const id = explicitId.toLowerCase()
  let provider = requestedProvider
  if (!provider) {
    const matches = new Set<Provider>()
    if (claudeArtifacts(id).length) matches.add('claude')
    if (codexRollouts(id).length) matches.add('codex')
    if (paseoAgents('claude', id).length) matches.add('claude')
    if (paseoAgents('codex', id).length) matches.add('codex')
    for (const entry of env) if (entry.id === id) matches.add(entry.provider)
    if (matches.size !== 1)
      fail(
        matches.size
          ? `session ${id} occurs in both providers; pass --provider`
          : `cannot infer provider for ${id}; pass --provider`,
      )
    provider = [...matches][0]!
  }
  return {
    provider,
    id,
    self: env.some((entry) => entry.provider === provider && entry.id === id),
  }
}

function makePlan(
  target: {
    provider: Provider
    id: string
    self: boolean
  },
  components: ReadonlySet<Component>,
): Plan {
  const artifacts =
    target.provider === 'claude'
      ? claudeArtifacts(target.id)
      : codexRollouts(target.id)
  const agents = paseoAgents(target.provider, target.id)
  if (components.size === 1 && components.has('agent') && !agents.length)
    fail(`no linked Paseo agent for ${target.provider} ${target.id}`)
  return {
    ...target,
    components,
    artifacts,
    agents,
    workspace: components.has('workspace')
      ? linkedWorkspace(agents)
      : undefined,
    watchFile: artifacts.find(
      (path) => kind(path) === 'file' && path.endsWith('.jsonl'),
    ),
  }
}

function report(plan: Plan, dryRun: boolean): void {
  process.stdout.write(
    `delete-session: ${dryRun ? 'dry run: ' : ''}${plan.provider} ${plan.id}${plan.self ? ' (current session)' : ''}\n`,
  )
  if (plan.components.has('agent'))
    for (const agent of plan.agents)
      process.stdout.write(`  paseo delete ${agent.id}\n`)
  if (plan.components.has('session')) {
    if (plan.provider === 'codex') {
      process.stdout.write(
        `  ${codexCommand} delete --force ${plan.id} (may delete descendant threads)\n`,
      )
      for (const path of plan.artifacts)
        process.stdout.write(`    stored: ${path}\n`)
    } else {
      for (const path of plan.artifacts)
        process.stdout.write(`  remove ${path}\n`)
    }
  }
  if (
    plan.components.has('session') &&
    !plan.agents.length &&
    !plan.artifacts.length &&
    plan.provider === 'claude'
  )
    process.stdout.write('  no matching local artifacts\n')
  if (plan.components.has('session') && plan.provider === 'claude')
    process.stdout.write('  shared history.jsonl is retained\n')
  if (
    plan.components.has('session') &&
    !plan.components.has('agent') &&
    plan.agents.length
  )
    process.stdout.write(
      `  warning: Paseo agent retained after provider session deletion${plan.workspace ? '; workspace archive will archive it' : ''}\n`,
    )
  if (plan.workspace) {
    process.stdout.write(`  paseo workspace archive ${plan.workspace.id}\n`)
    process.stdout.write(`    cwd: ${plan.workspace.cwd}\n`)
    if (plan.workspace.ownedWorktree)
      process.stdout.write(
        `    Paseo-owned worktree may be removed: ${plan.workspace.worktreeRoot}\n`,
      )
    if (!plan.components.has('agent'))
      process.stdout.write(
        '  warning: workspace archive archives its agents without hard deleting them\n',
      )
  }
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error(`${command}: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    )
  if (result.stdout.trim()) process.stdout.write(result.stdout)
}

function activeClaudePids(id: string): number[] {
  const sessions = join(claudeRoot, 'sessions')
  if (kind(sessions) !== 'dir') return []
  const pids: number[] = []
  for (const entry of readdirSync(sessions)) {
    if (!/^\d+\.json$/.test(entry)) continue
    const path = join(sessions, entry)
    if (kind(path) !== 'file') continue
    let data: Record<string, unknown>
    try {
      data = record(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      continue
    }
    if (data.sessionId !== id) continue
    const pid = Number(entry.slice(0, -5))
    if (data.pid !== pid)
      throw new Error(`Claude registry PID mismatch in ${path}`)
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (isRecord(error) && error.code === 'ESRCH') continue
      throw error
    }
    const result = spawnSync(
      'ps',
      ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
      { encoding: 'utf8' },
    )
    if (result.status !== 0 || !result.stdout.trim())
      throw new Error(
        `cannot inspect active Claude PID ${pid}: ${result.stderr?.trim() ?? ''}`,
      )
    const procStart = data.procStart
    if (
      typeof procStart !== 'string' ||
      !result.stdout.includes(procStart) ||
      !/anthropic\.claude-code.*native-binary/.test(result.stdout)
    ) {
      throw new Error(
        `Claude session ${id} has a live PID ${pid} that could not be verified`,
      )
    }
    pids.push(pid)
  }
  return pids
}

async function stopClaudePids(id: string): Promise<void> {
  for (const pid of activeClaudePids(id)) process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!activeClaudePids(id).length) return
    await Bun.sleep(250)
  }
  throw new Error(
    `Claude session ${id} is still active after SIGTERM; files were not removed`,
  )
}

function deleteClaude(plan: Plan): void {
  const allowedRoots = [
    join(claudeRoot, 'projects'),
    join(claudeRoot, 'tasks'),
    join(claudeRoot, 'file-history'),
    join(claudeRoot, 'todos'),
  ]
  for (const path of plan.artifacts) {
    if (!allowedRoots.some((root) => within(root, path)))
      throw new Error(`unsafe path: ${path}`)
    if (!kind(path)) continue
    rmSync(path, { recursive: true, force: true })
    process.stdout.write(`removed ${path}\n`)
  }
}

async function execute(plan: Plan): Promise<void> {
  if (
    plan.components.has('session') &&
    plan.provider === 'claude' &&
    !plan.self &&
    activeClaudePids(plan.id).length
  )
    throw new Error(
      `Claude session ${plan.id} is active; close it before deleting`,
    )
  if (plan.components.has('agent'))
    for (const agent of plan.agents) run(paseoCommand, ['delete', agent.id])
  if (plan.components.has('session')) {
    if (plan.provider === 'claude') {
      if (plan.self) await stopClaudePids(plan.id)
      deleteClaude(plan)
    } else {
      try {
        run(codexCommand, ['delete', '--force', plan.id])
      } catch (error) {
        if (!/not found|does not exist|unknown session/i.test(String(error)))
          throw error
        process.stdout.write(
          `delete-session: ${plan.id} is already absent in Codex\n`,
        )
      }
    }
  }
  if (plan.workspace)
    run(paseoCommand, ['workspace', 'archive', plan.workspace.id])
}

async function appendedEvents(
  file: string,
  offset: number,
): Promise<Array<Record<string, unknown>>> {
  const source = Bun.file(file)
  if (source.size <= offset) return []
  const text = await source.slice(offset).text()
  const lines = text.split('\n')
  lines.pop()
  return lines.flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return isRecord(value) ? [value] : []
    } catch {
      return []
    }
  })
}

function isCompletion(
  provider: Provider,
  event: Record<string, unknown>,
): boolean {
  if (provider === 'codex')
    return (
      event.type === 'event_msg' &&
      record(event.payload).type === 'task_complete'
    )
  return (
    event.type === 'assistant' &&
    record(event.message).stop_reason === 'end_turn'
  )
}

function isNewUser(
  provider: Provider,
  event: Record<string, unknown>,
): boolean {
  if (provider === 'codex') {
    const payload = record(event.payload)
    return (
      (event.type === 'event_msg' &&
        (payload.type === 'user_message' || payload.type === 'task_started')) ||
      (event.type === 'response_item' &&
        payload.type === 'message' &&
        payload.role === 'user')
    )
  }
  return event.type === 'user' && event.isSidechain !== true
}

async function deferred(plan: Plan, offset: number): Promise<void> {
  const file = plan.watchFile
  if (!file)
    throw new Error(
      'cannot defer current session without a transcript to watch',
    )
  const deadline = Date.now() + 10 * 60_000
  let completedAt: number | undefined
  while (Date.now() < deadline) {
    if (kind(file) !== 'file')
      throw new Error(`watched transcript disappeared: ${file}`)
    const events = await appendedEvents(file, offset)
    const completeIndex = events.findIndex((event) =>
      isCompletion(plan.provider, event),
    )
    if (completeIndex >= 0) {
      if (
        events
          .slice(completeIndex + 1)
          .some((event) => isNewUser(plan.provider, event))
      )
        throw new Error('a new user turn began; deferred deletion cancelled')
      completedAt ??= Date.now()
      if (Date.now() - completedAt >= 2000) {
        await execute(
          makePlan(
            { provider: plan.provider, id: plan.id, self: true },
            plan.components,
          ),
        )
        return
      }
    }
    await Bun.sleep(500)
  }
  throw new Error('timed out waiting for the current turn to finish')
}

function schedule(plan: Plan): void {
  if (!plan.watchFile)
    fail('cannot safely defer current session: no transcript found')
  const offset = statSync(plan.watchFile).size
  const log = join(
    process.env.TMPDIR ?? '/tmp',
    `delete-session-${plan.id}.log`,
  )
  const command = process.execPath
  const args = [
    import.meta.path,
    plan.id,
    '--provider',
    plan.provider,
    '--components',
    [...plan.components].join(','),
  ]
  writeFileSync(
    log,
    `delete-session: waiting for ${plan.provider} ${plan.id} to finish\n`,
  )
  const fd = openSync(log, 'a')
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: {
      ...process.env,
      DELETE_SESSION_DEFERRED: String(offset),
      DELETE_SESSION_DEFERRED_LOG: log,
    },
  })
  closeSync(fd)
  child.unref()
  process.stdout.write(
    `delete-session: scheduled after this turn finishes; status log: ${log}\n`,
  )
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    provider: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'archive-workspace': { type: 'boolean' },
    components: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})
if (values.help) {
  process.stdout.write(
    'Usage: bun delete-session.ts [<session-uuid>] [--provider claude|codex] [--dry-run] [--components session,agent,workspace | --archive-workspace]\n',
  )
  process.exit(0)
}
if (positionals.length > 1) fail('pass at most one session UUID')
if (
  values.provider &&
  values.provider !== 'claude' &&
  values.provider !== 'codex'
)
  fail('--provider must be claude or codex')
if (values.components !== undefined && values['archive-workspace'])
  fail('pass --components or --archive-workspace, not both')

function selectedComponents(): ReadonlySet<Component> {
  if (values.components === undefined)
    return new Set<Component>(
      values['archive-workspace']
        ? ['session', 'agent', 'workspace']
        : ['session', 'agent'],
    )
  const names = values.components.split(',')
  if (
    names.some((name) => !['session', 'agent', 'workspace'].includes(name)) ||
    new Set(names).size !== names.length
  )
    fail(
      '--components must be a nonempty comma-separated subset of session,agent,workspace',
    )
  return new Set(names as Component[])
}

try {
  const target = resolveTarget(
    positionals[0],
    values.provider as Provider | undefined,
  )
  const plan = makePlan(target, selectedComponents())
  report(plan, values['dry-run'] ?? false)
  if (values['dry-run']) process.exit(0)
  const deferredOffset = process.env.DELETE_SESSION_DEFERRED
  if (deferredOffset !== undefined) {
    const log = process.env.DELETE_SESSION_DEFERRED_LOG
    try {
      await deferred(plan, Number(deferredOffset))
      if (log) await Bun.write(log, 'delete-session: completed\n')
    } catch (error) {
      if (log) await Bun.write(log, `delete-session: ${String(error)}\n`)
      throw error
    }
  } else if (plan.self) schedule(plan)
  else await execute(plan)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
