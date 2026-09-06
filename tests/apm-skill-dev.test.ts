import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, '..', '.apm', 'skills', 'apm-skill-dev', 'scripts', 'apm-skill-dev.ts')
const temporaryRoots: string[] = []

interface Fixture {
  binRoot: string
  consumerRoot: string
  dotfilesRoot: string
  environment: Record<string, string>
  homeRoot: string
  logPath: string
  producerRoot: string
  root: string
  stateRoot: string
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

describe('isolated', () => {
  test('installs a single path dependency for default targets and runs the child from the caller cwd', async () => {
    const fixture = createFixture()
    const callerRoot = join(fixture.root, 'caller')
    const childResultPath = join(fixture.root, 'child.json')
    mkdirSync(callerRoot)

    const result = await runCli(
      [
        'isolated',
        '--source',
        fixture.producerRoot,
        '--skill',
        'demo',
        '--',
        process.execPath,
        '-e',
        `await Bun.write(${JSON.stringify(childResultPath)}, JSON.stringify({ cwd: process.cwd(), root: process.env.APM_DEV_ROOT }))`,
      ],
      fixture,
      callerRoot,
    )

    expect(result.exitCode).toBe(0)
    const calls = readLog(fixture.logPath)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual(['install'])
    expect(calls[0]?.manifest).toEqual({
      dependencies: { apm: [{ path: realpathSync(fixture.producerRoot), skills: ['demo'] }] },
      name: 'apm-skill-dev-consumer',
      targets: ['claude', 'codex'],
      version: '0.0.0',
    })
    const childResult = JSON.parse(readFileSync(childResultPath, 'utf8')) as Record<string, string>
    expect(childResult.cwd).toBe(callerRoot)
    expect(childResult.root).toBe(calls[0]?.cwd)
    expect(existsSync(childResult.root)).toBe(false)
  })

  test('keeps codex isolated from the Claude target and rejects leaked Claude materialization', async () => {
    const fixture = createFixture({ leakClaude: true })

    const result = await runCli(
      ['isolated', '--source', fixture.producerRoot, '--skill', 'demo', '--target', 'codex'],
      fixture,
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('unexpected Claude skills directory')
    expect(readLog(fixture.logPath)[0]?.manifest.targets).toEqual(['codex'])
  })

  test('fails when a requested skill was not materialized', async () => {
    const fixture = createFixture({ skipMaterialization: true })

    const result = await runCli(
      ['isolated', '--source', fixture.producerRoot, '--skill', 'missing', '--target', 'claude'],
      fixture,
    )

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('requested skill was not materialized')
  })
})

describe('with-dev project', () => {
  test('temporarily replaces exactly one Git source, preserves fields, then restores exact bytes and freezes production', async () => {
    const fixture = createFixture()
    const manifest = [
      'name: consumer',
      'targets: [claude]',
      'dependencies:',
      '  apm:',
      '    - git: git@github.com:owner/agent-skills.git',
      '      ref: v1.2.3',
      '      skills: [demo]',
      '      alias: personal',
      '    - git: https://github.com/other/unrelated.git',
      '      ref: main',
      'devDependencies:',
      '  apm: []',
      '',
    ].join('\n')
    const lock = 'lock: production\ntrailing: true\n'
    writeFileSync(join(fixture.consumerRoot, 'apm.yml'), manifest)
    writeFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), lock)
    const observedPath = join(fixture.root, 'observed.json')

    const result = await runCli([
      'with-dev',
      '--scope',
      'project',
      '--consumer',
      fixture.consumerRoot,
      '--source',
      fixture.producerRoot,
      '--dependency',
      'agent-skills',
      '--',
      process.execPath,
      '-e',
      `const manifest = Bun.YAML.parse(await Bun.file('apm.yml').text()); await Bun.write(${JSON.stringify(observedPath)}, JSON.stringify({ cwd: process.cwd(), dependency: manifest.dependencies.apm[0] }))`,
    ], fixture)

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(observedPath, 'utf8'))).toEqual({
      cwd: fixture.consumerRoot,
      dependency: {
        alias: 'personal',
        path: realpathSync(fixture.producerRoot),
        skills: ['demo'],
      },
    })
    expect(readFileSync(join(fixture.consumerRoot, 'apm.yml'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), 'utf8')).toBe(lock)
    expect(readLog(fixture.logPath).map(({ argv }) => argv)).toEqual([['install'], ['install', '--frozen']])
    expect(listStateDirectories(fixture.stateRoot)).toEqual([])
  })

  test('restores the generated provider surface without following symlinks or touching user-authored Claude files', async () => {
    const fixture = createFixture({ createDevSurface: true })
    const manifest = productionManifest()
    const lock = 'lock: provider baseline\n'
    const externalRoot = join(fixture.root, 'external-skills')
    const skillsRoot = join(fixture.consumerRoot, '.agents', 'skills')
    mkdirSync(externalRoot)
    mkdirSync(skillsRoot, { recursive: true })
    writeFileSync(join(externalRoot, 'baseline.txt'), 'external baseline\n')
    symlinkSync(externalRoot, join(skillsRoot, 'external'))
    mkdirSync(join(skillsRoot, 'baseline'))
    writeFileSync(join(skillsRoot, 'baseline', 'SKILL.md'), 'baseline generated file\n')
    mkdirSync(join(fixture.consumerRoot, '.claude'), { recursive: true })
    writeFileSync(join(fixture.consumerRoot, '.claude', 'settings.json'), '{"dirty":true}\n')
    writeFileSync(join(fixture.consumerRoot, 'apm.yml'), manifest)
    writeFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), lock)

    const result = await runCli([
      'with-dev', '--scope', 'project', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills', '--',
      process.execPath, '-e', `await Bun.write(${JSON.stringify(join(externalRoot, 'added-during-dev.txt'))}, 'keep outside generated roots')`,
    ], fixture)

    expect(result.exitCode).toBe(0)
    for (const path of developmentSurfacePaths(fixture.consumerRoot, fixture.consumerRoot)) {
      expect(existsSync(path)).toBe(false)
    }
    expect(readFileSync(join(externalRoot, 'baseline.txt'), 'utf8')).toBe('external baseline\n')
    expect(readFileSync(join(externalRoot, 'added-during-dev.txt'), 'utf8')).toBe('keep outside generated roots')
    expect(readlinkSync(join(skillsRoot, 'external'))).toBe(externalRoot)
    expect(readFileSync(join(skillsRoot, 'baseline', 'SKILL.md'), 'utf8')).toBe('baseline generated file\n')
    expect(readFileSync(join(fixture.consumerRoot, '.claude', 'settings.json'), 'utf8')).toBe('{"dirty":true}\n')
    expect(existsSync(join(fixture.consumerRoot, '.claude', 'commands'))).toBe(false)
    expect(existsSync(join(fixture.consumerRoot, '.codex', 'prompts'))).toBe(false)
    expect(existsSync(join(fixture.consumerRoot, 'apm_modules'))).toBe(false)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.yml'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), 'utf8')).toBe(lock)
  })

  test('propagates a child failure only after exact rollback and frozen materialization', async () => {
    const fixture = createFixture()
    const manifest = productionManifest()
    const lock = 'lock: exact bytes\n'
    writeFileSync(join(fixture.consumerRoot, 'apm.yml'), manifest)
    writeFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), lock)

    const result = await runCli([
      'with-dev', '--scope', 'project', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills',
      '--', process.execPath, '-e', 'process.exit(7)',
    ], fixture)

    expect(result.exitCode).toBe(7)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.yml'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), 'utf8')).toBe(lock)
    expect(readLog(fixture.logPath).map(({ argv }) => argv)).toEqual([['install'], ['install', '--frozen']])
    expect(listStateDirectories(fixture.stateRoot)).toEqual([])
  })

  test('propagates a development install failure only after rollback and frozen materialization', async () => {
    const fixture = createFixture({ failDev: true })
    const manifest = productionManifest()
    const lock = 'lock: install failure baseline\n'
    writeFileSync(join(fixture.consumerRoot, 'apm.yml'), manifest)
    writeFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), lock)

    const result = await runCli([
      'with-dev', '--scope', 'project', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills',
      '--', process.execPath, '-e', 'process.exit(0)',
    ], fixture)

    expect(result.exitCode).toBe(19)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.yml'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), 'utf8')).toBe(lock)
    expect(readLog(fixture.logPath).map(({ argv }) => argv)).toEqual([['install'], ['install', '--frozen']])
    expect(listStateDirectories(fixture.stateRoot)).toEqual([])
  })

  test('restores a lockfile that was originally absent back to absence', async () => {
    const fixture = createFixture()
    const manifest = productionManifest()
    writeFileSync(join(fixture.consumerRoot, 'apm.yml'), manifest)

    const result = await runCli([
      'with-dev', '--scope', 'project', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills',
    ], fixture)

    expect(result.exitCode).toBe(0)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.yml'), 'utf8')).toBe(manifest)
    expect(existsSync(join(fixture.consumerRoot, 'apm.lock.yaml'))).toBe(false)
    expect(listStateDirectories(fixture.stateRoot)).toEqual([])
  })

  test('retains recovery state when frozen restoration fails', async () => {
    const fixture = createFixture({ createDevSurface: true, failFrozen: true })
    const manifest = productionManifest()
    const lock = 'lock: exact bytes\n'
    writeFileSync(join(fixture.consumerRoot, 'apm.yml'), manifest)
    writeFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), lock)

    const result = await runCli([
      'with-dev', '--scope', 'project', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills',
    ], fixture)

    expect(result.exitCode).toBe(23)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.yml'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), 'utf8')).toBe(lock)
    for (const path of developmentSurfacePaths(fixture.consumerRoot, fixture.consumerRoot)) {
      expect(existsSync(path)).toBe(true)
    }
    expect(listStateDirectories(fixture.stateRoot)).toHaveLength(1)
  })

  test('refuses path baselines, ambiguous Git matches, and production packages duplicated in devDependencies', async () => {
    const cases = [
      {
        expected: 'path-only production dependency',
        manifest: 'dependencies:\n  apm:\n    - path: /tmp/agent-skills\n',
      },
      {
        expected: 'ambiguous dependency selector',
        manifest: 'dependencies:\n  apm:\n    - git: owner/agent-skills\n    - git: other/agent-skills.git\n',
      },
      {
        expected: 'also present in devDependencies.apm',
        manifest: 'dependencies:\n  apm:\n    - git: owner/agent-skills.git\ndevDependencies:\n  apm:\n    - git: mirror/agent-skills.git\n',
      },
    ]

    for (const contract of cases) {
      const fixture = createFixture()
      writeFileSync(join(fixture.consumerRoot, 'apm.yml'), contract.manifest)
      writeFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), 'lock: prod\n')

      const result = await runCli([
        'with-dev', '--scope', 'project', '--consumer', fixture.consumerRoot,
        '--source', fixture.producerRoot, '--dependency', 'agent-skills',
      ], fixture)

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain(contract.expected)
      expect(readLog(fixture.logPath)).toEqual([])
      expect(listStateDirectories(fixture.stateRoot)).toEqual([])
    }
  })

  test('reports live ownership, refuses a nested owner, and rolls back after SIGTERM', async () => {
    const fixture = createFixture()
    const manifest = productionManifest()
    const lock = 'lock: signal baseline\n'
    const childReadyPath = join(fixture.root, 'child-ready')
    writeFileSync(join(fixture.consumerRoot, 'apm.yml'), manifest)
    writeFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), lock)

    const owner = spawnCli([
      'with-dev', '--scope', 'project', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills', '--',
      process.execPath, '-e', `await Bun.write(${JSON.stringify(childReadyPath)}, 'ready'); await new Promise(() => {})`,
    ], fixture)
    await waitFor(() => existsSync(childReadyPath))

    const status = await runCli(['status', '--consumer', fixture.consumerRoot], fixture)
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toContain('scope=project')
    expect(status.stdout).toContain(`source=${realpathSync(fixture.producerRoot)}`)
    expect(status.stdout).toContain('live=yes')

    const liveRecovery = await runCli(['recover', '--consumer', fixture.consumerRoot], fixture)
    expect(liveRecovery.exitCode).toBe(1)
    expect(liveRecovery.stderr).toContain('owned by live PID')

    const nested = await runCli([
      'with-dev', '--scope', 'project', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills',
    ], fixture)
    expect(nested.exitCode).toBe(1)
    expect(nested.stderr).toContain('already owned')

    owner.kill('SIGTERM')
    const ownerResult = await collect(owner)
    expect(ownerResult.exitCode).toBe(143)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.yml'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), 'utf8')).toBe(lock)
    expect(listStateDirectories(fixture.stateRoot)).toEqual([])
  })
})

