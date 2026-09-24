import { defineCommand, runMain } from 'citty'
import $ from 'dax-sh'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

type Dict = Record<string, any>

interface Report {
  containers: { key: string; from: string; image: string }[]
  port: { container: string; port: number } | { candidates: string[] } | null
  postgres: { service: string; databases: string[]; user: string } | null
  secrets: { container: string; key: string }[]
  dropped: { service: string; reason: string }[]
  unmapped: { container: string; key: string; value?: unknown }[]
  notes: string[]
}

const POSTGRES_IMAGE = /(^|\/)(postgres|postgresql|pgvector|timescaledb[\w-]*|pgvecto-rs)$|immich-app\/postgres$/
const INFRASTRUCTURE_IMAGE = /(^|\/)(watchtower|autoheal|traefik|caddy|nginx-proxy[\w-]*|cloudflared|tailscale|portainer[\w-]*)$/
const SECRET_KEY = /PASS|SECRET|TOKEN|KEY|SALT|CREDENTIAL|PRIVATE/i
const SECRET_VALUE = /:\/\/[^/\s:@]+:[^@\s]+@|^(change-?me|CHANGE_?ME)$/
const MAPPED = new Set(['image', 'ports', 'command', 'entrypoint', 'user', 'environment', 'volumes', 'healthcheck', 'depends_on', 'cap_add', 'devices', 'network_mode'])
const IGNORED = new Set(['restart', 'container_name', 'networks', 'labels', 'logging', 'expose', 'hostname', 'pull_policy', 'stop_grace_period'])

async function tool(probe: string[], command: string[], fallback: string): Promise<string[]> {
  const found = await $`${probe}`.quiet().noThrow()
  return found.code === 0 ? command : ['nix', 'shell', `nixpkgs#${fallback}`, '-c', ...command]
}

async function composeCommand(): Promise<string[]> {
  if ((await $`docker compose version`.quiet().noThrow()).code === 0) return ['docker', 'compose']
  return tool(['docker-compose', 'version'], ['docker-compose'], 'docker-compose')
}

function repeated(rawArgs: string[], flag: string): string[] {
  return rawArgs.flatMap((arg, i) =>
    arg === flag ? [rawArgs[i + 1]] : arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : [],
  )
}

function repository(image: string): string {
  return image.split('@')[0].replace(/:[^/:]+$/, '').replace(/^(docker\.io\/)?(library\/)?/, '')
}

function tagOf(image: string): string | undefined {
  return image.split('@')[0].match(/:([^/:]+)$/)?.[1]
}

function seconds(duration: unknown): number | undefined {
  if (duration === undefined || duration === null) return undefined
  const units: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 }
  let total = 0
  for (const [, value, unit] of String(duration).matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) total += Number(value) * units[unit]
  return Math.ceil(total)
}

