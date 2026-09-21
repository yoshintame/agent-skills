import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { SESSION_TYPE_SIGNATURES } from '../.apm/skills/rename-session/scripts/append-custom-title'

const script = resolve(
  import.meta.dir,
  '..',
  '.apm',
  'skills',
  'rename-session',
  'scripts',
  'append-custom-title.ts',
)
const workspaceScript = resolve(
  import.meta.dir,
  '..',
  '.apm',
  'skills',
  'rename-workspace',
  'scripts',
  'rename-workspace.ts',
)
const renameSessionSkill = resolve(
  import.meta.dir,
  '..',
  '.apm',
  'skills',
  'rename-session',
  'SKILL.md',
)
const fakeWebSocket = resolve(
  import.meta.dir,
  'fixtures',
  'fake-paseo-websocket.ts',
)

let cwd: string
let home: string
let bin: string
let calls: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'rename-session-cwd-'))
  home = mkdtempSync(join(tmpdir(), 'rename-session-home-'))
  bin = join(home, 'bin')
  calls = join(home, 'calls.jsonl')
  mkdirSync(bin)
})

afterEach(() => {
  rmSync(cwd, { force: true, recursive: true })
  rmSync(home, { force: true, recursive: true })
})

test('rejects a title without a session type', () => {
  const result = run(['rename-session-backends'], {
    CLAUDE_CODE_SESSION_ID: 'claude-1',
  })

  expect(result.success).toBe(false)
  expect(result.stderr).toContain('session type must be one of:')
  expect(result.stderr).toContain('impl')
  expect(result.stderr).toContain('ask')
})

