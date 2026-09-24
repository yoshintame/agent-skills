#!/usr/bin/env bun
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { defineCommand, runMain } from 'citty@0.2.2'
import $ from 'dax-sh@0.42.0'

$.setPrintCommand(false)

type Dict = Record<string, unknown>
type Severity = 'info' | 'warn' | 'strong'
type Origin = 'env_file' | 'environment'
type Kind = 'app' | 'postgres' | 'infra'
type FlagFn = (issue: string, severity?: Severity) => void

interface Flag {
  container: string | null
  issue: string
  severity: Severity
}

interface Secret {
  key: string
  container: string
  origin: Origin
  hint: string | null
  value: string
}

interface Rewrite {
  container: string
  key: string
  from: string
  to: string
}

interface Healthcheck {
  test: string
  interval?: number
  timeout?: number
  retries?: number
  startPeriod?: number
}

type Timings = Partial<Omit<Healthcheck, 'test'>>

interface Port {
  target: number
  protocol: string
}

interface Container {
  key: string
  service: string
  image: string
  port?: number
  ports: Port[]
  cmd: string[]
  entrypoint?: string
  user?: string
  environment: Record<string, string>
  volumes: string[]
  capabilities: string[]
  devices: string[]
  healthcheck?: Healthcheck
  inheritHealthcheck?: Timings
  startTimeout?: number
  dependsOn: string[]
  networkVia?: string
  extraOptions: string[]
}

interface Postgres {
  service: string
  image: string
  databases: string[]
  user: string
  hostAuthMethod: 'scram-sha-256' | 'md5'
  settings: Record<string, string>
  password?: string
  major: number | null
  originalVolumes: string[]
}

interface Ingress {
  container: string | null
  port: number | null
  alternatives: { container: string; port: number }[]
}

interface Draft {
  name: string
  base: string
  containers: Container[]
  postgres: Postgres | null
  secrets: Secret[]
  rewrites: Rewrite[]
  dropped: { service: string; reason: string }[]
  ignored: Map<string, string[]>
  flags: Flag[]
  questions: string[]
  ingress: Ingress
  healthyWanted: { from: string; dep: string }[]
}

interface Planned {
  kind: Kind
  key: string
}

interface Context {
  draft: Draft
  plan: Map<string, Planned>
  hosts: Map<string, string>
  origins: Map<string, Map<string, Origin>>
  projectDirs: string[]
  topVolumes: Dict
  hostNetwork: Set<string>
}

interface ImageRef {
  name: string
  registry: string
  path: string
  tag?: string
  digest?: string
}

interface Inputs {
  root: string
  composeFiles: string[]
  normalizedFiles: string[]
  envFiles: string[]
  projectDir: string
  flags: Flag[]
}

interface Ref {
  path: string
  required: boolean
  kind: 'env_file' | 'compose'
}

const NAME_RE = /^[a-z][a-z0-9-]*$/
const BIND_MOUNT_RE = /^\/[^:]+:\/[^:]*(:[a-zA-Z,]+)?$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const SECRET_KEY_RE = /(PASS|SECRET|TOKEN|KEY|SALT|CREDENTIAL|PRIVATE|AUTH)/i
const CONFIG_KEY_RE =
  /_(ID|FILE|PATH|DIR|URL|URI|HOST|PORT|METHOD|TYPE|MODE|ENABLED?|DISABLED?|HEADER|PROVIDER|EXPIRY|TTL|LENGTH|NAME|USER|USERNAME|ALGORITHM|TIMEOUT)$/i
const CONFIG_VALUE_RE = /^(true|false|yes|no|on|off|\d{1,5}|\/.*)$/i
const PLACEHOLDER_RE =
  /^(change[-_ ]?me\w*|change[-_ ]?it|replace[-_ ]?me\w*|<[^>]*>|x{3,}|\.{3})$/i
const WEAK_VALUE_RE = /^(secret|password|passw0rd|admin|test\d*|example|default)$/i
const CREDENTIAL_URL_RE = /^([a-z][a-z0-9+.-]*:\/\/[^:@/\s]*:)([^@/\s]+)(@)/i
const DSN_PASSWORD_RE = /(\bpassword=)([^\s&;]+)/i
const POSTGRES_RE =
  /^(?:library\/postgres|docker\/library\/postgres|pgvector\/pgvector|timescale\/timescaledb[\w-]*|tensorchord\/pgvecto-rs|immich-app\/postgres|bitnami\/postgresql)$/
const REDIS_RE = /^(redis|valkey|keydb|dragonfly|redis-stack(-server)?)$/
const WEB_PORTS = [80, 443, 3000, 5000, 8000, 8080, 8443, 9000]
const HEALTHCHECK_DEFAULTS = { interval: 10, timeout: 5, retries: 3, startPeriod: 0 }
const IGNORED_KEYS = new Set([
  'restart',
  'container_name',
  'labels',
  'logging',
  'expose',
  'hostname',
  'pull_policy',
  'stop_grace_period',
  'deploy',
  'platform',
  'stdin_open',
  'tty',
  'profiles',
  'domainname',
])
const HANDLED_KEYS = new Set([
  'image',
  'build',
  'command',
  'entrypoint',
  'environment',
  'env_file',
  'volumes',
  'ports',
  'healthcheck',
  'depends_on',
  'cap_add',
  'cap_drop',
  'devices',
  'user',
  'network_mode',
  'networks',
  'privileged',
  'shm_size',
  'sysctls',
  'security_opt',
  'init',
  'ulimits',
  'tmpfs',
  'working_dir',
  'stop_signal',
  'group_add',
  'mem_limit',
  'cpus',
  'dns',
  'secrets',
  'configs',
  'extends',
])
const POSTGRES_COVERED_KEYS = new Set([
  'image',
  'command',
  'entrypoint',
  'environment',
  'env_file',
  'volumes',
  'healthcheck',
  'ports',
  'networks',
  'depends_on',
])
const PASSTHROUGH_OPTIONS: [string, string][] = [
  ['working_dir', '--workdir'],
  ['stop_signal', '--stop-signal'],
  ['group_add', '--group-add'],
  ['mem_limit', '--memory'],
  ['cpus', '--cpus'],
  ['dns', '--dns'],
]
const INFRA: { test: (path: string, last: string) => boolean; reason: string }[] = [
  {
    test: (_, last) => last === 'watchtower',
    reason: 'image updates: the homelab pins digests in Nix',
  },
  {
    test: (_, last) => last === 'autoheal',
    reason: 'container restarts: systemd supervises every container',
  },
  {
    test: (path, last) =>
      last === 'traefik' ||
      last.startsWith('caddy') ||
      last.startsWith('nginx-proxy') ||
      path.startsWith('jwilder/') ||
      path.startsWith('nginxproxy/'),
    reason: 'reverse proxy: the homelab Traefik is the ingress',
  },
  {
    test: (_, last) => last === 'cloudflared',
    reason: 'tunnel: the homelab cloudflared publishes services with public = true',
  },
  {
    test: (path) => path === 'tailscale/tailscale',
    reason: 'tailnet sidecar: the homelab tailscale serves services with tailnet = true',
  },
  {
    test: (path) => path.startsWith('portainer/'),
    reason: 'container management UI, not part of the service',
  },
]

function fail(message: string): never {
  process.stderr.write(`compose-to-homelab: ${message}\n`)
  process.exit(1)
}

