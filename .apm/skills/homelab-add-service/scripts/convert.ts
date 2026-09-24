import { basename, isAbsolute, relative } from 'node:path'

import { compact, isNil } from 'es-toolkit'
import { match, P } from 'ts-pattern'
import { z } from 'zod'

export function convert({ name, projectDir, project, pinnedByImage, fileSources }: ConvertInput): Conversion {
  const report: Report = { containers: [], port: null, postgres: null, secrets: [], dropped: [], unmapped: [], notes: [] }
  const services = Object.entries(project.services).map(([service, spec]) => ({ service, spec, role: roleOf(spec) }))

  for (const { service, role } of services) if (role.kind === 'dropped') report.dropped.push({ service, reason: role.reason })
  const [database, ...extraDatabases] = services.filter(({ role }) => role.kind === 'postgres')
  const kept = [...extraDatabases, ...services.filter(({ role }) => role.kind === 'container')]
  const keyByService = assignKeys(kept.map(({ service }) => service), database ? ['postgres'] : [])
  const keyOf = (service: string) => keyByService.get(service) ?? service

  const containers = Object.fromEntries(kept.map(({ service, spec }) => [keyOf(service), containerOf(service, spec)]))
  const postgres = database ? postgresOf(database.service, database.spec) : undefined
  choosePort(containers)
  noteUnhealthyDependencies(containers)
  noteTags()

  return { service: { containers, needs: { postgres } }, report }

  function assignKeys(servicesToKey: string[], reserved: string[]): Map<string, string> {
    const taken = new Set(reserved)

    return new Map(
      servicesToKey.map((service) => {
        const base = service.toLowerCase().replace(/[^a-z0-9-]/g, '-')
        const key = [base, ...[2, 3, 4, 5].map((n) => `${base}-${n}`)].find((candidate) => !taken.has(candidate)) ?? `${base}-${taken.size}`
        taken.add(key)
        if (key !== service) report.notes.push(`${service}: container key and DNS alias are ${key}; env that addresses ${service} must use ${key}`)

        return [service, key]
      }),
    )
  }

  function containerOf(service: string, spec: ComposeService): Container {
    const key = keyOf(service)
    const { image = '', entrypoint, command = [], user, environment, volumes, cap_add, devices, healthcheck, depends_on, network_mode } = spec

    report.containers.push({ key, from: service, image })
    reportUnknownKeys(key, spec)

    return {
      image: pinnedByImage.get(image) ?? image,
      entrypoint: entrypointOf(key, entrypoint),
      cmd: [...(entrypoint?.slice(1) ?? []), ...command],
      user: isNil(user) ? undefined : String(user),
      environment: environmentOf(key, environment),
      volumes: compact(volumes.map((volume) => volumeOf(key, volume))),
      capabilities: cap_add,
      devices: devices.map(({ source, target, permissions }) => `${source}:${target ?? source}${['rwm', undefined].includes(permissions) ? '' : `:${permissions}`}`),
      healthcheck: healthcheckOf(key, healthcheck),
      dependsOn: compact(Object.keys(depends_on).map((dep) => keyByService.get(dep))),
      networkVia: networkViaOf(key, network_mode),
    }
  }

  function reportUnknownKeys(key: string, spec: ComposeService): void {
    for (const [field, value] of Object.entries(spec))
      if ([!(field in composeService.shape), !IGNORED_KEYS.has(field)].every(Boolean)) report.unmapped.push({ container: key, key: field, value })
  }

  function entrypointOf(key: string, entrypoint: string[] | null | undefined): string | undefined {
    return match(entrypoint)
      .with(P.nullish, () => undefined)
      .with([], () => {
        report.unmapped.push({ container: key, key: 'entrypoint', value: '[] clears the image entrypoint' })
        return undefined
      })
      .otherwise(([first]) => first)
  }

  function environmentOf(key: string, environment: Record<string, string | null>): Record<string, string> {
    const kept: Record<string, string> = {}

    for (const [variable, value] of Object.entries(environment))
      match(value)
        .with(P.nullish, () => report.unmapped.push({ container: key, key: `environment.${variable}`, value: 'taken from the host environment' }))
        .when((v) => isSecret(variable, v), (example) => report.secrets.push({ container: key, key: variable, example }))
        .with('', () => report.unmapped.push({ container: key, key: `environment.${variable}`, value: 'empty in the upstream compose' }))
        .otherwise((v) => {
          kept[variable] = v
        })

    return kept
  }

  function volumeOf(key: string, volume: ComposeVolume): string | undefined {
    const mode = volume.read_only ? ':ro' : ''
    const unmapped = (value: string) => {
      report.unmapped.push({ container: key, key: 'volumes', value })
      return undefined
    }

    return match(volume)
      .with({ type: 'volume', source: P.string }, ({ source, target }) => `/var/lib/${name}/${source}:${target}${mode}`)
      .with({ type: 'volume' }, ({ target }) => `/var/lib/${name}/${key}/${basename(target)}:${target}${mode}`)
      .with({ type: 'bind', source: P.string }, ({ source, target }) => {
        const inside = relative(projectDir, source)
        const outside = [inside === '..', inside.startsWith('../'), isAbsolute(inside)].some(Boolean)

        return outside
          ? unmapped(`${source}:${target} is a host path outside the project`)
          : fileSources.has(source)
            ? unmapped(`${inside}:${target} binds a file; ship it from the repo as \${./${basename(source)}}`)
            : `/var/lib/${name}/${inside === '' ? key : inside}:${target}${mode}`
      })
      .otherwise(({ type, target }) => unmapped(`${type} mount at ${target}`))
  }

  function healthcheckOf(key: string, healthcheck: ComposeHealthcheck | undefined): Healthcheck | undefined {
    if (!healthcheck) return undefined

    for (const [field, value] of Object.entries(healthcheck))
      if (!(field in composeHealthcheck.shape)) report.unmapped.push({ container: key, key: `healthcheck.${field}`, value })

    const timings = {
      interval: positiveSeconds(healthcheck.interval),
      timeout: positiveSeconds(healthcheck.timeout),
      retries: healthcheck.retries,
      startPeriod: positiveSeconds(healthcheck.start_period),
    }

    return match(healthcheck)
      .with({ disable: true }, () => undefined)
      .with({ test: ['NONE', ...P.array()] }, () => undefined)
      .with({ test: ['CMD-SHELL', P.string] }, ({ test: [, command] }) => ({ test: command, ...timings }))
      .with({ test: ['CMD', ...P.array(P.string)] }, ({ test: [, ...args] }) => ({ test: args.map(shellQuote).join(' '), ...timings }))
      .otherwise(() => {
        report.unmapped.push({ container: key, key: 'healthcheck', value: 'no test: timing-only override of the image healthcheck' })
        return undefined
      })
  }

  function networkViaOf(key: string, networkMode: string | undefined): string | undefined {
    if (isNil(networkMode)) return undefined

    const owner = networkMode.match(/^service:(.+)$/)?.[1]
    const ownerKey = owner ? keyByService.get(owner) : undefined
    if (!ownerKey) report.unmapped.push({ container: key, key: 'network_mode', value: networkMode })

    return ownerKey
  }

  function postgresOf(service: string, { image = '', environment, command = [] }: ComposeService): Postgres {
    const { POSTGRES_USER, POSTGRES_DB, POSTGRES_PASSWORD, ...rest } = environment
    const user = POSTGRES_USER ?? 'postgres'
    const databases = [POSTGRES_DB ?? user]
    const settings = Object.fromEntries(
      command.flatMap((arg, i) => {
        const pair = command[i - 1] === '-c' ? arg : arg.match(/^--([\w.]+=.*)$/)?.[1]
        return pair ? [pair.split(/=(.*)/s).slice(0, 2)] : []
      }),
    )
    const leftovers = command.filter((arg, i) =>
      [!['postgres', '-c'].includes(arg), command[i - 1] !== '-c', !arg.startsWith('--')].every(Boolean),
    )

    report.postgres = { service, databases, user }
    report.secrets.push({ container: 'postgres', key: 'POSTGRES_PASSWORD', example: POSTGRES_PASSWORD ?? null })
    report.notes.push(`postgres: env that addresses the host ${service} must use postgres; its compose volumes and healthcheck are replaced by needs.postgres`)
    for (const [variable, value] of Object.entries(rest)) report.unmapped.push({ container: 'postgres', key: `environment.${variable}`, value })
    for (const arg of leftovers) report.unmapped.push({ container: 'postgres', key: 'command', value: arg })

    return { dedicated: true, image: pinnedByImage.get(image) ?? image, databases, user, settings }
  }

  function choosePort(containersByKey: Record<string, Container>): void {
    const offers = kept.flatMap(({ service, spec }) => {
      const key = keyOf(service)
      const tcp = spec.ports.find(({ protocol }) => protocol !== 'udp') ?? spec.ports[0]
      const port = tcp?.target ?? Number.parseInt(spec.expose[0] ?? '', 10)
      const guests = kept.filter(({ spec: guest }) => guest.network_mode === `service:${service}`)

      return Number.isNaN(port) ? [] : [{ key, port, guests: guests.map(({ service: guest }) => keyOf(guest)) }]
    })

    match(offers)
      .with([{ guests: [] }], ([{ key, port }]) => {
        containersByKey[key].port = port
        report.port = { container: key, port }
        if (!containersByKey[key].healthcheck) report.notes.push(`${key}: the ingress container has no healthcheck; take the probe from upstream docs`)
      })
      .with([], () => undefined)
      .otherwise(() => {
        report.port = { candidates: offers.flatMap(({ key, port, guests }) => [key, ...guests].map((candidate) => `${candidate}:${port}`)) }
      })
  }

  function noteUnhealthyDependencies(containersByKey: Record<string, Container>): void {
    const waits = kept.flatMap(({ service, spec }) =>
      Object.entries(spec.depends_on)
        .filter(([, { condition }]) => condition === 'service_healthy')
        .flatMap(([dep]) => {
          const depKey = keyByService.get(dep)
          return depKey ? [{ waiter: keyOf(service), depKey }] : []
        }),
    )

    for (const { waiter, depKey } of waits.filter(({ depKey }) => !containersByKey[depKey].healthcheck))
      report.notes.push(`${depKey}: ${waiter} waits for it to be healthy but it has no healthcheck; take one from the image (crane config <image>) or docs`)
  }

  function noteTags(): void {
    for (const { spec } of [...kept, ...(database ? [database] : [])]) {
      const tag = spec.image?.split('@')[0].match(/:([^/:]+)$/)?.[1]
      if (['latest', undefined].includes(tag)) report.notes.push(`${spec.image}: pick a release tag (crane ls) and re-pin`)
    }
  }
}