function shellQuote(arg: string): string {
  return /^[\w\-./:=@%+,]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

function healthcheckOf(hc: Dict | undefined): Dict | undefined {
  if (!hc || hc.disable || !Array.isArray(hc.test) || hc.test[0] === 'NONE') return undefined
  const [kind, ...args] = hc.test as string[]
  const test = kind === 'CMD-SHELL' ? args.join(' ') : args.map(shellQuote).join(' ')
  const timings = {
    interval: seconds(hc.interval),
    timeout: seconds(hc.timeout),
    retries: hc.retries,
    startPeriod: seconds(hc.start_period),
  }
  return { test, ...Object.fromEntries(Object.entries(timings).filter(([, v]) => v !== undefined)) }
}

function volumeOf(name: string, key: string, volume: Dict, projectDir: string, report: Report): string | undefined {
  const target = volume.target
  const mode = volume.read_only ? ':ro' : ''
  if (volume.type === 'volume') return `/var/lib/${name}/${volume.source ?? key}:${target}${mode}`
  if (volume.type === 'bind') {
    const inside = relative(projectDir, volume.source)
    if (!inside.startsWith('..') && !isAbsolute(inside)) return `/var/lib/${name}/${inside || key}:${target}${mode}`
    report.notes.push(`${key}: host path ${volume.source} kept as is`)
    return `${volume.source}:${target}${mode}`
  }
  report.unmapped.push({ container: key, key: `volumes.${volume.type}`, value: target })
}

function splitEnvironment(key: string, environment: Dict = {}, report: Report): Dict {
  const kept: Dict = {}
  for (const [variable, value] of Object.entries(environment)) {
    if (value === null) report.unmapped.push({ container: key, key: `environment.${variable}`, value: 'taken from the host environment' })
    else if (SECRET_KEY.test(variable) || SECRET_VALUE.test(String(value)) || value === '') report.secrets.push({ container: key, key: variable })
    else kept[variable] = String(value)
  }
  return kept
}

function postgresOf(name: string, service: string, svc: Dict, report: Report): Dict {
  const env = svc.environment ?? {}
  const command: string[] = svc.command ?? []
  const settings: Dict = {}
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '-c' && command[i + 1]?.includes('=')) {
      const [k, ...v] = command[++i].split('=')
      settings[k] = v.join('=')
    }
  }
  const databases = [env.POSTGRES_DB ?? env.POSTGRES_USER ?? name]
  const user = env.POSTGRES_USER ?? name
  report.postgres = { service, databases, user }
  report.secrets.push({ container: 'postgres', key: 'POSTGRES_PASSWORD' })
  report.notes.push(`postgres: app env that addresses the host "${service}" must address "postgres"`)
  return { dedicated: true, image: svc.image, databases, user, ...(Object.keys(settings).length ? { settings } : {}) }
}

function containerOf(name: string, key: string, svc: Dict, services: Dict, keys: Map<string, string>, projectDir: string, report: Report): Dict {
  const c: Dict = { image: svc.image }
  const entrypoint: string[] = svc.entrypoint ?? []
  const cmd = [...entrypoint.slice(1), ...(svc.command ?? [])]
  if (entrypoint.length) c.entrypoint = entrypoint[0]
  if (cmd.length) c.cmd = cmd
  if (svc.user) c.user = String(svc.user)
  const environment = splitEnvironment(key, svc.environment, report)
  if (Object.keys(environment).length) c.environment = environment
  const volumes = (svc.volumes ?? []).map((v: Dict) => volumeOf(name, key, v, projectDir, report)).filter(Boolean)
  if (volumes.length) c.volumes = volumes
  if (svc.cap_add?.length) c.capabilities = svc.cap_add
  if (svc.devices?.length) c.devices = svc.devices.map((d: Dict) => `${d.source}:${d.target ?? d.source}`)
  const healthcheck = healthcheckOf(svc.healthcheck)
  if (healthcheck) c.healthcheck = healthcheck
  const dependsOn = Object.keys(svc.depends_on ?? {}).flatMap((dep) => (keys.has(dep) ? [keys.get(dep)!] : []))
  if (dependsOn.length) c.dependsOn = dependsOn
  for (const [dep, spec] of Object.entries<Dict>(svc.depends_on ?? {}))
    if (spec.condition === 'service_healthy' && keys.has(dep) && !services[dep].healthcheck)
      report.notes.push(`${keys.get(dep)}: ${key} waits for it to be healthy but compose has no healthcheck; take it from the image (crane config <image>) or docs`)
  const via = String(svc.network_mode ?? '').match(/^service:(.+)$/)?.[1]
  if (via && keys.has(via)) c.networkVia = keys.get(via)
  else if (svc.network_mode) report.unmapped.push({ container: key, key: 'network_mode', value: svc.network_mode })
  for (const [field, value] of Object.entries(svc))
    if (!MAPPED.has(field) && !IGNORED.has(field)) report.unmapped.push({ container: key, key: field, value })
  return c
}