describe('global and recovery', () => {
  test('uses only the dotfiles task for global development and frozen rollback while preserving live symlinks', async () => {
    const fixture = createFixture({ createDevSurface: true, global: true })
    const configRoot = join(fixture.dotfilesRoot, 'modules', 'home', 'apm', 'config')
    const manifestPath = join(configRoot, 'apm.yml')
    const lockPath = join(configRoot, 'apm.lock.yaml')
    const manifest = productionManifest()
    const lock = 'lock: global production\n'
    writeFileSync(manifestPath, manifest)
    writeFileSync(lockPath, lock)

    const result = await runCli([
      'with-dev', '--scope', 'global', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills',
      '--', process.execPath, '-e', 'process.exit(0)',
    ], fixture)

    expect(result.exitCode).toBe(0)
    expect(readLog(fixture.logPath).map(({ argv, tool }) => ({ argv, tool }))).toEqual([
      { argv: ['run', 'dot:apm', '--', 'install', '-g'], tool: 'mise' },
      { argv: ['run', 'dot:apm', '--', 'install', '-g', '--frozen'], tool: 'mise' },
    ])
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifest)
    expect(readFileSync(lockPath, 'utf8')).toBe(lock)
    expect(readlinkSync(join(fixture.homeRoot, '.apm', 'apm.yml'))).toBe(manifestPath)
    expect(readlinkSync(join(fixture.homeRoot, '.apm', 'apm.lock.yaml'))).toBe(lockPath)
    for (const path of developmentSurfacePaths(fixture.homeRoot, fixture.consumerRoot)) {
      expect(existsSync(path)).toBe(false)
    }
    expect(existsSync(join(fixture.homeRoot, '.agents', 'skills'))).toBe(false)
    expect(existsSync(join(fixture.consumerRoot, 'apm_modules'))).toBe(false)
    expect(listStateDirectories(fixture.stateRoot)).toEqual([])
  })

  test('rejects global paths that do not resolve to the dotfiles config', async () => {
    const fixture = createFixture()
    const liveRoot = join(fixture.homeRoot, '.apm')
    mkdirSync(liveRoot, { recursive: true })
    writeFileSync(join(liveRoot, 'apm.yml'), productionManifest())
    writeFileSync(join(liveRoot, 'apm.lock.yaml'), 'lock: unmanaged\n')

    const result = await runCli([
      'with-dev', '--scope', 'global', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills',
    ], fixture)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('must resolve to the dotfiles APM config')
    expect(readLog(fixture.logPath)).toEqual([])
  })

  test('recovers stale SIGKILL state and is idempotent afterward', async () => {
    const fixture = createFixture({ createDevSurface: true })
    const manifest = productionManifest()
    const lock = 'lock: recover baseline\n'
    const childReadyPath = join(fixture.root, 'recover-ready')
    writeFileSync(join(fixture.consumerRoot, 'apm.yml'), manifest)
    writeFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), lock)

    const owner = spawnCli([
      'with-dev', '--scope', 'project', '--consumer', fixture.consumerRoot,
      '--source', fixture.producerRoot, '--dependency', 'agent-skills', '--',
      process.execPath, '-e', `await Bun.write(${JSON.stringify(childReadyPath)}, 'ready'); await Bun.sleep(1500)`,
    ], fixture, undefined, 'ignore')
    await waitFor(() => existsSync(childReadyPath))
    for (const path of developmentSurfacePaths(fixture.consumerRoot, fixture.consumerRoot)) {
      expect(existsSync(path)).toBe(true)
    }
    owner.kill('SIGKILL')
    await owner.exited

    expect(readFileSync(join(fixture.consumerRoot, 'apm.yml'), 'utf8')).not.toBe(manifest)
    const stateDirectories = listStateDirectories(fixture.stateRoot)
    expect(stateDirectories).toHaveLength(1)
    const stateDirectory = join(fixture.stateRoot, 'apm-skill-dev', stateDirectories[0] ?? '')
    expect(Array.from(new Bun.Glob('*').scanSync({ cwd: stateDirectory })).sort()).toEqual([
      'lock.snapshot',
      'manifest.snapshot',
      'state.json',
    ])

    const innocent = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30_000)'], {
      stderr: 'ignore',
      stdin: 'ignore',
      stdout: 'ignore',
    })
    const statePath = join(stateDirectory, 'state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    state.pid = innocent.pid
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)

    const blocked = await runCli(['recover', '--consumer', fixture.consumerRoot], fixture)
    expect(blocked.exitCode).toBe(1)
    expect(blocked.stderr).toContain('owned by live PID')

    const recovered = await runCli(['recover', '--consumer', fixture.consumerRoot, '--force'], fixture)
    expect(recovered.exitCode).toBe(0)
    expect(() => process.kill(innocent.pid, 0)).not.toThrow()
    innocent.kill('SIGTERM')
    await innocent.exited
    expect(readFileSync(join(fixture.consumerRoot, 'apm.yml'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(fixture.consumerRoot, 'apm.lock.yaml'), 'utf8')).toBe(lock)
    for (const path of developmentSurfacePaths(fixture.consumerRoot, fixture.consumerRoot)) {
      expect(existsSync(path)).toBe(false)
    }
    expect(listStateDirectories(fixture.stateRoot)).toEqual([])

    const again = await runCli(['recover', '--consumer', fixture.consumerRoot], fixture)
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain('no recovery state')
  })
})

