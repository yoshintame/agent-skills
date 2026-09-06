import { afterEach, beforeEach, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const realScript = resolve(import.meta.dir, '..', 'scripts', 'skill-dev.ts')

let producer: string
let home: string

beforeEach(() => {
  producer = mkdtempSync(join(tmpdir(), 'skill-dev-producer-'))
  home = mkdtempSync(join(tmpdir(), 'skill-dev-home-'))
  mkdirSync(join(producer, 'scripts'), { recursive: true })
  cpSync(realScript, join(producer, 'scripts', 'skill-dev.ts'))
  writeSkill('demo', [
    '---',
    'name: demo',
    'description: A demo skill.',
    '---',
    '',
    'Run `bun ~/.claude/skills/demo/scripts/run.ts` and read `.agents/skills/demo/notes.md`.',
  ].join('\n'))
  writeFileSync(join(producer, '.apm', 'skills', 'demo', 'scripts', 'run.ts'), 'export const skill = "demo"\n')
})

afterEach(() => {
  rmSync(producer, { force: true, recursive: true })
  rmSync(home, { force: true, recursive: true })
})

function writeSkill(name: string, body: string): void {
  const dir = join(producer, '.apm', 'skills', name, 'scripts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(producer, '.apm', 'skills', name, 'SKILL.md'), body)
}

function run(...args: string[]): { stderr: string; stdout: string; success: boolean } {
  const result = Bun.spawnSync(['bun', join(producer, 'scripts', 'skill-dev.ts'), ...args], {
    env: { ...process.env, HOME: home },
  })
  return {
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
    success: result.success,
  }
}

const claudeCopy = (name: string) => join(home, '.claude', 'skills', name)
const codexCopy = (name: string) => join(home, '.agents', 'skills', name)

test('link materializes a dev copy for both providers', () => {
  expect(run('demo').success).toBe(true)
  expect(existsSync(join(claudeCopy('dev-demo'), 'SKILL.md'))).toBe(true)
  expect(existsSync(join(codexCopy('dev-demo'), 'SKILL.md'))).toBe(true)
  expect(existsSync(join(claudeCopy('dev-demo'), 'scripts', 'run.ts'))).toBe(true)
})

test('link rewrites the frontmatter name and self-referential skill paths', () => {
  run('demo')
  const skill = readFileSync(join(claudeCopy('dev-demo'), 'SKILL.md'), 'utf8')
  expect(skill).toContain('name: dev-demo')
  expect(skill).not.toContain('name: demo\n')
  expect(skill).toContain('skills/dev-demo/scripts/run.ts')
  expect(skill).toContain('skills/dev-demo/notes.md')
  expect(skill).not.toContain('skills/demo/')
})

test('link leaves the production skill and other skills untouched', () => {
  writeSkill('other', '---\nname: other\ndescription: Other.\n---\n\nbody\n')
  run('demo')
  expect(existsSync(claudeCopy('demo'))).toBe(false)
  expect(existsSync(claudeCopy('dev-other'))).toBe(false)
})

test('re-running resyncs the dev copy from edited source', () => {
  run('demo')
  writeFileSync(join(producer, '.apm', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Edited.\n---\n\nnew body\n')
  run('demo')
  const skill = readFileSync(join(codexCopy('dev-demo'), 'SKILL.md'), 'utf8')
  expect(skill).toContain('new body')
  expect(skill).toContain('name: dev-demo')
})

test('--remove deletes both provider copies', () => {
  run('demo')
  expect(run('demo', '--remove').success).toBe(true)
  expect(existsSync(claudeCopy('dev-demo'))).toBe(false)
  expect(existsSync(codexCopy('dev-demo'))).toBe(false)
})

test('--list reports materialized dev skills', () => {
  run('demo')
  expect(run('--list').stdout).toContain('dev-demo')
  run('demo', '--remove')
  expect(run('--list').stdout).toContain('no dev skills materialized')
})

test('an unknown skill fails without writing anything', () => {
  const result = run('missing')
  expect(result.success).toBe(false)
  expect(existsSync(claudeCopy('dev-missing'))).toBe(false)
})
