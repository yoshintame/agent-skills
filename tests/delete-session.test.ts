import { afterEach, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const script = join(
  import.meta.dir,
  '..',
  '.apm',
  'skills',
  'delete-session',
  'scripts',
  'delete-session.ts',
)
const id = '12345678-1234-4234-8234-123456789abc'
const agentId = '87654321-4321-4321-8321-cba987654321'
const otherAgentId = '87654321-4321-4321-8321-cba987654322'
const workspaceId = 'wks_1234567890abcdef'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'delete-session-test-'))
  roots.push(root)
  const log = join(root, 'commands.log')
  const mock = join(root, 'mock.ts')
  writeFileSync(
    mock,
    `#!/usr/bin/env bun\nimport { appendFileSync } from "node:fs"\nappendFileSync(process.env.MOCK_LOG!, process.argv.slice(1).join(" ") + "\\n")\nif (process.env.MOCK_FAIL === "1") process.exit(1)\n`,
  )
  chmodSync(mock, 0o755)
  const env = {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: '',
    CODEX_THREAD_ID: '',
    CODEX_SESSION_ID: '',
    DELETE_SESSION_HOME: root,
    DELETE_SESSION_PASEO_ROOT: join(root, '.paseo', 'agents'),
    DELETE_SESSION_CODEX_COMMAND: mock,
    DELETE_SESSION_PASEO_COMMAND: mock,
    MOCK_LOG: log,
  }
  const run = (args: string[], extra: Record<string, string> = {}) =>
    Bun.spawnSync(['bun', script, ...args], {
      env: { ...env, ...extra },
      stdout: 'pipe',
      stderr: 'pipe',
    })
  const put = (path: string, text = 'x') => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  return { root, log, env, run, put }
}

test('Claude dry run and deletion use exact UUID artifacts and Paseo metadata', () => {
  const f = fixture()
  const projectA = join(f.root, '.claude', 'projects', 'a')
  const projectB = join(f.root, '.claude', 'projects', 'b')
  const transcriptA = join(projectA, `${id}.jsonl`)
  const transcriptB = join(projectB, `${id}.jsonl`)
  f.put(transcriptA, '{}\n')
  mkdirSync(projectB, { recursive: true })
  linkSync(transcriptA, transcriptB)
  f.put(join(projectA, id, 'sidecar.txt'))
  f.put(join(f.root, '.claude', 'tasks', id, 'task.json'))
  f.put(join(f.root, '.claude', 'file-history', id, 'copy'))
  f.put(join(f.root, '.claude', 'todos', `${id}-agent-test.json`))
  f.put(join(f.root, '.claude', 'history.jsonl'), `{"sessionId":"${id}"}\n`)
  f.put(join(projectA, 'other.jsonl'))
  const agent = join(f.root, '.paseo', 'agents', 'workspace', `${agentId}.json`)
  f.put(
    agent,
    JSON.stringify({
      id: agentId,
      provider: 'claude',
      persistence: { nativeHandle: id },
    }),
  )
  f.put(
    join(f.root, '.paseo', 'agents', 'workspace', `${otherAgentId}.json`),
    JSON.stringify({
      id: otherAgentId,
      provider: 'claude',
      persistence: { nativeHandle: otherAgentId },
    }),
  )
  const dry = f.run([id, '--dry-run'])
  expect(dry.exitCode).toBe(0)
  expect(dry.stdout.toString()).toContain(`paseo delete ${agentId}`)
  expect(existsSync(transcriptA)).toBe(true)
  expect(existsSync(f.log)).toBe(false)
  const deleted = f.run([id])
  expect(deleted.exitCode).toBe(0)
  expect(readFileSync(f.log, 'utf8')).toBe(
    `${realpathSync(join(f.root, 'mock.ts'))} delete ${agentId}\n`,
  )
  for (const path of [
    transcriptA,
    transcriptB,
    join(projectA, id),
    join(f.root, '.claude', 'tasks', id),
    join(f.root, '.claude', 'file-history', id),
    join(f.root, '.claude', 'todos', `${id}-agent-test.json`),
  ])
    expect(existsSync(path)).toBe(false)
  expect(existsSync(join(projectA, 'other.jsonl'))).toBe(true)
  expect(existsSync(join(f.root, '.claude', 'history.jsonl'))).toBe(true)
})