function createFixture(options: { createDevSurface?: boolean; failDev?: boolean; failFrozen?: boolean; global?: boolean; leakClaude?: boolean; skipMaterialization?: boolean } = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'apm-skill-dev-test-')))
  temporaryRoots.push(root)
  const binRoot = join(root, 'bin')
  const consumerRoot = join(root, 'consumer')
  const dotfilesRoot = join(root, 'dotfiles')
  const homeRoot = join(root, 'home')
  const producerRoot = join(root, 'producer')
  const stateRoot = join(root, 'state')
  const logPath = join(root, 'calls.jsonl')
  mkdirSync(binRoot)
  mkdirSync(consumerRoot)
  mkdirSync(homeRoot)
  mkdirSync(join(producerRoot, '.apm', 'skills', 'demo'), { recursive: true })
  writeFileSync(join(producerRoot, 'apm.yml'), 'name: producer\nversion: 1.0.0\n')
  writeFileSync(join(producerRoot, '.apm', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n')
  writeExecutable(join(binRoot, 'apm'), fakeApmSource())
  writeExecutable(join(binRoot, 'mise'), fakeMiseSource())

  if (options.global) {
    const configRoot = join(dotfilesRoot, 'modules', 'home', 'apm', 'config')
    const liveRoot = join(homeRoot, '.apm')
    mkdirSync(configRoot, { recursive: true })
    mkdirSync(liveRoot, { recursive: true })
    symlinkSync(join(configRoot, 'apm.yml'), join(liveRoot, 'apm.yml'))
    symlinkSync(join(configRoot, 'apm.lock.yaml'), join(liveRoot, 'apm.lock.yaml'))
  }

  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    DOTFILES: dotfilesRoot,
    FAKE_APM_CREATE_DEV_SURFACE: options.createDevSurface ? '1' : '0',
    FAKE_APM_FAIL_DEV: options.failDev ? '1' : '0',
    FAKE_APM_FAIL_FROZEN: options.failFrozen ? '1' : '0',
    FAKE_APM_LEAK_CLAUDE: options.leakClaude ? '1' : '0',
    FAKE_APM_LOG: logPath,
    FAKE_APM_SKIP_MATERIALIZATION: options.skipMaterialization ? '1' : '0',
    HOME: homeRoot,
    PATH: `${binRoot}:${process.env.PATH ?? ''}`,
    XDG_STATE_HOME: stateRoot,
  }

  return { binRoot, consumerRoot, dotfilesRoot, environment, homeRoot, logPath, producerRoot, root, stateRoot }
}