export function parseProject(json: string): ComposeProject {
  return composeProject.parse(JSON.parse(json, (_, value) => (typeof value === 'string' ? value.replaceAll('$$', '$') : value)))
}

export function imagesOf({ services }: ComposeProject): string[] {
  return compact(Object.values(services).map(({ image }) => image))
}

export function bindSourcesOf({ services }: ComposeProject): string[] {
  return Object.values(services).flatMap(({ volumes }) =>
    volumes.flatMap((volume) => (volume.type === 'bind' ? [volume.source ?? ''] : [])),
  )
}

export interface ConvertInput {
  name: string
  projectDir: string
  project: ComposeProject
  pinnedByImage: Map<string, string>
  fileSources: Set<string>
}

export interface Conversion {
  service: { containers: Record<string, Container>; needs: { postgres?: Postgres } }
  report: Report
}

export type ComposeProject = z.infer<typeof composeProject>

interface Container {
  image: string
  port?: number
  entrypoint?: string
  cmd: string[]
  user?: string
  environment: Record<string, string>
  volumes: string[]
  capabilities: string[]
  devices: string[]
  healthcheck?: Healthcheck
  dependsOn: string[]
  networkVia?: string
}

interface Healthcheck {
  test: string
  interval?: number
  timeout?: number
  retries?: number
  startPeriod?: number
}

