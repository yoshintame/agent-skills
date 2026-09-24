import { statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { defineCommand, runMain } from 'citty@0.2.2'
import $ from 'dax-sh@0.42.0'
import { uniq } from 'es-toolkit@1.52.0'
import { isEmpty } from 'es-toolkit@1.52.0/compat'
import { match } from 'ts-pattern@5.9.0'
import { z } from 'zod@4.6.5'

import { bindSourcesOf, convert, imagesOf, parseProject } from './convert'

const main = defineCommand({
  meta: { name: 'compose-to-homelab', description: 'Draft homelab.services.<name> from a compose project' },
  args: {
    name: { type: 'string', required: true, description: 'Service name' },
    compose: { type: 'string', required: true, description: 'Local compose file, repeatable' },
    'env-file': { type: 'string', description: 'Interpolation env file, repeatable' },
    out: { type: 'string', description: 'Output dir (default $TMPDIR/homelab-<name>)' },
  },
  async run({ args: { name, out }, rawArgs }) {
    const composeFiles = repeated(rawArgs, '--compose').map((file) => resolve(file))
    const envFiles = repeated(rawArgs, '--env-file').map((file) => resolve(file))
    const projectDir = dirname(composeFiles[0])
    const outDir = resolve(out ?? join(tmpdir(), `homelab-${name}`))
    const [compose, crane] = await Promise.all([
      firstAvailable([['docker', 'compose'], ['docker-compose']], 'docker-compose'),
      firstAvailable([['crane']], 'crane'),
    ])

    const composeArgs = [
      ...['-p', name, '--project-directory', projectDir],
      ...composeFiles.flatMap((file) => ['-f', file]),
      ...envFiles.flatMap((file) => ['--env-file', file]),
    ]
    const config = await $`${compose} ${composeArgs} config --format json`
      .clearEnv()
      .env({ PATH: process.env.PATH, HOME: process.env.HOME })
      .text()
    const project = parseProject(config)

    const pinnedByImage = new Map(
      await Promise.all(uniq(imagesOf(project)).map(async (image) => [image, await pin(crane, image)] as const)),
    )
    const fileSources = new Set(bindSourcesOf(project).filter((source) => statSync(source, { throwIfNoEntry: false })?.isFile()))
    const { service, report } = convert({ name, projectDir, project, pinnedByImage, fileSources })

    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'default.nix'), await renderNix(name, service))
    await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`wrote ${join(outDir, 'default.nix')} and ${join(outDir, 'report.json')}`)
  },
})

function repeated(rawArgs: string[], flag: string): string[] {
  return rawArgs.flatMap((arg, i) => {
    const value = match(arg)
      .with(flag, () => rawArgs[i + 1])
      .when((a) => a.startsWith(`${flag}=`), (a) => a.slice(flag.length + 1))
      .otherwise(() => null)
    if (value === undefined) throw new Error(`${flag} needs a value`)

    return value === null ? [] : [value]
  })
}

async function firstAvailable(candidates: string[][], nixPackage: string): Promise<string[]> {
  const probes = await Promise.all(candidates.map((command) => $`${command} version`.quiet().noThrow()))
  const found = candidates.find((_, i) => probes[i].code === 0)

  return found ?? ['nix', 'shell', `nixpkgs#${nixPackage}`, '-c', ...candidates[0]]
}

async function pin(crane: string[], image: string): Promise<string> {
  if (image.includes('@sha256:')) return image

  const { stdout, stderr } = await $`${crane} digest ${image}`.noThrow().stdout('piped').stderr('piped')
  const digest = imageDigest.safeParse(stdout.trim())
  if (!digest.success) throw new Error(`crane digest ${image} failed: ${stderr.trim()}`)

  return `${image}@${digest.data}`
}

async function renderNix(name: string, service: unknown): Promise<string> {
  const draft = JSON.stringify(service, (_, value) => (typeof value === 'object' ? (isEmpty(value) ? undefined : value) : value))
  const expr = '(builtins.getFlake "nixpkgs").lib.generators.toPretty { } (builtins.fromJSON (builtins.getEnv "DRAFT"))'
  const pretty = await $`nix eval --raw --impure --expr ${expr}`.env({ DRAFT: draft }).text()

  return `{\n  homelab.services.${name} = ${pretty};\n}\n`
}

const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/)

runMain(main)