function productionManifest(): string {
  return 'name: consumer\ndependencies:\n  apm:\n    - git: git@github.com:owner/agent-skills.git\n      ref: v1.0.0\n      skills: [demo]\ndevDependencies:\n  apm: []\n'
}

function fakeApmSource(): string {
  return `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const argv = process.argv.slice(2)
const manifestPath = join(process.cwd(), 'apm.yml')
const manifest = Bun.YAML.parse(await Bun.file(manifestPath).text())
appendFileSync(process.env.FAKE_APM_LOG, JSON.stringify({ tool: 'apm', argv, cwd: process.cwd(), manifest }) + '\\n')
const frozen = argv.includes('--frozen')
if (frozen && process.env.FAKE_APM_FAIL_FROZEN === '1') process.exit(23)
if (!frozen) {
  if (process.env.FAKE_APM_FAIL_DEV === '1') process.exit(19)
  writeFileSync(join(process.cwd(), 'apm.lock.yaml'), 'lock: development\\n')
  if (process.env.FAKE_APM_CREATE_DEV_SURFACE === '1') {
    const paths = ${JSON.stringify([
      ['.agents', 'skills', 'apm-skill-dev', 'SKILL.md'],
      ['.claude', 'skills', 'apm-skill-dev', 'SKILL.md'],
      ['.claude', 'commands', 'apm-skill-dev.md'],
      ['.codex', 'skills', 'apm-skill-dev', 'SKILL.md'],
      ['.codex', 'prompts', 'apm-skill-dev.md'],
      ['.cursor', 'skills', 'apm-skill-dev', 'SKILL.md'],
      ['.gemini', 'skills', 'apm-skill-dev', 'SKILL.md'],
      ['.opencode', 'skills', 'apm-skill-dev', 'SKILL.md'],
      ['apm_modules', '_local', 'apm-skill-dev', 'package.txt'],
    ])}
    for (const parts of paths) {
      const path = join(process.cwd(), ...parts)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'development only\\n')
    }
  }
  if (process.env.FAKE_APM_SKIP_MATERIALIZATION !== '1') {
    const dependency = manifest.dependencies.apm[0]
    const skills = dependency.skills ?? ['demo']
    for (const target of manifest.targets ?? []) {
      const skillsRoot = target === 'claude' ? join(process.cwd(), '.claude', 'skills') : join(process.cwd(), '.agents', 'skills')
      for (const skill of skills) mkdirSync(join(skillsRoot, skill), { recursive: true })
    }
  }
  if (process.env.FAKE_APM_LEAK_CLAUDE === '1') mkdirSync(join(process.cwd(), '.claude', 'skills'), { recursive: true })
}
`
}