function record(value: unknown): Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : {}
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  return value === undefined || value === null ? [] : [value]
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function unescapeDollar(value: string): string {
  return value.replaceAll('$$', '$')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function joinHints(...hints: (string | null | undefined)[]): string | null {
  const present = hints.filter((h): h is string => Boolean(h))
  return present.length ? present.join('; ') : null
}

function repeated(rawArgs: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg === flag && i + 1 < rawArgs.length) values.push(rawArgs[++i])
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1))
  }
  return values
}

function isUrl(value: string): boolean {
  return /^https?:\/\//.test(value)
}

function rawGithubUrl(url: string): string {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/)
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}` : url
}

function urlBasename(url: string): string {
  return basename(new URL(url).pathname) || 'compose.yml'
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep)
}

async function download(url: string, dest: string): Promise<boolean> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    fail(`cannot fetch ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) return false
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, await response.text())
  return true
}

async function downloadRequired(url: string, dest: string): Promise<string> {
  if (!(await download(url, dest))) fail(`cannot fetch ${url}`)
  return dest
}

function readYaml(path: string): Dict | undefined {
  try {
    return record(Bun.YAML.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

function envFileRefs(value: unknown): Ref[] {
  return list(value).map((entry) =>
    typeof entry === 'string'
      ? { path: entry, required: true, kind: 'env_file' as const }
      : {
          path: text(record(entry).path),
          required: record(entry).required !== false,
          kind: 'env_file' as const,
        },
  )
}

function composeRefs(doc: Dict): Ref[] {
  const refs: Ref[] = []
  for (const svc of Object.values(record(doc.services))) {
    const service = record(svc)
    refs.push(...envFileRefs(service.env_file))
    const extendsFile = text(record(service.extends).file)
    if (extendsFile) refs.push({ path: extendsFile, required: true, kind: 'compose' })
  }
  for (const entry of list(doc.include)) {
    if (typeof entry === 'string') {
      refs.push({ path: entry, required: true, kind: 'compose' })
      continue
    }
    for (const path of list(record(entry).path))
      refs.push({ path: text(path), required: true, kind: 'compose' })
    refs.push(...envFileRefs(record(entry).env_file))
  }
  return refs.filter((ref) => ref.path && !ref.path.includes('$') && !isAbsolute(ref.path))
}

async function fetchSiblings(
  url: string,
  file: string,
  projectDir: string,
  root: string,
  envFiles: string[],
  flags: Flag[],
): Promise<void> {
  const doc = readYaml(file)
  if (!doc) return
  for (const ref of composeRefs(doc)) {
    const dest = resolve(projectDir, ref.path)
    if (existsSync(dest)) continue
    if (!within(root, dest)) {
      flags.push({ container: null, issue: `${ref.path} lies outside the download dir, not fetched`, severity: 'warn' })
      continue
    }
    const sibling = new URL(ref.path, url).href
    if (await download(sibling, dest)) {
      if (ref.kind === 'compose') await fetchSiblings(sibling, dest, projectDir, root, envFiles, flags)
      continue
    }
    if (!ref.required) continue
    if (ref.kind === 'compose') fail(`cannot fetch ${sibling} referenced by ${url}`)
    mkdirSync(dirname(dest), { recursive: true })
    if (basename(dest) === '.env' && envFiles.length) {
      copyFileSync(envFiles[0], dest)
      flags.push({ container: null, issue: `env_file ${ref.path} is not published upstream; used --env-file ${basename(envFiles[0])} in its place`, severity: 'info' })
    } else {
      writeFileSync(dest, '')
      flags.push({ container: null, issue: `env_file ${ref.path} could not be fetched from ${sibling}; normalized with an empty file, pass it with --env-file or fill the keys by hand`, severity: 'warn' })
    }
  }
}

async function materialize(composeArgs: string[], envArgs: string[]): Promise<Inputs> {
  const root = mkdtempSync(join(tmpdir(), 'compose-to-homelab-'))
  const projectDir = join(root, 'project')
  mkdirSync(projectDir, { recursive: true })
  const flags: Flag[] = []
  const envFiles: string[] = []
  for (const [i, arg] of envArgs.entries()) {
    envFiles.push(
      isUrl(arg)
        ? await downloadRequired(rawGithubUrl(arg), join(root, 'env', `${i}-${urlBasename(rawGithubUrl(arg))}`))
        : resolve(arg),
    )
  }
  const composeFiles: string[] = []
  for (const [i, arg] of composeArgs.entries()) {
    if (!isUrl(arg)) {
      if (!existsSync(arg)) fail(`compose file ${arg} does not exist`)
      composeFiles.push(resolve(arg))
      continue
    }
    const url = rawGithubUrl(arg)
    const dest = join(projectDir, i === 0 ? urlBasename(url) : `${i}-${urlBasename(url)}`)
    await downloadRequired(url, dest)
    await fetchSiblings(url, dest, dirname(composeFiles[0] ?? dest), root, envFiles, flags)
    composeFiles.push(dest)
  }
  const normalizedFiles = composeFiles.map((file, i) => withoutNullKeys(file, join(root, 'sanitized', `${i}-${basename(file)}.json`), flags))
  return { root, composeFiles, normalizedFiles, envFiles, projectDir: dirname(composeFiles[0]), flags }
}

function withoutNullKeys(file: string, copy: string, flags: Flag[]): string {
  const doc = readYaml(file)
  if (!doc) return file
  const dropped: string[] = []
  for (const [service, raw] of Object.entries(record(doc.services))) {
    const svc = record(raw)
    for (const key of Object.keys(svc).filter((k) => svc[k] === null)) {
      delete svc[key]
      dropped.push(`${service}.${key}`)
    }
  }
  if (!dropped.length) return file
  mkdirSync(dirname(copy), { recursive: true })
  writeFileSync(copy, JSON.stringify(doc, null, 2))
  flags.push({ container: null, issue: `empty compose keys dropped before normalization: ${dropped.join(', ')}`, severity: 'info' })
  return copy
}

async function composeCommand(): Promise<string[]> {
  if (await $.commandExists('docker')) {
    const probe = await $`docker compose version`.quiet().noThrow()
    if (probe.code === 0) return ['docker', 'compose']
  }
  if (await $.commandExists('docker-compose')) return ['docker-compose']
  return ['nix', 'shell', 'nixpkgs#docker-compose', '-c', 'docker-compose']
}

function composeWarnings(stderr: string): Flag[] {
  return stderr
    .split('\n')
    .map((line) => line.match(/msg="(.*)"\s*$/)?.[1] ?? line.match(/^WARN\[\d+\]\s*(.*)$/)?.[1])
    .filter((msg): msg is string => Boolean(msg) && !msg!.includes('`version` is obsolete'))
    .map((msg) => ({ container: null, issue: `compose: ${msg.replaceAll('\\"', '"')}`, severity: 'warn' as const }))
}

async function normalize(
  name: string,
  inputs: Inputs,
  profiles: string[],
): Promise<{ project: Dict; flags: Flag[] }> {
  const command = await composeCommand()
  const args = [
    '-p',
    name,
    '--project-directory',
    inputs.projectDir,
    ...inputs.normalizedFiles.flatMap((file) => ['-f', file]),
    ...inputs.envFiles.flatMap((file) => ['--env-file', file]),
    ...profiles.flatMap((profile) => ['--profile', profile]),
    'config',
    '--format',
    'json',
  ]
  const result = await $`${command} ${args}`
    .cwd(inputs.projectDir)
    .stdout('piped')
    .stderr('piped')
    .noThrow()
  if (result.code !== 0)
    fail(`normalization with \`${command.join(' ')} config\` failed:\n${result.stderr.trim()}`)
  try {
    return { project: record(JSON.parse(result.stdout)), flags: composeWarnings(result.stderr) }
  } catch {
    fail(`\`${command.join(' ')} config --format json\` returned invalid JSON`)
  }
}

function envFileKeys(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^export\s+/, ''))
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*=/)?.[1])
    .filter((key): key is string => Boolean(key))
}

function rawEnvironmentKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => text(entry).split('=')[0])
  return Object.keys(record(value))
}

function envOrigins(composeFiles: string[], projectDir: string): Map<string, Map<string, Origin>> {
  const origins = new Map<string, Map<string, Origin>>()
  for (const file of composeFiles) {
    for (const [service, raw] of Object.entries(record(readYaml(file)?.services))) {
      const svc = record(raw)
      const keys = origins.get(service) ?? new Map<string, Origin>()
      for (const ref of envFileRefs(svc.env_file))
        for (const key of envFileKeys(resolve(projectDir, ref.path)))
          if (!keys.has(key)) keys.set(key, 'env_file')
      for (const key of rawEnvironmentKeys(svc.environment)) keys.set(key, 'environment')
      origins.set(service, keys)
    }
  }
  return origins
}

function parseImage(image: string): ImageRef {
  const [withoutDigest, digest] = image.split('@')
  const slash = withoutDigest.lastIndexOf('/')
  const colon = withoutDigest.lastIndexOf(':')
  const hasTag = colon > slash
  const name = hasTag ? withoutDigest.slice(0, colon) : withoutDigest
  const tag = hasTag ? withoutDigest.slice(colon + 1) : undefined
  const first = name.split('/')[0]
  const explicit =
    name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')
  const registry = !explicit || /^(index|registry-1)\.docker\.io$/.test(first) ? 'docker.io' : first
  const path = explicit ? name.slice(first.length + 1) : name
  return {
    name,
    registry,
    path: registry === 'docker.io' && !path.includes('/') ? `library/${path}` : path,
    tag,
    digest,
  }
}

function canonical(ref: ImageRef): string {
  return `${ref.registry}/${ref.path}`
}

function classify(image: string): { kind: Kind | 'redis'; reason?: string } {
  if (!image) return { kind: 'app' }
  const { path } = parseImage(image)
  const last = path.split('/').at(-1) ?? path
  if (POSTGRES_RE.test(path)) return { kind: 'postgres' }
  const infra = INFRA.find((entry) => entry.test(path, last))
  if (infra) return { kind: 'infra', reason: infra.reason }
  if (REDIS_RE.test(last)) return { kind: 'redis' }
  return { kind: 'app' }
}

function containerKey(service: string): string {
  return service.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

function planServices(services: Dict, draft: Draft): Map<string, Planned> {
  const kinds = new Map<string, Kind>()
  let postgresTaken = false
  for (const [service, raw] of Object.entries(services)) {
    const image = text(record(raw).image)
    const { kind, reason } = classify(image)
    if (kind === 'infra') {
      draft.dropped.push({ service, reason: reason ?? 'infrastructure' })
      kinds.set(service, 'infra')
    } else if (kind === 'postgres' && !postgresTaken) {
      postgresTaken = true
      kinds.set(service, 'postgres')
    } else {
      if (kind === 'postgres')
        draft.flags.push({ container: containerKey(service), issue: `second Postgres service ${service} kept as a plain container; needs.postgres covers one cluster`, severity: 'warn' })
      if (kind === 'redis')
        draft.flags.push({ container: containerKey(service), issue: `${image} kept as a plain container: needs.redis is not implemented`, severity: 'info' })
      kinds.set(service, 'app')
    }
  }
  const plan = new Map<string, Planned>()
  const taken = new Set(postgresTaken ? ['postgres'] : [])
  for (const [service, kind] of kinds) {
    if (kind !== 'app') {
      plan.set(service, { kind, key: kind === 'postgres' ? 'postgres' : containerKey(service) })
      continue
    }
    const wanted = containerKey(service)
    let key = wanted
    for (let n = 2; taken.has(key); n++) key = `${wanted}-${n}`
    if (key !== wanted)
      draft.flags.push({ container: key, issue: `container key ${wanted} is taken, ${service} became ${key}`, severity: 'warn' })
    taken.add(key)
    plan.set(service, { kind, key })
  }
  return plan
}

function hostNames(service: string, svc: Dict): string[] {
  const aliases = Object.values(record(svc.networks)).flatMap((net) => list(record(net).aliases).map(text))
  return [service, text(svc.container_name), text(svc.hostname), ...aliases].filter(Boolean)
}

function hostMap(services: Dict, plan: Map<string, Planned>): Map<string, string> {
  const hosts = new Map<string, string>()
  for (const [service, raw] of Object.entries(services)) {
    const planned = plan.get(service)
    if (!planned || planned.kind === 'infra') continue
    for (const host of hostNames(service, record(raw)))
      if (host !== planned.key && !hosts.has(host)) hosts.set(host, planned.key)
  }
  return hosts
}

function hostPattern(host: string, flags: string): RegExp {
  return new RegExp(`(^|//|@|host=|server=)${escapeRegExp(host)}(?=$|[/?,;\\s]|:(?!//))`, flags)
}

function isNameOrCredentialKey(key: string): boolean {
  return /(USER|USERNAME|NAME|DB|DATABASE|PASS|PASSWORD)$/i.test(key) && !/(HOST|SERVER|ADDR)/i.test(key)
}

function namesHost(key: string, value: string, host: string): boolean {
  return hostPattern(host, 'i').test(value) && !(value === host && isNameOrCredentialKey(key))
}

function rewriteHosts(key: string, value: string, hosts: Map<string, string>): string {
  let out = value
  for (const [from, to] of hosts)
    if (namesHost(key, out, from))
      out = out.replace(hostPattern(from, 'gi'), (_, prefix: string) => `${prefix}${to}`)
  return out
}

function credentialTemplate(value: string): string | undefined {
  if (CREDENTIAL_URL_RE.test(value)) return value.replace(CREDENTIAL_URL_RE, '$1<password>$3')
  if (DSN_PASSWORD_RE.test(value)) return value.replace(DSN_PASSWORD_RE, '$1<password>')
  return undefined
}

function credentialPassword(value: string): string | undefined {
  return value.match(CREDENTIAL_URL_RE)?.[2] ?? value.match(DSN_PASSWORD_RE)?.[2]
}

function redact(value: string): string {
  return credentialTemplate(value) ?? value
}

function classifyEnv(
  key: string,
  value: string,
): { secret: boolean; hint: string | null; configLike: boolean } {
  const template = credentialTemplate(value)
  if (template) return { secret: true, hint: `credentials in value, template: ${template}`, configLike: false }
  if (value === '') return { secret: true, hint: 'empty in compose', configLike: false }
  if (PLACEHOLDER_RE.test(value)) return { secret: true, hint: `placeholder "${value}"`, configLike: false }
  if (!SECRET_KEY_RE.test(key)) return { secret: false, hint: null, configLike: false }
  if (WEAK_VALUE_RE.test(value)) return { secret: true, hint: `upstream example value "${value}"`, configLike: false }
  const configLike = CONFIG_KEY_RE.test(key) || CONFIG_VALUE_RE.test(value)
  return { secret: true, hint: configLike ? 'may not be a secret, see flags' : null, configLike }
}

function seconds(value: unknown): number | undefined {
  if (typeof value === 'number') return Math.ceil(value / 1e9)
  if (typeof value !== 'string' || !value) return undefined
  if (/^\d+$/.test(value)) return Math.ceil(Number(value) / 1e9)
  const units: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9 }
  let total = 0
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/g))
    total += Number(match[1]) * units[match[2]]
  return Math.ceil(Math.round(total * 1e6) / 1e6)
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