test('Paseo failure leaves Claude artifacts intact', () => {
  const f = fixture()
  const transcript = join(f.root, '.claude', 'projects', 'a', `${id}.jsonl`)
  f.put(transcript)
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'claude',
      runtimeInfo: { sessionId: id },
    }),
  )
  const result = f.run([id], { MOCK_FAIL: '1' })
  expect(result.exitCode).not.toBe(0)
  expect(existsSync(transcript)).toBe(true)
})

test('Codex uses native delete and provider ambiguity requires override', () => {
  const f = fixture()
  f.put(
    join(
      f.root,
      '.codex',
      'sessions',
      '2026',
      '09',
      '21',
      `rollout-now-${id}.jsonl`,
    ),
  )
  const claude = join(f.root, '.claude', 'projects', 'a', `${id}.jsonl`)
  f.put(claude)
  expect(f.run([id]).exitCode).not.toBe(0)
  const result = f.run([id, '--provider', 'codex'])
  expect(result.exitCode).toBe(0)
  expect(readFileSync(f.log, 'utf8')).toContain(`delete --force ${id}`)
  expect(existsSync(claude)).toBe(true)
})

test('workspace option archives the linked Paseo workspace after deleting the session', () => {
  const f = fixture()
  f.put(join(f.root, '.codex', 'sessions', `rollout-now-${id}.jsonl`))
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'codex',
      workspaceId,
      persistence: { nativeHandle: id },
    }),
  )
  f.put(
    join(f.root, '.paseo', 'projects', 'workspaces.json'),
    JSON.stringify([
      {
        workspaceId,
        archivedAt: null,
        cwd: '/example/worktree',
        worktreeRoot: '/example/worktree',
        isPaseoOwnedWorktree: true,
      },
    ]),
  )
  const dry = f.run([
    id,
    '--provider',
    'codex',
    '--archive-workspace',
    '--dry-run',
  ])
  expect(dry.exitCode).toBe(0)
  expect(dry.stdout.toString()).toContain(
    `paseo workspace archive ${workspaceId}`,
  )
  expect(dry.stdout.toString()).toContain(
    'Paseo-owned worktree may be removed: /example/worktree',
  )
  expect(existsSync(f.log)).toBe(false)
  const result = f.run([id, '--provider', 'codex', '--archive-workspace'])
  expect(result.exitCode).toBe(0)
  const mock = realpathSync(join(f.root, 'mock.ts'))
  expect(readFileSync(f.log, 'utf8')).toBe(
    `${mock} delete ${agentId}\n${mock} delete --force ${id}\n${mock} workspace archive ${workspaceId}\n`,
  )
})

test('workspace option refuses a workspace shared with another Paseo agent', () => {
  const f = fixture()
  f.put(join(f.root, '.codex', 'sessions', `rollout-now-${id}.jsonl`))
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'codex',
      workspaceId,
      persistence: { nativeHandle: id },
    }),
  )
  f.put(
    join(f.root, '.paseo', 'agents', `${otherAgentId}.json`),
    JSON.stringify({ id: otherAgentId, provider: 'claude', workspaceId }),
  )
  f.put(
    join(f.root, '.paseo', 'projects', 'workspaces.json'),
    JSON.stringify([{ workspaceId, archivedAt: null, cwd: '/example/repo' }]),
  )
  const result = f.run([id, '--provider', 'codex', '--archive-workspace'])
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain(otherAgentId)
  expect(existsSync(f.log)).toBe(false)
})

test('workspace option refuses a session without a linked Paseo agent', () => {
  const f = fixture()
  f.put(join(f.root, '.codex', 'sessions', `rollout-now-${id}.jsonl`))
  const result = f.run([id, '--provider', 'codex', '--archive-workspace'])
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain('requires a linked Paseo agent')
  expect(existsSync(f.log)).toBe(false)
})