interface Postgres {
  dedicated: true
  image: string
  databases: string[]
  user: string
  settings: Record<string, string>
}

interface Report {
  containers: { key: string; from: string; image: string }[]
  port: { container: string; port: number } | { candidates: string[] } | null
  postgres: { service: string; databases: string[]; user: string } | null
  secrets: { container: string; key: string; example: string | null }[]
  dropped: { service: string; reason: string }[]
  unmapped: { container: string; key: string; value: unknown }[]
  notes: string[]
}

type Role = { kind: 'container' } | { kind: 'postgres' } | { kind: 'dropped'; reason: string }
type ComposeService = z.infer<typeof composeService>
type ComposeVolume = z.infer<typeof composeVolume>
type ComposeHealthcheck = z.infer<typeof composeHealthcheck>

const composeVolume = z.looseObject({
  type: z.string(),
  source: z.string().optional(),
  target: z.string(),
  read_only: z.boolean().optional(),
})

const composeHealthcheck = z.looseObject({
  test: z.array(z.string()).optional(),
  interval: z.string().optional(),
  timeout: z.string().optional(),
  retries: z.number().optional(),
  start_period: z.string().optional(),
  disable: z.boolean().optional(),
})

const composeService = z.looseObject({
  image: z.string().optional(),
  ports: z.array(z.looseObject({ target: z.number(), protocol: z.string().optional() })).default([]),
  expose: z.array(z.coerce.string()).default([]),
  command: z.array(z.string()).nullish().transform((value) => value ?? undefined),
  entrypoint: z.array(z.string()).nullish(),
  user: z.union([z.string(), z.number()]).optional(),
  environment: z.record(z.string(), z.string().nullable()).default({}),
  volumes: z.array(composeVolume).default([]),
  cap_add: z.array(z.string()).default([]),
  devices: z.array(z.looseObject({ source: z.string(), target: z.string().optional(), permissions: z.string().optional() })).default([]),
  healthcheck: composeHealthcheck.optional(),
  depends_on: z.record(z.string(), z.looseObject({ condition: z.string().optional() })).default({}),
  network_mode: z.string().optional(),
})

