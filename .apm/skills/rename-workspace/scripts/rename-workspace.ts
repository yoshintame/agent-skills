#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

enum WorkspaceStatus {
  Active = 'active',
  Done = 'done',
  Paused = 'paused',
}

interface ParsedArgs {
  feature?: string
  status: WorkspaceStatus
}

interface PaseoAgent {
  id: string
  workspaceId: string
}

interface WorkspaceLabel {
  name: string
  color: string
}

const STATUS_COLOR = {
  [WorkspaceStatus.Active]: 'red',
  [WorkspaceStatus.Paused]: 'orange',
  [WorkspaceStatus.Done]: 'emerald',
} as const satisfies Record<WorkspaceStatus, string>
const STATUS_NAMES = Object.values(WorkspaceStatus)
const FEATURE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const STATUS_EMOJI_PREFIX = /^(🔴|🟡|🟢) /u
const MAX_VISIBLE_LEN = 80
const DEFAULT_DAEMON_HOST = '127.0.0.1:6767'
const DAEMON_TIMEOUT_MS = 8000

if (import.meta.main) await main()

async function main(): Promise<void> {
  const { feature: explicitFeature, status } = parseArgs(process.argv.slice(2))
  const providerId = resolveProviderId(process.env)
  const agent = findPaseoAgent(providerId)
  if (agent === undefined) die('no Paseo agent matches the current provider session')

  const feature = explicitFeature ?? readCurrentFeature(agent.workspaceId)
  if (feature === undefined) die('feature is required when the current workspace has no title')
  validateFeature(feature)

  renameWorkspace(agent.workspaceId, feature)
  const skipped = await applyStatusLabel(agent.workspaceId, status)

  process.stdout.write(
    skipped === undefined
      ? `${feature} [${status}]\n`
      : `${feature} [${status}] (status label skipped: ${skipped})\n`,
  )
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let status = WorkspaceStatus.Active
  const positional: string[] = []

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) break
    if (arg === '--status') {
      status = parseStatus(argv[++index])
    } else if (arg.startsWith('--status=')) {
      status = parseStatus(arg.slice('--status='.length))
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: rename-workspace.ts [--status active|paused|done] [kebab-feature]\n',
      )
      process.exit(0)
    } else if (arg.startsWith('-')) {
      die(`unknown flag ${JSON.stringify(arg)}`)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 1) {
    die(`expected at most one feature, got ${positional.length}: ${positional.join(' ')}`)
  }
  return { feature: positional[0], status }
}

function parseStatus(value: unknown): WorkspaceStatus {
  if (value === WorkspaceStatus.Active) return value
  if (value === WorkspaceStatus.Paused) return value
  if (value === WorkspaceStatus.Done) return value
  die(`--status must be active|paused|done, got ${JSON.stringify(value)}`)
}

function resolveProviderId(env: NodeJS.ProcessEnv): string {
  const codexId = env.CODEX_THREAD_ID
  const claudeId = env.CLAUDE_CODE_SESSION_ID

  if (codexId !== undefined && claudeId !== undefined) {
    die('both CODEX_THREAD_ID and CLAUDE_CODE_SESSION_ID are set; refusing ambiguous rename')
  }
  if (codexId !== undefined) return codexId
  if (claudeId !== undefined) return claudeId
  die('neither CODEX_THREAD_ID nor CLAUDE_CODE_SESSION_ID is set')
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

function readCurrentFeature(workspaceId: string): string | undefined {
  const path = join(homedir(), '.paseo', 'projects', 'workspaces.json')
  if (!existsSync(path)) return undefined

  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value)) return undefined
  const workspace = value.find(
    (candidate) => isRecord(candidate) && candidate.workspaceId === workspaceId,
  )
  if (!isRecord(workspace)) return undefined
  const title = readString(workspace.title)
  if (title === undefined || title.length === 0) return undefined
  return title.replace(STATUS_EMOJI_PREFIX, '')
}

function validateFeature(value: string): void {
  if (!FEATURE_REGEX.test(value)) die('feature must be lowercase English kebab-case')
  if ([...value].length > MAX_VISIBLE_LEN) {
    die(`workspace feature length exceeds ${MAX_VISIBLE_LEN}: ${JSON.stringify(value)}`)
  }
}

function renameWorkspace(workspaceId: string, feature: string): void {
  const result = Bun.spawnSync(['paseo', 'workspace', 'rename', workspaceId, feature])
  if (result.success) return

  const stderr = result.stderr.toString().trim()
  die(`Paseo workspace rename failed${stderr.length === 0 ? '' : `: ${stderr}`}`)
}

async function applyStatusLabel(
  workspaceId: string,
  status: WorkspaceStatus,
): Promise<string | undefined> {
  let daemon: DaemonConnection | undefined
  try {
    daemon = await DaemonConnection.connect(resolveDaemonUrl(), DAEMON_TIMEOUT_MS)

    // Assigning a not-yet-catalogued label creates it with the given colour, so the
    // catalog fills in idempotently from here — the daemon has no separate create call.
    const response = await daemon.setAssignment(
      workspaceId,
      { name: status, color: STATUS_COLOR[status] },
      true,
    )

    const assigned = new Set(response.workspaceLabels.map((name) => name.toLowerCase()))
    for (const other of STATUS_NAMES) {
      if (other === status || !assigned.has(other)) continue
      await daemon.setAssignment(workspaceId, { name: other, color: STATUS_COLOR[other] }, false)
    }
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    daemon?.close()
  }
}

function resolveDaemonUrl(): string {
  return `ws://${readDaemonListen() ?? DEFAULT_DAEMON_HOST}/ws`
}