function fakeMiseSource(): string {
  return `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const argv = process.argv.slice(2)
const manifestPath = join(process.env.HOME, '.apm', 'apm.yml')
const manifest = Bun.YAML.parse(await Bun.file(manifestPath).text())
appendFileSync(process.env.FAKE_APM_LOG, JSON.stringify({ tool: 'mise', argv, cwd: process.cwd(), manifest }) + '\\n')
if (argv.includes('--frozen') && process.env.FAKE_APM_FAIL_FROZEN === '1') process.exit(23)
if (!argv.includes('--frozen')) {
  writeFileSync(join(process.env.HOME, '.apm', 'apm.lock.yaml'), 'lock: global development\\n')
  if (process.env.FAKE_APM_CREATE_DEV_SURFACE === '1') {
    const providerPath = join(process.env.HOME, '.agents', 'skills', 'apm-skill-dev', 'SKILL.md')
    const cachePath = join(process.cwd(), 'apm_modules', '_local', 'apm-skill-dev', 'package.txt')
    mkdirSync(join(providerPath, '..'), { recursive: true })
    mkdirSync(join(cachePath, '..'), { recursive: true })
    writeFileSync(providerPath, 'development only\\n')
    writeFileSync(cachePath, 'development only\\n')
  }
}
`
}