function testString(test: unknown): string | null | undefined {
  if (typeof test === 'string') return test === 'NONE' ? null : unescapeDollar(test)
  if (!Array.isArray(test) || test.length === 0) return undefined
  const [kind, ...rest] = test.map((part) => unescapeDollar(text(part)))
  if (kind === 'NONE') return null
  if (kind === 'CMD-SHELL') return rest.join(' ')
  if (kind === 'CMD') return rest.map(shellQuote).join(' ')
  return [kind, ...rest].map(shellQuote).join(' ')
}

function definedTimings(timings: Timings): Timings {
  return Object.fromEntries(
    Object.entries(timings).filter(([, value]) => value !== undefined && !Number.isNaN(value)),
  )
}

function healthcheck(test: string, timings: Timings): Healthcheck {
  const hc: Healthcheck = { test }
  for (const field of ['interval', 'timeout', 'retries', 'startPeriod'] as const) {
    const value = timings[field]
    if (value === undefined || Number.isNaN(value)) continue
    const clamped = field === 'startPeriod' ? Math.max(0, value) : Math.max(1, value)
    if (clamped !== HEALTHCHECK_DEFAULTS[field]) hc[field] = clamped
  }
  return hc
}

function postgresMajor(tag: string | undefined): number | null {
  const match = tag?.match(/pg(\d+)/) ?? tag?.match(/^(\d+)/)
  return match ? Number(match[1]) : null
}

function postgresSettings(command: string[]): { settings: Record<string, string>; leftovers: string[] } {
  const args = command[0] === 'postgres' ? command.slice(1) : command
  const settings: Record<string, string> = {}
  const leftovers: string[] = []
  const assign = (pair: string) => {
    const eq = pair.indexOf('=')
    if (eq > 0) settings[pair.slice(0, eq)] = pair.slice(eq + 1)
    else leftovers.push(pair)
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '-c' && i + 1 < args.length) assign(args[++i])
    else if (arg.startsWith('-c')) assign(arg.slice(2))
    else if (arg.startsWith('--') && arg.includes('=')) assign(arg.slice(2))
    else leftovers.push(arg)
  }
  return { settings, leftovers }
}

function originOf(ctx: Context, service: string, key: string): Origin {
  return ctx.origins.get(service)?.get(key) ?? 'environment'
}

function buildPostgres(ctx: Context, service: string, svc: Dict): Postgres {
  const flag = (issue: string, severity: Severity = 'warn') =>
    ctx.draft.flags.push({ container: 'postgres', issue, severity })
  const env = Object.fromEntries(
    Object.entries(record(svc.environment)).map(([k, v]) => [k, unescapeDollar(text(v))]),
  )
  const image = text(svc.image)
  const ref = parseImage(image)
  const bitnami = ref.path === 'bitnami/postgresql'
  const passwordKey = bitnami ? 'POSTGRESQL_PASSWORD' : 'POSTGRES_PASSWORD'
  const userKey = bitnami ? 'POSTGRESQL_USERNAME' : 'POSTGRES_USER'
  const dbKey = bitnami ? 'POSTGRESQL_DATABASE' : 'POSTGRES_DB'
  const user = env[userKey] || ctx.draft.name
  const database = env[dbKey] || env[userKey] || ctx.draft.name
  const authMethod = env.POSTGRES_HOST_AUTH_METHOD
  const { settings, leftovers } = postgresSettings(list(svc.command).map((v) => unescapeDollar(text(v))))
  const major = postgresMajor(ref.tag)
  const known = new Set([userKey, dbKey, passwordKey, 'POSTGRES_HOST_AUTH_METHOD'])

  if (bitnami)
    flag('bitnami/postgresql uses POSTGRESQL_* env and its own data dir; the collector drives the official image (POSTGRES_*, cmd postgres, /var/lib/postgresql/data), switch to postgres:<major>', 'strong')
  if (!env[userKey])
    flag(`${userKey} is not set in compose (the image default is "postgres"); the draft uses user = "${user}", check the app connects as that user`)
  if (!env[dbKey])
    flag(`${dbKey} is not set in compose; the draft uses databases = [ "${database}" ]`, 'info')
  if (authMethod && authMethod !== 'md5' && authMethod !== 'scram-sha-256')
    flag(`POSTGRES_HOST_AUTH_METHOD=${authMethod} is not supported; the collector uses scram-sha-256 (or md5)`)
  if (leftovers.length) flag(`postgres command arguments not mapped to settings: ${leftovers.join(' ')}`)
  for (const key of Object.keys(env).filter((k) => !known.has(k)).sort())
    flag(`postgres env ${key} dropped; the collector renders the postgres container`)
  if (svc.healthcheck) flag('compose healthcheck of the database dropped; the collector adds pg_isready', 'info')
  const extraKeys = Object.keys(svc).filter((key) => !POSTGRES_COVERED_KEYS.has(key) && !IGNORED_KEYS.has(key))
  if (extraKeys.length)
    flag(`postgres compose keys not carried over: ${extraKeys.join(', ')}; add them under containers.postgres if the database needs them`)

  const password = env[passwordKey]
  ctx.draft.secrets.push({
    key: 'POSTGRES_PASSWORD',
    container: 'postgres',
    origin: originOf(ctx, service, passwordKey),
    hint: joinHints(
      password === undefined ? 'not set in compose; needs.postgres reads it from secrets.env' : null,
      password === '' ? 'empty in compose' : null,
      password && (PLACEHOLDER_RE.test(password) || WEAK_VALUE_RE.test(password)) ? `upstream example value "${password}"` : null,
    ),
    value: password ?? '',
  })

  return {
    service,
    image,
    databases: [database],
    user,
    hostAuthMethod: authMethod === 'md5' ? 'md5' : 'scram-sha-256',
    settings,
    password: password || undefined,
    major,
    originalVolumes: list(svc.volumes).map((raw) => {
      const volume = record(raw)
      const rel = projectRelative(ctx.projectDirs, text(volume.source))
      return `${rel === undefined ? text(volume.source) : `./${rel}`}:${text(volume.target)}`
    }),
  }
}

function mapCommand(c: Container, svc: Dict, flag: FlagFn): void {
  const command = list(svc.command).map((v) => unescapeDollar(text(v)))
  if (svc.entrypoint === undefined || svc.entrypoint === null) {
    c.cmd = command
    return
  }
  const entrypoint = list(svc.entrypoint).map((v) => unescapeDollar(text(v)))
  if (entrypoint.length === 0) {
    c.entrypoint = ''
    c.cmd = command
    flag('entrypoint is reset to empty in compose; emitted entrypoint = "", check podman honours it')
    return
  }
  const [first, ...rest] = entrypoint
  c.entrypoint = first
  c.cmd = [...rest, ...command]
  if (rest.length)
    flag(`entrypoint has ${entrypoint.length} elements: entrypoint = "${first}", the rest is prepended to cmd`)
}