test('component selection can delete only the provider session', () => {
  const f = fixture()
  const transcript = join(f.root, '.claude', 'projects', 'a', `${id}.jsonl`)
  f.put(transcript)
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'claude',
      persistence: { nativeHandle: id },
    }),
  )
  const dry = f.run([id, '--components', 'session', '--dry-run'])
  expect(dry.exitCode).toBe(0)
  expect(dry.stdout.toString()).toContain(`remove ${transcript}`)
  expect(dry.stdout.toString()).toContain('Paseo agent retained')
  expect(dry.stdout.toString()).not.toContain(`paseo delete ${agentId}`)
  const result = f.run([id, '--components', 'session'])
  expect(result.exitCode).toBe(0)
  expect(existsSync(transcript)).toBe(false)
  expect(existsSync(f.log)).toBe(false)
})

test('component selection can delete only the Paseo agent', () => {
  const f = fixture()
  const transcript = join(f.root, '.claude', 'projects', 'a', `${id}.jsonl`)
  f.put(transcript)
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'claude',
      persistence: { nativeHandle: id },
    }),
  )
  const dry = f.run([id, '--components', 'agent', '--dry-run'])
  expect(dry.exitCode).toBe(0)
  expect(dry.stdout.toString()).toContain(`paseo delete ${agentId}`)
  expect(dry.stdout.toString()).not.toContain(`remove ${transcript}`)
  const result = f.run([id, '--components', 'agent'])
  expect(result.exitCode).toBe(0)
  expect(readFileSync(f.log, 'utf8')).toContain(`delete ${agentId}`)
  expect(existsSync(transcript)).toBe(true)
})

test('agent-only selection fails when no linked Paseo agent exists', () => {
  const f = fixture()
  f.put(join(f.root, '.claude', 'projects', 'a', `${id}.jsonl`))
  const result = f.run([id, '--components', 'agent', '--dry-run'])
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain('no linked Paseo agent')
  expect(existsSync(f.log)).toBe(false)
})

test('workspace alone archives without deleting provider session or Paseo agent', () => {
  const f = fixture()
  const rollout = join(f.root, '.codex', 'sessions', `rollout-now-${id}.jsonl`)
  f.put(rollout)
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'codex',
      workspaceId,
      persistence: { nativeHandle: id },
    }),
  )
  f.put(
    join(f.root, '.paseo', 'projects', 'workspaces.json'),
    JSON.stringify([{ workspaceId, archivedAt: null, cwd: '/example/repo' }]),
  )
  const dry = f.run([id, '--components', 'workspace', '--dry-run'])
  expect(dry.exitCode).toBe(0)
  expect(dry.stdout.toString()).toContain(
    `paseo workspace archive ${workspaceId}`,
  )
  expect(dry.stdout.toString()).toContain('archives its agents')
  expect(dry.stdout.toString()).not.toContain(`paseo delete ${agentId}`)
  expect(dry.stdout.toString()).not.toContain(`delete --force ${id}`)
  const result = f.run([id, '--components', 'workspace'])
  expect(result.exitCode).toBe(0)
  expect(readFileSync(f.log, 'utf8')).toContain(
    `workspace archive ${workspaceId}`,
  )
  expect(readFileSync(f.log, 'utf8')).not.toContain('delete ')
  expect(existsSync(rollout)).toBe(true)
})

test('workspace component refuses a workspace with an unrelated agent', () => {
  const f = fixture()
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'codex',
      workspaceId,
      persistence: { nativeHandle: id },
    }),
  )
  f.put(
    join(f.root, '.paseo', 'agents', `${otherAgentId}.json`),
    JSON.stringify({ id: otherAgentId, provider: 'codex', workspaceId }),
  )
  const result = f.run([id, '--components', 'workspace'])
  expect(result.exitCode).not.toBe(0)
  expect(result.stderr.toString()).toContain(otherAgentId)
  expect(existsSync(f.log)).toBe(false)
})