function developmentSurfacePaths(providerBase: string, cacheBase: string): string[] {
  return [
    join(providerBase, '.agents', 'skills', 'apm-skill-dev', 'SKILL.md'),
    join(providerBase, '.claude', 'skills', 'apm-skill-dev', 'SKILL.md'),
    join(providerBase, '.claude', 'commands', 'apm-skill-dev.md'),
    join(providerBase, '.codex', 'skills', 'apm-skill-dev', 'SKILL.md'),
    join(providerBase, '.codex', 'prompts', 'apm-skill-dev.md'),
    join(providerBase, '.cursor', 'skills', 'apm-skill-dev', 'SKILL.md'),
    join(providerBase, '.gemini', 'skills', 'apm-skill-dev', 'SKILL.md'),
    join(providerBase, '.opencode', 'skills', 'apm-skill-dev', 'SKILL.md'),
    join(cacheBase, 'apm_modules', '_local', 'apm-skill-dev', 'package.txt'),
  ]
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source)
  chmodSync(path, 0o755)
}

function spawnCli(
  args: string[],
  fixture: Fixture,
  cwd = fixture.root,
  stdout: 'ignore' | 'pipe' = 'pipe',
): Bun.Subprocess<'ignore', 'pipe' | 'ignore', 'pipe'> {
  return Bun.spawn([process.execPath, scriptPath, ...args], {
    cwd,
    env: fixture.environment,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout,
  })
}

async function runCli(args: string[], fixture: Fixture, cwd = fixture.root): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return collect(spawnCli(args, fixture, cwd))
}

async function collect(process: Bun.Subprocess<'ignore', 'pipe' | 'ignore', 'pipe'>): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const stdout = process.stdout === undefined ? '' : await new Response(process.stdout).text()
  const stderr = await new Response(process.stderr).text()
  const exitCode = await process.exited

  return { exitCode, stderr, stdout }
}

function readLog(path: string): Array<{ argv: string[]; cwd: string; manifest: Record<string, unknown>; tool: string }> {
  if (!existsSync(path)) return []

  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

function listStateDirectories(stateRoot: string): string[] {
  const root = join(stateRoot, 'apm-skill-dev')
  if (!existsSync(root)) return []

  return Array.from(new Bun.Glob('*').scanSync({ cwd: root, onlyFiles: false })).sort()
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(10)
  }
}