function mapEnvironment(ctx: Context, c: Container, svc: Dict, flag: FlagFn): void {
  const env = record(svc.environment)
  for (const key of Object.keys(env).sort()) {
    const raw = env[key]
    const original = raw === null ? '' : unescapeDollar(text(raw))
    const value = rewriteHosts(key, original, ctx.hosts)
    if (value === original && ctx.hosts.has(original) && isNameOrCredentialKey(key))
      flag(`${key}=${original} matches the old host name but looks like a user, database name or password; not rewritten to ${ctx.hosts.get(original)}`, 'info')
    if (value !== original)
      ctx.draft.rewrites.push({ container: c.key, key, from: redact(original), to: redact(value) })
    const verdict = classifyEnv(key, value)
    if (!verdict.secret) {
      c.environment[key] = value
      continue
    }
    ctx.draft.secrets.push({
      key,
      container: c.key,
      origin: originOf(ctx, c.service, key),
      hint: joinHints(raw === null ? 'passed through from the host environment in compose' : null, verdict.hint),
      value,
    })
    if (verdict.configLike)
      flag(`${key} matched the secret pattern but looks like configuration; it went to secrets, move it back to environment if it is not secret`, 'info')
  }
}

function projectRelative(projectDirs: string[], source: string): string | undefined {
  for (const dir of projectDirs) {
    if (source === dir) return ''
    if (source.startsWith(dir + sep)) return source.slice(dir.length + 1)
  }
  return undefined
}

function looksLikeFile(path: string): boolean {
  if (existsSync(path)) return statSync(path).isFile()
  return /\.[A-Za-z0-9]{1,8}$/.test(basename(path))
}

function volumeSource(ctx: Context, c: Container, volume: Dict, flag: FlagFn): string {
  const base = ctx.draft.base
  const target = text(volume.target)
  if (volume.type === 'volume') {
    const name = text(volume.source)
    if (!name) {
      const path = `${base}/${c.key}${target.replaceAll('/', '-')}`
      flag(`anonymous volume at ${target} mapped to ${path}`, 'info')
      return path
    }
    const top = record(ctx.topVolumes[name])
    if (top.external || top.driver || top.driver_opts)
      flag(`named volume ${name} is external or driver-backed in compose; mapped to a plain host dir`)
    return `${base}/${name}`
  }
  const source = text(volume.source)
  const rel = projectRelative(ctx.projectDirs, source)
  if (rel !== undefined) {
    const path = rel ? `${base}/${rel}` : base
    if (looksLikeFile(source))
      flag(`bind source ./${rel} looks like a file: the unit preStart would mkdir ${path}. Ship it from the repo ("\${./${basename(rel)}}:${target}:ro") or provision it on the host`, 'strong')
    return path
  }
  if (source === '/var/run/docker.sock' || source === '/run/docker.sock')
    flag(`mounts the Docker socket ${source}: root-equivalent host access, and podman has no docker daemon there`, 'strong')
  else flag(`host path ${source} kept verbatim`)
  return source
}

function mapVolumes(ctx: Context, c: Container, svc: Dict, flag: FlagFn): void {
  for (const raw of list(svc.volumes)) {
    const volume = record(raw)
    const target = text(volume.target)
    if (volume.type === 'tmpfs') {
      c.extraOptions.push(`--tmpfs=${target}`)
      continue
    }
    if (volume.type !== 'volume' && volume.type !== 'bind') {
      flag(`${text(volume.type)} mount at ${target} is unsupported`)
      continue
    }
    const source = volumeSource(ctx, c, volume, flag)
    const bind = record(volume.bind)
    const options = [volume.read_only ? 'ro' : '', text(bind.selinux), text(bind.propagation)].filter(Boolean)
    const mount = `${source}:${target}${options.length ? `:${options.join(',')}` : ''}`
    if (!BIND_MOUNT_RE.test(mount)) flag(`volume ${mount} does not match the homelab bind-mount schema`)
    c.volumes.push(mount)
  }
}

function mapHealthcheck(c: Container, svc: Dict): void {
  if (svc.healthcheck === undefined) return
  const hc = record(svc.healthcheck)
  if (hc.disable) return
  const test = testString(hc.test)
  const timings = definedTimings({
    interval: seconds(hc.interval),
    timeout: seconds(hc.timeout),
    retries: hc.retries === undefined ? undefined : Number(hc.retries),
    startPeriod: seconds(hc.start_period),
  })
  if (test === null) return
  if (test === undefined) c.inheritHealthcheck = timings
  else c.healthcheck = healthcheck(test, timings)
}

function mapNetworkMode(ctx: Context, c: Container, svc: Dict, flag: FlagFn): void {
  const mode = text(svc.network_mode)
  if (!mode || mode === 'bridge' || mode === 'default') return
  if (mode.startsWith('service:')) {
    const owner = ctx.plan.get(mode.slice('service:'.length))
    if (owner?.kind === 'app') c.networkVia = owner.key
    else flag(`network_mode ${mode} points at a dropped service; this container lost its network stack owner`, 'strong')
    return
  }
  if (mode === 'host') ctx.hostNetwork.add(c.key)
  flag(`network_mode ${mode} is unsupported; every container joins the service network`, 'strong')
}

function mapDependsOn(ctx: Context, c: Container, svc: Dict, flag: FlagFn): void {
  for (const [dep, spec] of Object.entries(record(svc.depends_on))) {
    const target = ctx.plan.get(dep)
    if (!target || target.kind !== 'app') continue
    const condition = text(record(spec).condition)
    if (condition === 'service_healthy') ctx.draft.healthyWanted.push({ from: c.key, dep: target.key })
    if (condition === 'service_completed_successfully')
      flag(`waits for ${dep} to complete; homelab containers are long-running units, one-shot init containers are not modelled`)
    if (target.key !== c.networkVia && target.key !== c.key) c.dependsOn.push(target.key)
  }
}

function deviceString(device: unknown): string {
  if (typeof device === 'string') return device
  const d = record(device)
  const permissions = text(d.permissions)
  return `${text(d.source)}:${text(d.target) || text(d.source)}${permissions && permissions !== 'rwm' ? `:${permissions}` : ''}`
}

function ulimitValue(value: unknown): string {
  const limit = record(value)
  if (limit.soft !== undefined || limit.hard !== undefined) return `${text(limit.soft)}:${text(limit.hard)}`
  if (limit.single !== undefined) return text(limit.single)
  return text(value)
}

function keyValues(value: unknown): [string, string][] {
  if (Array.isArray(value))
    return value.map((entry) => {
      const [k, ...rest] = text(entry).split('=')
      return [k, rest.join('=')]
    })
  return Object.entries(record(value)).map(([k, v]) => [k, text(v)])
}