test('session and workspace selection reports the linked agent as archived and retained', () => {
  const f = fixture()
  f.put(join(f.root, '.codex', 'sessions', `rollout-now-${id}.jsonl`))
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'codex',
      workspaceId,
      persistence: { nativeHandle: id },
    }),
  )
  f.put(
    join(f.root, '.paseo', 'projects', 'workspaces.json'),
    JSON.stringify([{ workspaceId, archivedAt: null, cwd: '/example/repo' }]),
  )
  const result = f.run([id, '--components', 'session,workspace', '--dry-run'])
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('Paseo agent retained')
  expect(result.stdout.toString()).toContain(
    'workspace archive will archive it',
  )
  expect(result.stdout.toString()).not.toContain(`paseo delete ${agentId}`)
})

test('active Claude guard only applies when provider session is selected', () => {
  const f = fixture()
  const transcript = join(f.root, '.claude', 'projects', 'a', `${id}.jsonl`)
  f.put(transcript)
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'claude',
      persistence: { nativeHandle: id },
    }),
  )
  f.put(
    join(f.root, '.claude', 'sessions', `${process.pid}.json`),
    JSON.stringify({ sessionId: id, pid: process.pid, procStart: 'invalid' }),
  )
  const agent = f.run([id, '--components', 'agent'])
  expect(agent.exitCode).toBe(0)
  expect(readFileSync(f.log, 'utf8')).toContain(`delete ${agentId}`)
  expect(existsSync(transcript)).toBe(true)
  const session = f.run([id, '--components', 'session'])
  expect(session.exitCode).not.toBe(0)
  expect(session.stderr.toString()).toContain(
    'cannot inspect active Claude PID',
  )
  expect(existsSync(transcript)).toBe(true)
})

test('component argument requires an exact nonempty subset and excludes legacy workspace flag', () => {
  const f = fixture()
  for (const components of [
    '',
    'session,',
    'session,session',
    'Session',
    'session, workspace',
    'unknown',
  ]) {
    const result = f.run([
      id,
      '--provider',
      'claude',
      '--components',
      components,
    ])
    expect(result.exitCode).not.toBe(0)
  }
  const conflicting = f.run([
    id,
    '--provider',
    'claude',
    '--components',
    'session',
    '--archive-workspace',
  ])
  expect(conflicting.exitCode).not.toBe(0)
  expect(existsSync(f.log)).toBe(false)
})

test('deferred self selection preserves agent-only operation', async () => {
  const f = fixture()
  const rollout = join(f.root, '.codex', 'sessions', `rollout-now-${id}.jsonl`)
  f.put(rollout, '{}\n')
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'codex',
      persistence: { nativeHandle: id },
    }),
  )
  const result = f.run(['--components', 'agent'], {
    CODEX_THREAD_ID: id,
    TMPDIR: f.root,
  })
  expect(result.exitCode).toBe(0)
  writeFileSync(
    rollout,
    `${readFileSync(rollout, 'utf8')}{"type":"event_msg","payload":{"type":"task_complete"}}\n`,
  )
  const deadline = Date.now() + 5000
  while (
    Date.now() < deadline &&
    (!existsSync(f.log) ||
      !readFileSync(f.log, 'utf8').includes(`delete ${agentId}`))
  )
    await Bun.sleep(100)
  expect(readFileSync(f.log, 'utf8')).toContain(`delete ${agentId}`)
  expect(readFileSync(f.log, 'utf8')).not.toContain(`delete --force ${id}`)
  expect(existsSync(rollout)).toBe(true)
})

test('deferred workspace archive keeps its option through the current turn', async () => {
  const f = fixture()
  const rollout = join(f.root, '.codex', 'sessions', `rollout-now-${id}.jsonl`)
  f.put(rollout, '{}\n')
  f.put(
    join(f.root, '.paseo', 'agents', `${agentId}.json`),
    JSON.stringify({
      id: agentId,
      provider: 'codex',
      workspaceId,
      persistence: { nativeHandle: id },
    }),
  )
  f.put(
    join(f.root, '.paseo', 'projects', 'workspaces.json'),
    JSON.stringify([{ workspaceId, archivedAt: null, cwd: '/example/repo' }]),
  )
  const result = f.run(['--archive-workspace'], {
    CODEX_THREAD_ID: id,
    TMPDIR: f.root,
  })
  expect(result.exitCode).toBe(0)
  writeFileSync(
    rollout,
    `${readFileSync(rollout, 'utf8')}{"type":"event_msg","payload":{"type":"task_complete"}}\n`,
  )
  const deadline = Date.now() + 5000
  while (
    Date.now() < deadline &&
    (!existsSync(f.log) ||
      !readFileSync(f.log, 'utf8').includes(`workspace archive ${workspaceId}`))
  )
    await Bun.sleep(100)
  expect(readFileSync(f.log, 'utf8')).toContain(
    `workspace archive ${workspaceId}`,
  )
})