const composeProject = z.looseObject({ services: z.record(z.string(), composeService) })

const IGNORED_KEYS = new Set(['restart', 'container_name', 'networks', 'labels', 'logging', 'hostname', 'pull_policy', 'stop_grace_period'])
const POSTGRES_IMAGE = /(^|\/)(postgres|postgresql|pgvector|timescaledb[\w-]*|pgvecto-rs)$|immich-app\/postgres$/
const PLATFORM_IMAGE = /(^|\/)(watchtower|autoheal|traefik|caddy|nginx-proxy[\w-]*|cloudflared|tailscale|portainer[\w-]*)$/
const SECRET_NAME = /(^|_)(PASSWORD|PASSWD|PASS|SECRET|TOKEN|KEY|SALT|CREDENTIALS?|AUTH)$/i
const SECRET_VALUE = /:\/\/[^/\s@]*:[^@\s]+@|^(change-?me|CHANGE_?ME)$/
const NOT_SECRET_VALUE = /^(true|false|yes|no|on|off|\d+)$/i
const secondsByUnit = new Map([
  ['h', 3600],
  ['m', 60],
  ['s', 1],
  ['ms', 0.001],
])

function roleOf({ image }: ComposeService): Role {
  const repository = (image ?? '').split('@')[0].replace(/:[^/:]+$/, '').replace(/^(docker\.io\/)?(library\/)?/, '')

  return match(repository)
    .with('', () => ({ kind: 'dropped' as const, reason: 'no image (build only)' }))
    .when((repo) => PLATFORM_IMAGE.test(repo), (repo) => ({ kind: 'dropped' as const, reason: `${repo}: the homelab platform covers it` }))
    .when((repo) => POSTGRES_IMAGE.test(repo), () => ({ kind: 'postgres' as const }))
    .otherwise(() => ({ kind: 'container' as const }))
}

function isSecret(variable: string, value: string): boolean {
  return SECRET_NAME.test(variable) ? !NOT_SECRET_VALUE.test(value) : SECRET_VALUE.test(value)
}

function positiveSeconds(duration: string | undefined): number | undefined {
  const total = [...(duration ?? '').matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)].reduce(
    (sum, [, value, unit]) => sum + Number(value) * (secondsByUnit.get(unit) ?? 0),
    0,
  )

  return total > 0 ? Math.ceil(total) : undefined
}

function shellQuote(arg: string): string {
  return /^[\w\-./:=@%+,]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}
