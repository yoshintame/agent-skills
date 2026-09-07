#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

const STATUS_EMOJI = {
  [WorkspaceStatus.Active]: '🔴',
  [WorkspaceStatus.Paused]: '🟡',
  [WorkspaceStatus.Done]: '🟢',
} as const satisfies Record<WorkspaceStatus, string>
const FEATURE_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_VISIBLE_LEN = 80

if (import.meta.main) main()

function main(): void {
  const { feature: explicitFeature, status } = parseArgs(process.argv.slice(2))
  const providerId = resolveProviderId(process.env)
  const agent = findPaseoAgent(providerId)
  if (agent === undefined) die('no Paseo agent matches the current provider session')

  const feature = explicitFeature ?? readCurrentFeature(agent.workspaceId)
  if (feature === undefined) die('feature is required when the current workspace has no title')
  validateFeature(feature)

  const name = `${STATUS_EMOJI[status]} ${feature}`
  renameWorkspace(agent.workspaceId, name)
  process.stdout.write(`${name}\n`)
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
  return title.replace(/^(🔴|🟡|🟢) /u, '')
}

function validateFeature(value: string): void {
  if (!FEATURE_REGEX.test(value)) die('feature must be lowercase English kebab-case')

  const name = `${STATUS_EMOJI[WorkspaceStatus.Active]} ${value}`
  if ([...name].length > MAX_VISIBLE_LEN) {
    die(`workspace name length exceeds ${MAX_VISIBLE_LEN}: ${JSON.stringify(name)}`)
  }
}

function renameWorkspace(workspaceId: string, name: string): void {
  const result = Bun.spawnSync(['paseo', 'workspace', 'rename', workspaceId, name])
  if (result.success) return

  const stderr = result.stderr.toString().trim()
  die(`Paseo workspace rename failed${stderr.length === 0 ? '' : `: ${stderr}`}`)
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