function mapRuntimeOptions(c: Container, svc: Dict, flag: FlagFn): void {
  c.capabilities = list(svc.cap_add).map(text)
  c.devices = list(svc.devices).map(deviceString)
  if (text(svc.user)) c.user = text(svc.user)
  for (const cap of list(svc.cap_drop)) c.extraOptions.push(`--cap-drop=${text(cap)}`)
  if (svc.privileged) {
    c.extraOptions.push('--privileged')
    flag('privileged: full access to host devices and capabilities', 'strong')
  }
  if (svc.shm_size !== undefined) c.extraOptions.push(`--shm-size=${text(svc.shm_size)}`)
  for (const [k, v] of keyValues(svc.sysctls)) c.extraOptions.push(`--sysctl=${k}=${v}`)
  for (const opt of list(svc.security_opt)) c.extraOptions.push(`--security-opt=${text(opt)}`)
  if (svc.init) {
    c.extraOptions.push('--init')
    flag('init: --init breaks s6-overlay images (linuxserver and similar)')
  }
  for (const [name, value] of Object.entries(record(svc.ulimits)))
    c.extraOptions.push(`--ulimit=${name}=${ulimitValue(value)}`)
  for (const target of list(svc.tmpfs)) c.extraOptions.push(`--tmpfs=${text(target)}`)
  for (const [key, option] of PASSTHROUGH_OPTIONS)
    for (const value of list(svc[key])) c.extraOptions.push(`${option}=${text(value)}`)
  if (svc.secrets !== undefined) flag('compose secrets (/run/secrets) are unsupported; move the values into secrets.env')
  if (svc.configs !== undefined) flag('compose configs are unsupported; mount the file from the repo instead')
  if (parseImage(c.image).path.startsWith('linuxserver/') && c.user)
    flag('s6-overlay image with user: set PUID/PGID in environment and drop user')
}

function portsOf(svc: Dict): Port[] {
  return list(svc.ports)
    .map((raw) => record(raw))
    .filter((port) => port.target !== undefined)
    .map((port) => ({ target: Number(port.target), protocol: text(port.protocol) || 'tcp' }))
}

function onlyDefaultNetwork(networks: unknown): boolean {
  const entries = Object.entries(record(networks))
  return entries.length === 1 && entries[0][0] === 'default' && entries[0][1] === null
}

function recordIgnored(ctx: Context, c: Container, svc: Dict, flag: FlagFn): void {
  const keys: string[] = []
  for (const key of Object.keys(svc)) {
    if (key === 'networks') {
      if (!onlyDefaultNetwork(svc.networks)) keys.push(key)
    } else if (IGNORED_KEYS.has(key)) keys.push(key)
    else if (!HANDLED_KEYS.has(key) && !key.startsWith('x-')) flag(`compose key ${key} is not mapped`)
  }
  ctx.draft.ignored.set(c.key, keys)
}

function buildContainer(ctx: Context, service: string, svc: Dict, key: string): Container {
  const flag = (issue: string, severity: Severity = 'warn') =>
    ctx.draft.flags.push({ container: key, issue, severity })
  const c: Container = {
    key,
    service,
    image: text(svc.image),
    ports: portsOf(svc),
    cmd: [],
    environment: {},
    volumes: [],
    capabilities: [],
    devices: [],
    dependsOn: [],
    extraOptions: [],
  }
  if (svc.build !== undefined)
    flag(
      c.image
        ? 'has build: the draft uses the published image, check it matches the local build'
        : 'build: without image: is unsupported, the homelab needs a registry image',
      c.image ? 'warn' : 'strong',
    )
  mapCommand(c, svc, flag)
  mapEnvironment(ctx, c, svc, flag)
  mapVolumes(ctx, c, svc, flag)
  mapHealthcheck(c, svc)
  mapNetworkMode(ctx, c, svc, flag)
  mapDependsOn(ctx, c, svc, flag)
  mapRuntimeOptions(c, svc, flag)
  recordIgnored(ctx, c, svc, flag)
  return c
}

function pickIngress(ctx: Context): void {
  const { draft } = ctx
  const candidates = draft.containers
    .filter((c) => !ctx.hostNetwork.has(c.key))
    .map((c) => ({ container: c.key, port: c.ports.find((p) => p.protocol !== 'udp')?.target }))
    .filter((c): c is { container: string; port: number } => c.port !== undefined)
  if (!candidates.length) {
    draft.questions.push('No container publishes a port. Which container and internal port serve the web UI (it becomes `port`)?')
    return
  }
  const web = WEB_PORTS.map((port) => candidates.find((c) => c.port === port)).find(Boolean)
  const lowest = [...candidates].sort((a, b) => a.port - b.port)[0]
  const chosen = candidates.length === 1 ? candidates[0] : (web ?? lowest)
  const alternatives = candidates.filter((c) => c !== chosen)
  draft.ingress = { container: chosen.container, port: chosen.port, alternatives }
  if (alternatives.length)
    draft.questions.push(
      `Several containers publish ports; ${chosen.container}:${chosen.port} was picked as ingress. Alternatives: ${alternatives.map((a) => `${a.container}:${a.port}`).join(', ')}. Which one is the web UI?`,
    )
  for (const c of draft.containers) {
    if (c.key === chosen.container) {
      c.port = chosen.port
      const extra = c.ports.filter((p) => !(p.target === chosen.port && p.protocol !== 'udp'))
      if (extra.length)
        draft.flags.push({ container: c.key, issue: `published ports not carried over (only the ingress port is proxied): ${extra.map((p) => `${p.target}/${p.protocol}`).join(', ')}`, severity: 'warn' })
    } else if (c.ports.length) draft.ignored.get(c.key)?.push('ports')
  }
}

function noteNetworkGuests(draft: Draft): void {
  for (const owner of draft.containers) {
    const guests = draft.containers.filter((c) => c.networkVia === owner.key).map((c) => c.key)
    if (guests.length)
      draft.flags.push({ container: owner.key, issue: `shares its network namespace with ${guests.join(', ')} (networkVia); its published ports also serve them`, severity: 'info' })
  }
}

function fixPostgresShadowing(draft: Draft): void {
  if (!draft.postgres) return
  const dataDir = `${draft.base}/postgres`
  for (const c of draft.containers) {
    c.volumes = c.volumes.map((mount) => {
      const [source, ...rest] = mount.split(':')
      const moved =
        source === draft.base
          ? `${draft.base}/${c.key}`
          : source === dataDir || source.startsWith(`${dataDir}/`)
            ? `${draft.base}/${c.key}-postgres${source.slice(dataDir.length)}`
            : source
      if (moved === source) return mount
      draft.flags.push({ container: c.key, issue: `volume source ${source} would shadow needs.postgres dataDir ${dataDir}; moved to ${moved}`, severity: 'warn' })
      return [moved, ...rest].join(':')
    })
  }
}

function linkPostgresPassword(draft: Draft): void {
  const pg = draft.postgres
  if (!pg) return
  let referenced = false
  for (const secret of draft.secrets) {
    if (secret.container === 'postgres' || !pg.password) continue
    if (secret.value === pg.password || credentialPassword(secret.value) === pg.password) {
      secret.hint = joinHints(secret.hint, 'uses the same password as POSTGRES_PASSWORD')
      referenced = true
    }
  }
  if (!referenced)
    draft.questions.push(
      "No app env var in the compose carries the Postgres password (the app probably relies on a default). Find the app's DB password setting in the upstream docs and put it next to POSTGRES_PASSWORD in secrets.yaml.",
    )
}

function checkPostgresHost(draft: Draft): void {
  const pg = draft.postgres
  if (!pg || pg.service === 'postgres') return
  const pairs = [
    ...draft.containers.flatMap((c) => Object.entries(c.environment)),
    ...draft.secrets.filter((s) => s.container !== 'postgres').map((s) => [s.key, s.value]),
  ]
  if (pairs.some(([key, value]) => namesHost(key, value, 'postgres'))) return
  draft.questions.push(
    `No app env var names the database host, so the app probably defaults to the compose service name "${pg.service}". The dedicated Postgres answers as "postgres": set the app's DB host variable (see upstream docs) to postgres.`,
  )
}