function readDaemonListen(): string | undefined {
  const fromEnv = process.env.PASEO_LISTEN
  if (fromEnv !== undefined && fromEnv.includes(':')) return fromEnv

  const home = homedir()
  const fromPid = readJsonField(join(home, '.paseo', 'paseo.pid'), (value) =>
    readString(value.listen),
  )
  if (fromPid !== undefined && fromPid.includes(':')) return fromPid

  const fromConfig = readJsonField(join(home, '.paseo', 'config.json'), (value) =>
    readString(isRecord(value.daemon) ? value.daemon.listen : undefined),
  )
  if (fromConfig !== undefined && fromConfig.includes(':')) return fromConfig
  return undefined
}

function resolveDaemonPassword(): string | undefined {
  const fromEnv = process.env.PASEO_PASSWORD
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv

  const fromConfig = readJsonField(join(homedir(), '.paseo', 'config.json'), (value) =>
    readString(isRecord(value.daemon) ? value.daemon.password : undefined),
  )
  return fromConfig !== undefined && fromConfig.length > 0 ? fromConfig : undefined
}

function readClientId(): string {
  return readFileSync(join(homedir(), '.paseo', 'cli-client-id'), 'utf8').trim()
}

interface PendingRequest {
  responseType: string
  resolve: (payload: Record<string, unknown>) => void
  reject: (error: Error) => void
}

class DaemonConnection {
  private readonly socket: WebSocket
  private readonly pending = new Map<string, PendingRequest>()
  private counter = 0
  private ready?: () => void

  private constructor(socket: WebSocket) {
    this.socket = socket
  }

  static connect(url: string, timeoutMs: number): Promise<DaemonConnection> {
    const clientId = readClientId()
    const password = resolveDaemonPassword()
    const socket = openSocket(url, password)
    const connection = new DaemonConnection(socket)

    return new Promise<DaemonConnection>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.close()
        reject(new Error(`daemon connection timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      connection.ready = () => {
        clearTimeout(timer)
        resolve(connection)
      }
      socket.addEventListener('open', () => connection.sendHello(clientId))
      socket.addEventListener('message', (event) => connection.handleMessage(event))
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        connection.failAll(new Error('daemon websocket error'))
        reject(new Error('daemon websocket error'))
      })
      socket.addEventListener('close', () => {
        clearTimeout(timer)
        connection.failAll(new Error('daemon connection closed'))
        reject(new Error('daemon connection closed before server_info'))
      })
    })
  }

  async setAssignment(
    workspaceId: string,
    label: WorkspaceLabel,
    assigned: boolean,
  ): Promise<{ workspaceLabels: string[] }> {
    const payload = await this.request({
      type: 'workspace.label.assignment.set.request',
      workspaceId,
      label,
      assigned,
    })
    const workspaceLabels = Array.isArray(payload.workspaceLabels)
      ? payload.workspaceLabels.filter((value): value is string => typeof value === 'string')
      : []
    return { workspaceLabels }
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      // no-op
    }
  }

  private request(
    message: Record<string, unknown>,
    timeoutMs = DAEMON_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const type = readString(message.type)
    if (type === undefined) return Promise.reject(new Error('request message missing type'))
    const responseType = type.replace(/\.request$/, '.response')
    const requestId = `rw-${Date.now()}-${(this.counter += 1)}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`daemon request ${type} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(requestId, {
        responseType,
        resolve: (payload) => {
          clearTimeout(timer)
          resolve(payload)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })

      try {
        this.socket.send(JSON.stringify({ type: 'session', message: { ...message, requestId } }))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private sendHello(clientId: string): void {
    this.socket.send(
      JSON.stringify({
        type: 'hello',
        clientId,
        clientType: 'cli',
        protocolVersion: 1,
        capabilities: {},
      }),
    )
  }

  private handleMessage(event: MessageEvent): void {
    const message = parseSessionMessage(event.data)
    if (message === undefined) return

    if (message.type === 'status') {
      if (isRecord(message.payload) && message.payload.status === 'server_info') {
        this.ready?.()
        this.ready = undefined
      }
      return
    }

    const payload = isRecord(message.payload) ? message.payload : undefined
    const requestId = readString(payload?.requestId)
    if (requestId === undefined) return
    const waiter = this.pending.get(requestId)
    if (waiter === undefined) return
    if (message.type !== 'rpc_error' && message.type !== waiter.responseType) return

    this.pending.delete(requestId)
    if (message.type === 'rpc_error') {
      waiter.reject(new Error(readString(payload?.error) ?? `daemon rpc error (${requestId})`))
      return
    }
    waiter.resolve(payload ?? {})
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
  }
}

function openSocket(url: string, password: string | undefined): WebSocket {
  if (password === undefined) return new WebSocket(url)
  const options = {
    headers: { Authorization: `Bearer ${password}` },
    protocols: [`paseo.bearer.${password}`],
  }
  return new WebSocket(url, options as unknown as string[])
}

function parseSessionMessage(data: unknown): { type: string; payload?: unknown } | undefined {
  if (typeof data !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.type !== 'session' || !isRecord(parsed.message)) return undefined
  const type = readString(parsed.message.type)
  if (type === undefined) return undefined
  return { type, payload: parsed.message.payload }
}

function readJsonField<T>(
  path: string,
  pick: (value: Record<string, unknown>) => T | undefined,
): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(value) ? pick(value) : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function die(message: string): never {
  process.stderr.write(`rename-workspace: ${message}\n`)
  process.exit(1)
}