test('keeps the skill type table synchronized with the script source of truth', () => {
  const skill = readFileSync(renameSessionSkill, 'utf8')
  const rows = [...skill.matchAll(/^\| `([^`]+)` \| ([^|]+) \|$/gm)].map(
    ([, type, signature]) => [type, signature.trim()],
  )

  expect(Object.fromEntries(rows)).toEqual(SESSION_TYPE_SIGNATURES)
})

test('rejects a prefix outside the closed session type enum', () => {
  const result = run(['docs/rename-session-backends'], {
    CLAUDE_CODE_SESSION_ID: 'claude-1',
  })

  expect(result.success).toBe(false)
  expect(result.stderr).toContain('session type must be one of:')
  expect(result.stderr).toContain('impl')
  expect(result.stderr).toContain('ask')
})

test('appends a validated name to the exact Claude session JSONL', () => {
  const selected = writeClaudeSession('claude-selected', '{"type":"user"}\n')
  const other = writeClaudeSession(
    'claude-other',
    '{"type":"user","recent":true}\n',
  )

  const result = run(['--status', 'done', 'impl/rename-session-backends'], {
    CLAUDE_CODE_SESSION_ID: 'claude-selected',
  })

  expect(result.success, result.stderr).toBe(true)
  expect(result.stdout).toBe('(unnamed) → 🟢 impl/rename-session-backends\n')
  expect(readFileSync(selected, 'utf8')).toBe(
    '{"type":"user"}\n{"type":"custom-title","sessionId":"claude-selected","customTitle":"🟢 impl/rename-session-backends"}\n',
  )
  expect(readFileSync(other, 'utf8')).toBe('{"type":"user","recent":true}\n')
})

test('renames the exact Codex thread through App Server without touching Claude JSONL', () => {
  writeCodexStub()
  const claudeJsonl = writeClaudeSession('claude-other', '{"type":"user"}\n')

  const result = run(['--status=paused', 'groom/rename-session-contract'], {
    CODEX_THREAD_ID: 'codex-thread-1',
  })

  expect(result.success, result.stderr).toBe(true)
  expect(result.stdout).toBe('(unnamed) → 🟡 groom/rename-session-contract\n')
  expect(readFileSync(claudeJsonl, 'utf8')).toBe('{"type":"user"}\n')
  const [call] = readCalls()
  expect(call.args).toEqual(['app-server', '--stdio'])
  expect(
    call.input
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line)),
  ).toEqual([
    {
      id: 1,
      method: 'initialize',
      params: {
        capabilities: { experimentalApi: true },
        clientInfo: { name: 'rename-session', version: '0.1.0' },
      },
    },
    {
      id: 2,
      method: 'thread/name/set',
      params: {
        name: '🟡 groom/rename-session-contract',
        threadId: 'codex-thread-1',
      },
    },
  ])
})

test('fails closed when neither provider session ID exists', () => {
  const jsonl = writeClaudeSession('recent-session', '{"type":"user"}\n')

  const result = run(['impl/rename-session-backends'])

  expect(result.success).toBe(false)
  expect(result.stderr).toContain(
    'neither CODEX_THREAD_ID nor CLAUDE_CODE_SESSION_ID is set',
  )
  expect(readFileSync(jsonl, 'utf8')).toBe('{"type":"user"}\n')
})

test('fails closed when both provider session IDs exist', () => {
  writeCodexStub()
  const jsonl = writeClaudeSession('claude-1', '{"type":"user"}\n')

  const result = run(['impl/rename-session-backends'], {
    CLAUDE_CODE_SESSION_ID: 'claude-1',
    CODEX_THREAD_ID: 'codex-thread-1',
  })

  expect(result.success).toBe(false)
  expect(result.stderr).toContain(
    'both CODEX_THREAD_ID and CLAUDE_CODE_SESSION_ID are set',
  )
  expect(readFileSync(jsonl, 'utf8')).toBe('{"type":"user"}\n')
  expect(existsSync(calls)).toBe(false)
})

test('renames the matching Paseo agent and seeds an untitled workspace', () => {
  writeCodexStub()
  writePaseoStub()
  writePaseoAgent({ nativeHandle: 'codex-thread-1', workspaceId: 'wks-1' })
  writePaseoWorkspaces([{ title: null, workspaceId: 'wks-1' }])

  const result = run(
    [
      '--feature',
      'multiprovider-session-naming',
      'impl/rename-session-backends',
    ],
    { CODEX_THREAD_ID: 'codex-thread-1' },
  )

  expect(result.success, result.stderr).toBe(true)
  expect(paseoCalls()).toEqual([
    ['agent', 'update', 'agent-1', '--name', '🔴 impl/rename-session-backends'],
    ['workspace', 'rename', 'wks-1', 'multiprovider-session-naming'],
  ])
})

test('does not overwrite an existing Paseo workspace title', () => {
  writeCodexStub()
  writePaseoStub()
  writePaseoAgent({ nativeHandle: 'codex-thread-1', workspaceId: 'wks-1' })
  writePaseoWorkspaces([{ title: '🔴 existing-feature', workspaceId: 'wks-1' }])

  const result = run(
    ['--feature', 'replacement-feature', 'review/rename-session-backends'],
    {
      CODEX_THREAD_ID: 'codex-thread-1',
    },
  )

  expect(result.success, result.stderr).toBe(true)
  expect(paseoCalls()).toEqual([
    [
      'agent',
      'update',
      'agent-1',
      '--name',
      '🔴 review/rename-session-backends',
    ],
  ])
})

test('matches a Paseo agent by runtime session ID when nativeHandle is absent', () => {
  writeCodexStub()
  writePaseoStub()
  writePaseoAgent({ runtimeSessionId: 'codex-thread-1', workspaceId: 'wks-1' })
  writePaseoWorkspaces([{ title: null, workspaceId: 'wks-1' }])

  const result = run(['impl/rename-session-backends'], {
    CODEX_THREAD_ID: 'codex-thread-1',
  })

  expect(result.success, result.stderr).toBe(true)
  expect(paseoCalls()).toEqual([
    ['agent', 'update', 'agent-1', '--name', '🔴 impl/rename-session-backends'],
  ])
})

test('keeps a successful provider rename when Paseo commands fail', () => {
  writeCodexStub()
  writePaseoStub()
  writePaseoAgent({ nativeHandle: 'codex-thread-1', workspaceId: 'wks-1' })
  writePaseoWorkspaces([{ title: null, workspaceId: 'wks-1' }])

  const result = run(
    [
      '--feature',
      'multiprovider-session-naming',
      'impl/rename-session-backends',
    ],
    { CODEX_THREAD_ID: 'codex-thread-1', TEST_FAIL_PASEO: '1' },
  )

  expect(result.success, result.stderr).toBe(true)
  expect(result.stdout).toBe('(unnamed) → 🔴 impl/rename-session-backends\n')
  expect(paseoCalls()).toHaveLength(2)
})

test('drops the emoji from the title and swaps the status label for the current workspace', () => {
  writePaseoStub()
  writeCliClientId()
  writePaseoAgent({ nativeHandle: 'codex-thread-1', workspaceId: 'wks-1' })
  writePaseoWorkspaces([
    { title: '🔴 multiprovider-session-naming', workspaceId: 'wks-1' },
  ])
  const result = runWorkspace(['--status', 'done'], {
    CODEX_THREAD_ID: 'codex-thread-1',
    ...fakeSocketEnv(['wks-1:active']),
  })

  expect(result.success, result.stderr).toBe(true)
  expect(result.stdout).toBe('multiprovider-session-naming [done]\n')
  expect(paseoCalls()).toEqual([
    ['workspace', 'rename', 'wks-1', 'multiprovider-session-naming'],
  ])
  expect(labelCalls()).toEqual([
    { assigned: true, color: 'emerald', name: 'done', workspaceId: 'wks-1' },
    { assigned: false, color: 'red', name: 'active', workspaceId: 'wks-1' },
  ])
})

test('titles an untitled workspace with an explicit feature and sets its status label', () => {
  writePaseoStub()
  writeCliClientId()
  writePaseoAgent({
    runtimeSessionId: 'claude-session-1',
    workspaceId: 'wks-1',
  })
  writePaseoWorkspaces([{ title: null, workspaceId: 'wks-1' }])
  const result = runWorkspace(
    ['--status=active', 'multiprovider-session-naming'],
    {
      CLAUDE_CODE_SESSION_ID: 'claude-session-1',
      ...fakeSocketEnv(),
    },
  )

  expect(result.success, result.stderr).toBe(true)
  expect(result.stdout).toBe('multiprovider-session-naming [active]\n')
  expect(paseoCalls()).toEqual([
    ['workspace', 'rename', 'wks-1', 'multiprovider-session-naming'],
  ])
  expect(labelCalls()).toEqual([
    { assigned: true, color: 'red', name: 'active', workspaceId: 'wks-1' },
  ])
})

test('keeps the title rename when the daemon is unreachable and skips the label', () => {
  writePaseoStub()
  writeCliClientId()
  writePaseoAgent({ nativeHandle: 'codex-thread-1', workspaceId: 'wks-1' })
  writePaseoWorkspaces([{ title: null, workspaceId: 'wks-1' }])

  const result = runWorkspace(
    ['--status', 'done', 'multiprovider-session-naming'],
    {
      CODEX_THREAD_ID: 'codex-thread-1',
      PASEO_LISTEN: '127.0.0.1:1',
    },
  )

  expect(result.success, result.stderr).toBe(true)
  expect(result.stdout).toContain('multiprovider-session-naming [done]')
  expect(result.stdout).toContain('status label skipped')
  expect(paseoCalls()).toEqual([
    ['workspace', 'rename', 'wks-1', 'multiprovider-session-naming'],
  ])
})

test('workspace rename fails without an exact current Paseo agent match', () => {
  writePaseoStub()
  writePaseoWorkspaces([{ title: null, workspaceId: 'wks-1' }])

  const result = runWorkspace(['multiprovider-session-naming'], {
    CODEX_THREAD_ID: 'codex-thread-1',
  })

  expect(result.success).toBe(false)
  expect(result.stderr).toContain(
    'no Paseo agent matches the current provider session',
  )
  expect(existsSync(calls)).toBe(false)
})

test('workspace rename rejects ambiguous Paseo agent matches', () => {
  writePaseoStub()
  writePaseoAgent({
    agentId: 'agent-1',
    nativeHandle: 'codex-thread-1',
    workspaceId: 'wks-1',
  })
  writePaseoAgent({
    agentId: 'agent-2',
    nativeHandle: 'codex-thread-1',
    workspaceId: 'wks-2',
  })
  writePaseoWorkspaces([
    { title: null, workspaceId: 'wks-1' },
    { title: null, workspaceId: 'wks-2' },
  ])

  const result = runWorkspace(['multiprovider-session-naming'], {
    CODEX_THREAD_ID: 'codex-thread-1',
  })

  expect(result.success).toBe(false)
  expect(result.stderr).toContain(
    'no Paseo agent matches the current provider session',
  )
  expect(existsSync(calls)).toBe(false)
})

test('workspace rename surfaces a Paseo CLI failure', () => {
  writePaseoStub()
  writePaseoAgent({ nativeHandle: 'codex-thread-1', workspaceId: 'wks-1' })
  writePaseoWorkspaces([{ title: null, workspaceId: 'wks-1' }])

  const result = runWorkspace(['multiprovider-session-naming'], {
    CODEX_THREAD_ID: 'codex-thread-1',
    TEST_FAIL_PASEO: '1',
  })

  expect(result.success).toBe(false)
  expect(result.stderr).toContain('Paseo workspace rename failed')
  expect(result.stdout).toBe('')
})

function run(
  args: string[],
  providerEnv: Record<string, string> = {},
): { stderr: string; stdout: string; success: boolean } {
  const env = { ...process.env }
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CODEX_THREAD_ID

  const result = Bun.spawnSync(['bun', script, ...args], {
    cwd,
    env: {
      ...env,
      ...providerEnv,
      HOME: home,
      PATH: `${bin}:${env.PATH ?? ''}`,
      TEST_CALLS: calls,
    },
  })

  return {
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
    success: result.success,
  }
}

function runWorkspace(
  args: string[],
  providerEnv: Record<string, string>,
): { stderr: string; stdout: string; success: boolean } {
  const env = { ...process.env }
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CODEX_THREAD_ID

  const command = providerEnv.PASEO_TEST_LABEL_CALLS
    ? ['bun', '--preload', fakeWebSocket, workspaceScript, ...args]
    : ['bun', workspaceScript, ...args]
  const result = Bun.spawnSync(command, {
    cwd,
    env: {
      ...env,
      ...providerEnv,
      HOME: home,
      PATH: `${bin}:${env.PATH ?? ''}`,
      TEST_CALLS: calls,
    },
  })

  return {
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
    success: result.success,
  }
}

function writeClaudeSession(sessionId: string, content: string): string {
  const projectDir = join(home, '.claude', 'projects', hashCwd(cwd))
  mkdirSync(projectDir, { recursive: true })
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(path, content)
  return path
}

function writeCodexStub(): void {
  writeExecutable(
    'codex',
    [
      '#!/usr/bin/env bun',
      "import { appendFileSync } from 'node:fs'",
      "import { createInterface } from 'node:readline'",
      'const lines = createInterface({ input: process.stdin })',
      'const input: string[] = []',
      'let initialized = false',
      "lines.on('line', line => {",
      '  const request = JSON.parse(line)',
      '  input.push(line)',
      '  if (request.id === 1) setTimeout(() => { initialized = true; process.stdout.write(\'{\\"id\\":1,\\"result\\":{}}\\n\') }, 5)',
      '  if (request.id === 2 && !initialized) process.stdout.write(\'{\\"id\\":2,\\"error\\":{\\"message\\":\\"initialize handshake incomplete\\"}}\\n\')',
      '  if (request.id === 2 && initialized) {',
      "    appendFileSync(process.env.TEST_CALLS!, JSON.stringify({ command: 'codex', args: process.argv.slice(2), input: input.join('\\n') + '\\n' }) + '\\n')",
      '    process.stdout.write(\'{\\"id\\":2,\\"result\\":{}}\\n\')',
      '  }',
      '})',
    ].join('\n'),
  )
}

function writePaseoStub(): void {
  writeExecutable(
    'paseo',
    [
      '#!/usr/bin/env bun',
      "import { appendFileSync } from 'node:fs'",
      "appendFileSync(process.env.TEST_CALLS!, JSON.stringify({ command: 'paseo', args: process.argv.slice(2) }) + '\\n')",
      "if (process.env.TEST_FAIL_PASEO === '1') process.exit(1)",
      "process.stdout.write('{}\\n')",
    ].join('\n'),
  )
}

function writePaseoAgent({
  agentId = 'agent-1',
  nativeHandle,
  runtimeSessionId,
  workspaceId,
}: {
  agentId?: string
  nativeHandle?: string
  runtimeSessionId?: string
  workspaceId: string
}): void {
  const agentDir = join(home, '.paseo', 'agents', 'project')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      persistence: nativeHandle === undefined ? {} : { nativeHandle },
      runtimeInfo:
        runtimeSessionId === undefined ? {} : { sessionId: runtimeSessionId },
      workspaceId,
    }),
  )
}

function writePaseoWorkspaces(
  workspaces: Array<{ title: string | null; workspaceId: string }>,
): void {
  const projectsDir = join(home, '.paseo', 'projects')
  mkdirSync(projectsDir, { recursive: true })
  writeFileSync(
    join(projectsDir, 'workspaces.json'),
    JSON.stringify(workspaces),
  )
}

function writeExecutable(name: string, content: string): void {
  const path = join(bin, name)
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function writeCliClientId(clientId = 'cid_test'): void {
  const paseoDir = join(home, '.paseo')
  mkdirSync(paseoDir, { recursive: true })
  writeFileSync(join(paseoDir, 'cli-client-id'), clientId)
}

function fakeSocketEnv(preassigned: string[] = []): Record<string, string> {
  return {
    PASEO_LISTEN: '127.0.0.1:1',
    PASEO_TEST_LABEL_CALLS: join(home, 'label-calls.jsonl'),
    PASEO_TEST_PREASSIGNED: preassigned.join(','),
  }
}

function labelCalls(): Array<{
  assigned: boolean
  color: string
  name: string
  workspaceId: string
}> {
  const recordFile = join(home, 'label-calls.jsonl')
  if (!existsSync(recordFile)) return []
  return readFileSync(recordFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function readCalls(): Array<{
  args: string[]
  command: string
  input?: string
}> {
  return readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function paseoCalls(): string[][] {
  return readCalls()
    .filter((call) => call.command === 'paseo')
    .map((call) => call.args)
}

function hashCwd(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '-')
}
