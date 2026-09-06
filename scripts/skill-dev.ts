#!/usr/bin/env bun
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const devPrefix = 'dev-'
const providerSkillRoots = ['.claude/skills', '.agents/skills']
const producerRoot = resolve(import.meta.dir, '..')

main()

function main(): void {
  const [name, ...flags] = process.argv.slice(2)
  if (name === undefined || name === '--list') return listDev()
  if (name.startsWith('-')) return usage()
  const remove = flags.includes('--remove') || flags.includes('-r')
  const devName = devPrefix + name
  const targets = providerSkillRoots.map((root) => join(homedir(), root, devName))
  if (remove) return removeDev(devName, targets)
  linkDev(name, devName, targets)
}

function linkDev(name: string, devName: string, targets: string[]): void {
  const source = join(producerRoot, '.apm', 'skills', name)
  if (!existsSync(join(source, 'SKILL.md'))) {
    throw new Error(`no such skill: ${name} (looked in ${source})`)
  }
  for (const target of targets) {
    rmSync(target, { force: true, recursive: true })
    cpSync(source, target, { recursive: true })
    rewriteDevCopy(target, name, devName)
  }
  console.log(`${devName} materialized from ${source}`)
  for (const target of targets) console.log(`  ${target}`)
  console.log('re-run after each source edit to resync; pass --remove to drop it')
}

function removeDev(devName: string, targets: string[]): void {
  let removed = false
  for (const target of targets) {
    if (!existsSync(target)) continue
    rmSync(target, { force: true, recursive: true })
    console.log(`removed ${target}`)
    removed = true
  }
  if (!removed) console.log(`${devName} is not materialized`)
}

function listDev(): void {
  const seen = new Set<string>()
  for (const root of providerSkillRoots) {
    const base = join(homedir(), root)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base)) {
      if (entry.startsWith(devPrefix)) seen.add(entry)
    }
  }
  if (seen.size === 0) {
    console.log('no dev skills materialized')
    return
  }
  for (const name of [...seen].sort()) console.log(name)
}

function rewriteDevCopy(target: string, name: string, devName: string): void {
  for (const file of walkFiles(target)) {
    const bytes = readFileSync(file)
    if (bytes.includes(0)) continue
    const text = bytes.toString('utf8')
    let rewritten = text.replaceAll(`skills/${name}/`, `skills/${devName}/`)
    if (file.endsWith('SKILL.md')) rewritten = rewriteFrontmatterName(rewritten, devName)
    if (rewritten !== text) writeFileSync(file, rewritten)
  }
}

function rewriteFrontmatterName(text: string, devName: string): string {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)
  if (frontmatter === null) return text
  const rewritten = frontmatter[1].replace(/^name:.*$/m, `name: ${devName}`)
  return text.replace(frontmatter[0], `---\n${rewritten}\n---`)
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) files.push(...walkFiles(path))
    else files.push(path)
  }
  return files
}

function usage(): never {
  console.error('usage: skill-dev <name> [--remove] | skill-dev --list')
  process.exit(2)
}