function checkSecretConflicts(draft: Draft): void {
  const byKey = new Map<string, Secret[]>()
  for (const secret of draft.secrets) byKey.set(secret.key, [...(byKey.get(secret.key) ?? []), secret])
  for (const [key, entries] of byKey) {
    if (new Set(entries.map((e) => e.value)).size > 1)
      draft.flags.push({ container: null, issue: `secret ${key} has different values in ${entries.map((e) => e.container).join(', ')}; secrets.env is shared by every container, the values must agree`, severity: 'warn' })
  }
}

function orderContainers(draft: Draft): void {
  draft.containers.sort((a, b) => {
    if (a.key === draft.ingress.container) return -1
    if (b.key === draft.ingress.container) return 1
    return a.key.localeCompare(b.key)
  })
}

function convert(name: string, project: Dict, origins: Map<string, Map<string, Origin>>, projectDir: string): Draft {
  const draft: Draft = {
    name,
    base: `/var/lib/${name}`,
    containers: [],
    postgres: null,
    secrets: [],
    rewrites: [],
    dropped: [],
    ignored: new Map(),
    flags: [],
    questions: [],
    ingress: { container: null, port: null, alternatives: [] },
    healthyWanted: [],
  }
  const services = record(project.services)
  if (!Object.keys(services).length) fail('the normalized compose has no services (check --profile)')
  const plan = planServices(services, draft)
  const ctx: Context = {
    draft,
    plan,
    hosts: hostMap(services, plan),
    origins,
    projectDirs: [...new Set([projectDir, realpathSync(projectDir)])],
    topVolumes: record(project.volumes),
    hostNetwork: new Set(),
  }
  for (const [service, raw] of Object.entries(services)) {
    const planned = plan.get(service)!
    if (planned.kind === 'postgres') draft.postgres = buildPostgres(ctx, service, record(raw))
    if (planned.kind === 'app') draft.containers.push(buildContainer(ctx, service, record(raw), planned.key))
  }
  pickIngress(ctx)
  noteNetworkGuests(draft)
  fixPostgresShadowing(draft)
  linkPostgresPassword(draft)
  checkPostgresHost(draft)
  checkSecretConflicts(draft)
  orderContainers(draft)
  return draft
}

async function craneCommand(): Promise<string[]> {
  return (await $.commandExists('crane')) ? ['crane'] : ['nix', 'shell', 'nixpkgs#crane', '-c', 'crane']
}

async function craneDigest(crane: string[], ref: ImageRef): Promise<{ digest?: string; error?: string }> {
  const result = await $`${crane} digest ${`${canonical(ref)}:${ref.tag ?? 'latest'}`}`
    .stdout('piped')
    .stderr('piped')
    .noThrow()
  const digest = result.stdout.trim()
  return result.code === 0 && DIGEST_RE.test(digest)
    ? { digest }
    : { error: result.stderr.trim().split('\n').at(-1) || `exit ${result.code}` }
}

async function imageHealthcheck(crane: string[], image: string, overrides: Timings = {}): Promise<Healthcheck | undefined> {
  const ref = parseImage(image)
  if (!ref.digest || !DIGEST_RE.test(ref.digest)) return undefined
  const result = await $`${crane} config --platform linux/amd64 ${`${canonical(ref)}@${ref.digest}`}`
    .stdout('piped')
    .stderr('piped')
    .noThrow()
  if (result.code !== 0) return undefined
  try {
    const hc = record(record(record(JSON.parse(result.stdout)).config).Healthcheck)
    const test = testString(hc.Test)
    if (!test) return undefined
    const timings = definedTimings({
      interval: seconds(hc.Interval),
      timeout: seconds(hc.Timeout),
      retries: hc.Retries === undefined ? undefined : Number(hc.Retries),
      startPeriod: seconds(hc.StartPeriod),
    })
    return healthcheck(test, { ...timings, ...overrides })
  } catch {
    return undefined
  }
}

async function pinImages(draft: Draft, resolveDigests: boolean, crane: string[]): Promise<void> {
  const owners = [
    ...draft.containers.map((c) => ({ container: c.key, image: c.image })),
    ...(draft.postgres ? [{ container: 'postgres', image: draft.postgres.image }] : []),
  ].filter((owner) => owner.image)
  const images = [...new Set(owners.map((owner) => owner.image))]
  const pinned = new Map<string, string>()
  await Promise.all(
    images.map(async (image) => {
      const ref = parseImage(image)
      const tagged = `${ref.name}:${ref.tag ?? 'latest'}`
      if (ref.digest) return void pinned.set(image, image)
      if (!resolveDigests) return void pinned.set(image, `${tagged}@sha256:TODO`)
      const { digest, error } = await craneDigest(crane, ref)
      pinned.set(image, `${tagged}@${digest ?? 'sha256:TODO'}`)
      if (error)
        for (const owner of owners.filter((o) => o.image === image))
          draft.flags.push({ container: owner.container, issue: `digest of ${image} not resolved (${error}); image left as @sha256:TODO`, severity: 'strong' })
    }),
  )
  for (const owner of owners) {
    const ref = parseImage(owner.image)
    if (!ref.tag || ref.tag === 'latest')
      draft.flags.push({ container: owner.container, issue: `${owner.image} is ${ref.tag ? 'tagged latest' : 'untagged'}; pick a release tag and re-pin`, severity: 'warn' })
  }
  for (const c of draft.containers) if (c.image) c.image = pinned.get(c.image)!
  if (draft.postgres) draft.postgres.image = pinned.get(draft.postgres.image)!
  if (!resolveDigests)
    draft.flags.push({ container: null, issue: 'digests not resolved (--no-digest); every image ends in @sha256:TODO', severity: 'strong' })
}

async function importHealthchecks(draft: Draft, resolveDigests: boolean, crane: string[]): Promise<void> {
  for (const c of draft.containers.filter((c) => c.inheritHealthcheck)) {
    if (!resolveDigests) {
      draft.flags.push({ container: c.key, issue: 'compose keeps the image healthcheck; not imported with --no-digest', severity: 'warn' })
      continue
    }
    const hc = await imageHealthcheck(crane, c.image, c.inheritHealthcheck)
    if (!hc) continue
    c.healthcheck = hc
    draft.flags.push({ container: c.key, issue: 'healthcheck test taken from the image config (compose keeps the image healthcheck)', severity: 'info' })
  }
  const handled = new Set<string>()
  for (const { from, dep } of draft.healthyWanted) {
    const target = draft.containers.find((c) => c.key === dep)
    if (!target || target.healthcheck) continue
    if (!handled.has(dep)) {
      handled.add(dep)
      const hc = resolveDigests ? await imageHealthcheck(crane, target.image) : undefined
      if (hc) {
        target.healthcheck = hc
        draft.flags.push({ container: dep, issue: 'healthcheck imported from the image config so dependents can wait for service_healthy', severity: 'info' })
        continue
      }
    }
    if (!target.healthcheck)
      draft.flags.push({ container: from, issue: `depends on ${dep} with condition service_healthy, but ${dep} has no healthcheck`, severity: 'warn' })
  }
  const ingress = draft.containers.find((c) => c.key === draft.ingress.container)
  if (ingress && !ingress.healthcheck)
    draft.flags.push({ container: ingress.key, issue: 'ingress container has no healthcheck; take the probe from upstream docs so readiness gates the unit start', severity: 'warn' })
}

