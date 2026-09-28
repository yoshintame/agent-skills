import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dir, '..', '.apm', 'skills', 'git-ref', 'scripts', 'git-ref.ts')

let root: string
let repo: string
let env: Record<string, string>

function git(...args: string[]): string {
  const res = Bun.spawnSync(['git', '-C', repo, ...args], { env })
  if (res.exitCode !== 0) throw new Error(res.stderr.toString())
  return res.stdout.toString().trim()
}

function commit(file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content)
  git('add', file)
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

function run(...args: string[]) {
  const res = Bun.spawnSync(['bun', script, ...args], { env })
  return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() }
}

function field(out: string, name: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.startsWith(`${name}: `))
    .map((l) => l.slice(name.length + 2))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-ref-test-'))
  repo = join(root, 'repo')
  const bin = join(root, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'plannotator'),
    `#!/usr/bin/env bun
const server = Bun.serve({ port: Number(process.env.PLANNOTATOR_PORT), hostname: '127.0.0.1', fetch: () => new Response('ok') })
await Bun.sleep(1500)
console.log(JSON.stringify({ decision: 'annotated', message: 'fix a.txt' }))
server.stop(true)
process.exit(0)
`,
  )
  chmodSync(join(bin, 'plannotator'), 0o755)
  env = {
    ...(process.env as Record<string, string>),
    PATH: `${bin}:${process.env.PATH}`,
    GIT_REF_CACHE: join(root, 'cache'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  }
  git('init', '-q')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('commit set shows only its own changes and flags interleaved files', () => {
  commit('a.txt', 'a0\n', 'init')
  const s1 = commit('a.txt', 'a1\n', 's1')
  commit('b.txt', 'foreign\n', 'foreign b')
  const foreignA = commit('a.txt', 'a-foreign\n', 'foreign a')
  const s2 = commit('a.txt', 'a2\n', 's2')
  const s3 = commit('c.txt', 'c\n', 's3')

  const res = run('open', '-C', repo, s3, s1, s2)
  expect(res.code).toBe(0)
  const [range] = field(res.out, 'range')
  const [review] = field(res.out, 'review')
  const clone = join(review, 'repo')
  const [base, head] = range.split('..')
  expect(Bun.spawnSync(['git', '-C', clone, 'diff', '--name-only', base, head]).stdout.toString().trim().split('\n')).toEqual(['a.txt', 'c.txt'])
  expect(Bun.spawnSync(['git', '-C', clone, 'show', `${base}:a.txt`]).stdout.toString()).toBe('a0\n')
  expect(Bun.spawnSync(['git', '-C', clone, 'rev-parse', 'HEAD']).stdout.toString().trim()).toBe(head)
  expect(field(res.out, 'commit').map((l) => l.split(' ')[1])).toEqual(['s1', 's2', 's3'])
  expect(field(res.out, 'interleaved')).toEqual([`a.txt (foreign: ${foreignA.slice(0, 12)})`])

  const waited = run('wait', review)
  expect(waited.code).toBe(0)
  expect(waited.out).toBe('decision: annotated\n\nfix a.txt\n')
  expect(existsSync(review)).toBe(false)
})

test('three-dot range reviews from the merge-base', () => {
  const init = commit('a.txt', 'a0\n', 'init')
  git('checkout', '-q', '-b', 'feature')
  const tip = commit('f.txt', 'f\n', 'feature')
  git('checkout', '-q', '-')
  commit('a.txt', 'main moved\n', 'main')

  const res = run('open', '-C', repo, `HEAD...feature`)
  expect(res.code).toBe(0)
  expect(field(res.out, 'range')).toEqual([`${init}..${tip}`])
  run('close', field(res.out, 'review')[0])
})

test('commits on diverged branches are rejected', () => {
  commit('a.txt', 'a0\n', 'init')
  git('checkout', '-q', '-b', 'side')
  const side = commit('s.txt', 's\n', 'side')
  git('checkout', '-q', '-')
  const main = commit('m.txt', 'm\n', 'main')

  const res = run('open', '-C', repo, side, main)
  expect(res.code).toBe(1)
  expect(res.err).toContain('do not lie on one line of history')
})