test('symlinked project trees are never traversed', () => {
  const f = fixture()
  const outside = join(f.root, 'outside', `${id}.jsonl`)
  f.put(outside)
  const projects = join(f.root, '.claude', 'projects')
  mkdirSync(projects, { recursive: true })
  symlinkSync(dirname(outside), join(projects, 'linked'))
  const result = f.run([id, '--provider', 'claude'])
  expect(result.exitCode).toBe(0)
  expect(existsSync(outside)).toBe(true)
})

test('deferred self deletion cancels when a new user turn starts', async () => {
  const f = fixture()
  const rollout = join(
    f.root,
    '.codex',
    'sessions',
    '2026',
    '09',
    '21',
    `rollout-now-${id}.jsonl`,
  )
  f.put(rollout, '{}\n')
  const log = join(f.root, `delete-session-${id}.log`)
  const result = f.run([], { CODEX_THREAD_ID: id, TMPDIR: f.root })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain('scheduled after this turn')
  writeFileSync(
    rollout,
    `${readFileSync(rollout, 'utf8')}{"type":"event_msg","payload":{"type":"task_complete"}}\n{"type":"response_item","payload":{"type":"message","role":"user"}}\n`,
  )
  const deadline = Date.now() + 5000
  while (
    Date.now() < deadline &&
    (!existsSync(log) || !readFileSync(log, 'utf8').includes('cancelled'))
  )
    await Bun.sleep(100)
  expect(readFileSync(log, 'utf8')).toContain('cancelled')
  expect(existsSync(f.log)).toBe(false)
})

test('deferred self deletion runs after the Codex turn completes', async () => {
  const f = fixture()
  const rollout = join(
    f.root,
    '.codex',
    'sessions',
    '2026',
    '09',
    '21',
    `rollout-now-${id}.jsonl`,
  )
  f.put(rollout, '{}\n')
  const result = f.run([], { CODEX_THREAD_ID: id, TMPDIR: f.root })
  expect(result.exitCode).toBe(0)
  writeFileSync(
    rollout,
    `${readFileSync(rollout, 'utf8')}{"type":"event_msg","payload":{"type":"task_complete"}}\n`,
  )
  const deadline = Date.now() + 5000
  while (
    Date.now() < deadline &&
    (!existsSync(f.log) ||
      !readFileSync(f.log, 'utf8').includes(`delete --force ${id}`))
  )
    await Bun.sleep(100)
  expect(readFileSync(f.log, 'utf8')).toContain(`delete --force ${id}`)
})

test('deferred deletion cancels when a new Codex task starts', async () => {
  const f = fixture()
  const rollout = join(
    f.root,
    '.codex',
    'sessions',
    '2026',
    '09',
    '21',
    `rollout-now-${id}.jsonl`,
  )
  f.put(rollout, '{}\n')
  const log = join(f.root, `delete-session-${id}.log`)
  const result = f.run([], { CODEX_THREAD_ID: id, TMPDIR: f.root })
  expect(result.exitCode).toBe(0)
  writeFileSync(
    rollout,
    `${readFileSync(rollout, 'utf8')}{"type":"event_msg","payload":{"type":"task_complete"}}\n{"type":"event_msg","payload":{"type":"task_started"}}\n`,
  )
  const deadline = Date.now() + 5000
  while (
    Date.now() < deadline &&
    (!existsSync(log) || !readFileSync(log, 'utf8').includes('cancelled'))
  )
    await Bun.sleep(100)
  expect(readFileSync(log, 'utf8')).toContain('cancelled')
  expect(existsSync(f.log)).toBe(false)
})