function applyStartTimeouts(draft: Draft): void {
  for (const c of draft.containers) {
    const startPeriod = c.healthcheck?.startPeriod ?? 0
    if (startPeriod >= 300) c.startTimeout = startPeriod + 120
  }
}

class Attrs {
  constructor(readonly entries: [string, Nix][]) {}
}

class NixPath {
  constructor(readonly path: string) {}
}

type Nix = string | number | boolean | Nix[] | Attrs | NixPath

const NIX_KEYWORDS = new Set(['if', 'then', 'else', 'assert', 'with', 'let', 'in', 'rec', 'inherit', 'or'])

function nixString(value: string): string {
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('${', '\\${')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
  return `"${escaped}"`
}

function attrName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_'-]*$/.test(name) && !NIX_KEYWORDS.has(name) ? name : nixString(name)
}

function renderNix(value: Nix, depth: number): string {
  const pad = '  '.repeat(depth)
  if (typeof value === 'string') return nixString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof NixPath) return value.path
  if (value instanceof Attrs) {
    if (!value.entries.length) return '{ }'
    const lines = value.entries.map(([key, v]) => `${pad}  ${key} = ${renderNix(v, depth + 1)};`)
    return `{\n${lines.join('\n')}\n${pad}}`
  }
  if (!value.length) return '[ ]'
  const items = value.map((item) => renderNix(item, depth + 1))
  if (items.length === 1 && !items[0].includes('\n') && items[0].length <= 60) return `[ ${items[0]} ]`
  return `[\n${items.map((item) => `${pad}  ${item}`).join('\n')}\n${pad}]`
}

function healthcheckNix(hc: Healthcheck): Attrs {
  const entries: [string, Nix][] = [['test', hc.test]]
  for (const field of ['interval', 'timeout', 'retries', 'startPeriod'] as const)
    if (hc[field] !== undefined) entries.push([field, hc[field]!])
  return new Attrs(entries)
}

function containerNix(c: Container): Attrs {
  const entries: [string, Nix][] = [['image', c.image || 'TODO@sha256:TODO']]
  if (c.port !== undefined) entries.push(['port', c.port])
  if (c.cmd.length) entries.push(['cmd', c.cmd])
  if (c.entrypoint !== undefined) entries.push(['entrypoint', c.entrypoint])
  if (c.user) entries.push(['user', c.user])
  const env = Object.entries(c.environment)
  if (env.length) entries.push(['environment', new Attrs(env.map(([k, v]) => [attrName(k), v]))])
  if (c.volumes.length) entries.push(['volumes', c.volumes])
  if (c.capabilities.length) entries.push(['capabilities', c.capabilities])
  if (c.devices.length) entries.push(['devices', c.devices])
  if (c.healthcheck) entries.push(['healthcheck', healthcheckNix(c.healthcheck)])
  if (c.startTimeout !== undefined) entries.push(['startTimeout', c.startTimeout])
  if (c.dependsOn.length) entries.push(['dependsOn', c.dependsOn])
  if (c.networkVia) entries.push(['networkVia', c.networkVia])
  if (c.extraOptions.length) entries.push(['extraOptions', c.extraOptions])
  return new Attrs(entries)
}

function postgresNix(pg: Postgres): Attrs {
  const entries: [string, Nix][] = [
    ['dedicated', true],
    ['image', pg.image],
    ['databases', pg.databases],
    ['user', pg.user],
  ]
  if (pg.hostAuthMethod === 'md5') entries.push(['hostAuthMethod', 'md5'])
  const settings = Object.entries(pg.settings)
  if (settings.length) entries.push(['settings', new Attrs(settings.map(([k, v]) => [attrName(k), v]))])
  return new Attrs(entries)
}

function draftNix(draft: Draft): string {
  const service: [string, Nix][] = draft.containers.map((c) => [`containers.${attrName(c.key)}`, containerNix(c)])
  if (draft.postgres) service.push(['needs.postgres', postgresNix(draft.postgres)])
  if (draft.secrets.length) service.push(['secrets.env', new NixPath('./secrets.yaml')])
  const root = new Attrs([[`homelab.services.${attrName(draft.name)}`, new Attrs(service)]])
  return `${renderNix(root, 0)}\n`
}

function draftReport(draft: Draft): Dict {
  const pg = draft.postgres
  return {
    name: draft.name,
    ingress: draft.ingress,
    containers: draft.containers.map((c) => ({ key: c.key, image: c.image, source_service: c.service })),
    postgres: pg
      ? {
          source_service: pg.service,
          image: pg.image,
          major: pg.major,
          databases: pg.databases,
          user: pg.user,
          hostAuthMethod: pg.hostAuthMethod,
          settings: pg.settings,
          password: 'POSTGRES_PASSWORD from secrets.env',
          dataDir: `${draft.base}/postgres`,
          compose_volumes: pg.originalVolumes,
        }
      : null,
    secrets: draft.secrets.map(({ key, container, origin, hint }) => ({ key, container, origin, hint })),
    rewrites: draft.rewrites,
    dropped: draft.dropped,
    ignored: [...draft.ignored]
      .filter(([, keys]) => keys.length)
      .map(([container, keys]) => ({ container, keys })),
    flags: draft.flags,
    questions: draft.questions,
  }
}

const main = defineCommand({
  meta: {
    name: 'compose-to-homelab',
    description: 'Draft a homelab.services.<name> Nix file and a report from a docker compose project',
  },
  args: {
    name: { type: 'string', required: true, description: 'Service name (homelab.services.<name>)' },
    compose: { type: 'string', required: true, description: 'Compose file path or URL, repeatable' },
    'env-file': { type: 'string', description: 'Interpolation env file path or URL, repeatable' },
    profile: { type: 'string', description: 'Compose profile to enable, repeatable' },
    out: { type: 'string', description: 'Write default.nix and report.json into this dir' },
    digest: { type: 'boolean', default: true, description: 'Resolve image digests with crane (--no-digest skips)' },
  },
  async run({ args, rawArgs }) {
    const name = args.name
    if (!NAME_RE.test(name)) fail(`--name must match ${NAME_RE}`)
    const inputs = await materialize(repeated(rawArgs, '--compose'), repeated(rawArgs, '--env-file'))
    const { project, flags } = await normalize(name, inputs, repeated(rawArgs, '--profile'))
    const draft = convert(name, project, envOrigins(inputs.composeFiles, inputs.projectDir), inputs.projectDir)
    rmSync(inputs.root, { recursive: true, force: true })
    draft.flags.unshift(...inputs.flags, ...flags)
    const resolveDigests = args.digest !== false
    const crane = resolveDigests ? await craneCommand() : []
    await pinImages(draft, resolveDigests, crane)
    await importHealthchecks(draft, resolveDigests, crane)
    applyStartTimeouts(draft)
    const nix = draftNix(draft)
    const report = `${JSON.stringify(draftReport(draft), null, 2)}\n`
    if (!args.out) {
      process.stdout.write(`${nix}---\n${report}`)
      return
    }
    mkdirSync(args.out, { recursive: true })
    writeFileSync(join(args.out, 'default.nix'), nix)
    writeFileSync(join(args.out, 'report.json'), report)
    process.stdout.write(`wrote ${join(args.out, 'default.nix')} and ${join(args.out, 'report.json')}\n`)
  },
})

void runMain(main)