function choosePort(containers: Dict, services: Dict, keys: Map<string, string>, report: Report): void {
  const publishing = [...keys].filter(([service]) => services[service].ports?.length)
  if (publishing.length !== 1) {
    report.port = publishing.length ? { candidates: publishing.map(([s, k]) => `${k}:${services[s].ports[0].target}`) } : null
    return
  }
  const [service, key] = publishing[0]
  const ports: Dict[] = services[service].ports
  const port = ports.find((p) => p.protocol !== 'udp') ?? ports[0]
  containers[key].port = port.target
  report.port = { container: key, port: port.target }
  if (!containers[key].healthcheck) report.notes.push(`${key}: the ingress container has no healthcheck; take the probe from upstream docs`)
  const rest = ports.filter((p) => p !== port).map((p) => `${p.target}/${p.protocol ?? 'tcp'}`)
  if (rest.length) report.notes.push(`${key}: only ${port.target} is proxied, not published: ${rest.join(', ')}`)
}

async function pin(image: string, crane: string[], report: Report): Promise<string> {
  const tag = tagOf(image)
  if (!tag || tag === 'latest') report.notes.push(`${image}: pick a release tag (crane ls ${repository(image)}) and re-pin`)
  if (image.includes('@sha256:')) return image
  const digest = (await $`${crane} digest ${image}`.text()).trim()
  return `${image}@${digest}`
}

async function renderNix(name: string, service: Dict, workDir: string): Promise<string> {
  const json = join(workDir, 'draft.json')
  await writeFile(json, JSON.stringify(service))
  const expr = `(builtins.getFlake "nixpkgs").lib.generators.toPretty { } (builtins.fromJSON (builtins.readFile ${json}))`
  return `{\n  homelab.services.${name} = ${await $`nix eval --raw --impure --expr ${expr}`.text()};\n}\n`
}

const main = defineCommand({
  meta: { name: 'compose-to-homelab', description: 'Draft homelab.services.<name> from a compose project' },
  args: {
    name: { type: 'string', required: true, description: 'Service name' },
    compose: { type: 'string', required: true, description: 'Local compose file, repeatable' },
    'env-file': { type: 'string', description: 'Interpolation env file, repeatable' },
    out: { type: 'string', description: 'Output dir (default $TMPDIR/homelab-<name>)' },
  },
  async run({ args, rawArgs }) {
    const name = args.name
    const files = repeated(rawArgs, '--compose').map((f) => resolve(f))
    const envFiles = repeated(rawArgs, '--env-file').map((f) => resolve(f))
    const projectDir = dirname(files[0])
    const out = resolve(args.out ?? join(tmpdir(), `homelab-${name}`))
    const workDir = await mkdtemp(join(tmpdir(), 'compose-to-homelab-'))
    const compose = await composeCommand()
    const crane = await tool(['crane', 'version'], ['crane'], 'crane')

    const fileArgs = files.flatMap((f) => ['-f', f])
    const envArgs = envFiles.flatMap((f) => ['--env-file', f])
    const project: Dict = await $`${compose} -p ${name} --project-directory ${projectDir} ${fileArgs} ${envArgs} config --format json`.json()
    const services: Dict = project.services ?? {}

    const report: Report = { containers: [], port: null, postgres: null, secrets: [], dropped: [], unmapped: [], notes: [] }
    const keys = new Map<string, string>()
    let postgres: Dict | undefined
    for (const [service, svc] of Object.entries(services)) {
      const repo = repository(svc.image ?? '')
      if (!svc.image) report.dropped.push({ service, reason: 'no image (build only)' })
      else if (INFRASTRUCTURE_IMAGE.test(repo)) report.dropped.push({ service, reason: `${repo}: the homelab platform covers it` })
      else if (!postgres && POSTGRES_IMAGE.test(repo)) postgres = postgresOf(name, service, svc, report)
      else keys.set(service, service.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
    }

    const containers: Dict = {}
    for (const [service, key] of keys) {
      containers[key] = containerOf(name, key, services[service], services, keys, projectDir, report)
      report.containers.push({ key, from: service, image: services[service].image })
    }
    choosePort(containers, services, keys, report)

    for (const c of Object.values(containers)) c.image = await pin(c.image, crane, report)
    if (postgres) postgres.image = await pin(postgres.image, crane, report)

    const service = { containers, ...(postgres ? { needs: { postgres } } : {}) }
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'default.nix'), await renderNix(name, service, workDir))
    await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`wrote ${join(out, 'default.nix')} and ${join(out, 'report.json')}`)
  },
})

runMain(main)
