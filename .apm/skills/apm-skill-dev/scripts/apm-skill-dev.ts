#!/usr/bin/env bun
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

enum Scope {
  Global = 'global',
  Project = 'project',
}

enum Target {
  Claude = 'claude',
  Codex = 'codex',
}

const providerGeneratedRoots = [
  '.agents/skills',
  '.claude/skills',
  '.claude/commands',
  '.codex/skills',
  '.codex/prompts',
  '.cursor/skills',
  '.gemini/skills',
  '.opencode/skills',
]

const cacheGeneratedRoots = ['apm_modules']

interface IsolatedOptions {
  command: string[]
  skills: string[]
  source: string
  targets: Target[]
}

interface WithDevOptions {
  command: string[]
  consumer: string
  dependency: string
  scope: Scope
  source: string
}

interface StatusOptions {
  consumer?: string
}

interface RecoverOptions {
  consumer: string
  force: boolean
}

interface Snapshot {
  exists: boolean
  hash: string
  kind: 'file' | 'missing' | 'symlink'
  linkTarget?: string
}

interface GeneratedRootInventory {
  base: 'cache' | 'provider'
  entries: string[]
  existed: boolean
  root: string
}

interface TransactionState {
  consumerRoot: string
  lock: Snapshot
  lockPath: string
  manifest: Snapshot
  manifestPath: string
  pid: number
  providerSurface: GeneratedRootInventory[]
  scope: Scope
  source: string
  startedAt: string
  version: 1
}

interface Transaction {
  directory: string
  state: TransactionState
}

interface ManifestSelection {
  manifest: Record<string, unknown>
  selectedIndex: number
}

let activeProcess: Bun.Subprocess | undefined
let activeProcessCanBeInterrupted = false
let receivedSignal: NodeJS.Signals | undefined

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    receivedSignal ??= signal
    if (activeProcessCanBeInterrupted) activeProcess?.kill(signal)
  })
}

const exitCode = await runMain(process.argv.slice(2)).catch((error: unknown) => {
  console.error(errorMessage(error))
  return 1
})
process.exit(exitCode)

async function runMain(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args

  switch (subcommand) {
    case 'isolated':
      return runIsolated(parseIsolatedOptions(rest))
    case 'with-dev':
      return runWithDev(parseWithDevOptions(rest))
    case 'status':
      return runStatus(parseStatusOptions(rest))
    case 'recover':
      return runRecover(parseRecoverOptions(rest))
    default:
      throw new Error('usage: apm-skill-dev.ts isolated|with-dev|status|recover')
  }
}

async function runIsolated(options: IsolatedOptions): Promise<number> {
  const source = validateProducerRoot(options.source)
  const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'apm-skill-dev-')))
  const callerRoot = process.cwd()
  const dependency: Record<string, unknown> = { path: source }
  if (options.skills.length > 0) dependency.skills = options.skills
  const manifest = {
    dependencies: { apm: [dependency] },
    name: 'apm-skill-dev-consumer',
    targets: options.targets,
    version: '0.0.0',
  }

  try {
    writeFileSync(join(temporaryRoot, 'apm.yml'), `${Bun.YAML.stringify(manifest)}\n`)
    const installCode = await runProcess(['apm', 'install'], temporaryRoot, true)
    if (installCode !== 0) return signalExitCode() ?? installCode
    verifyIsolatedMaterialization(temporaryRoot, options.targets, options.skills)
    if (receivedSignal) return signalExitCode() ?? 1
    if (options.command.length === 0) return 0

    const childCode = await runProcess(options.command, callerRoot, true, {
      ...process.env,
      APM_DEV_ROOT: temporaryRoot,
    })

    return signalExitCode() ?? childCode
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true })
  }
}

async function runWithDev(options: WithDevOptions): Promise<number> {
  const source = validateProducerRoot(options.source)
  const consumerRoot = validateConsumerRoot(options.consumer)
  const paths = resolveConsumerPaths(options.scope, consumerRoot)
  if (options.scope === Scope.Global) verifyGlobalPaths(paths.manifestPath, paths.lockPath)
  assertNotOwned(paths.manifestPath, consumerRoot)
  const manifest = parseManifest(paths.manifestPath)
  const selection = selectProductionDependency(manifest, options.dependency)
  const transaction = createTransaction({
    consumerRoot,
    lockPath: paths.lockPath,
    manifestPath: paths.manifestPath,
    scope: options.scope,
    source,
  })
  let operationCode = 0

  try {
    const developmentManifest = replaceDependency(selection, source)
    writeFileSync(paths.manifestPath, `${Bun.YAML.stringify(developmentManifest)}\n`)
    operationCode = await runInstall(options.scope, consumerRoot, false)
    if (operationCode === 0 && !receivedSignal && options.command.length > 0) {
      operationCode = await runProcess(options.command, consumerRoot, true)
    }
  } catch (error: unknown) {
    console.error(errorMessage(error))
    operationCode = 1
  }

  const restoreCode = await restoreTransaction(transaction)
  if (restoreCode !== 0) return restoreCode

  return signalExitCode() ?? operationCode
}

async function runStatus(options: StatusOptions): Promise<number> {
  const consumer = options.consumer === undefined ? undefined : validateConsumerRoot(options.consumer)
  const entries = readTransactionEntries().filter(({ state }) => {
    if (consumer === undefined) return true

    return state?.consumerRoot === consumer
  })

  if (entries.length === 0) {
    console.log('no recovery state')
    return 0
  }

  for (const entry of entries) {
    if (entry.state === undefined) {
      console.log(`state=incomplete directory=${entry.directory}`)
      continue
    }
    const live = isPidLive(entry.state.pid) ? 'yes' : 'no'
    console.log(
      `state=${live === 'yes' ? 'active' : 'stale'} scope=${entry.state.scope} pid=${entry.state.pid} live=${live} source=${entry.state.source} consumer=${entry.state.consumerRoot} started=${entry.state.startedAt}`,
    )
  }

  return 0
}

async function runRecover(options: RecoverOptions): Promise<number> {
  const consumer = validateConsumerRoot(options.consumer)
  const entries = readTransactionEntries().filter(({ state }) => state?.consumerRoot === consumer)
  if (entries.length === 0) {
    console.log('no recovery state')
    return 0
  }
  if (entries.length !== 1) throw new Error(`multiple recovery states found for consumer: ${consumer}`)
  const entry = entries[0]
  if (entry?.state === undefined) throw new Error(`incomplete recovery state: ${entry?.directory ?? consumer}`)
  const ownerIsLive = isPidLive(entry.state.pid)
  if (ownerIsLive && !options.force) {
    throw new Error(`recovery state is owned by live PID ${entry.state.pid}; use --force to override`)
  }

  validateTransaction({ directory: entry.directory, state: entry.state })

  return restoreTransaction({ directory: entry.directory, state: entry.state })
}

function parseIsolatedOptions(args: string[]): IsolatedOptions {
  const { beforeCommand, command } = splitCommand(args)
  let source = ''
  const skills: string[] = []
  let targets = [Target.Claude, Target.Codex]

  for (let index = 0; index < beforeCommand.length; index += 1) {
    const argument = beforeCommand[index]
    switch (argument) {
      case '--source':
        source = requireOptionValue(beforeCommand, ++index, '--source')
        break
      case '--skill':
        skills.push(requireOptionValue(beforeCommand, ++index, '--skill'))
        break
      case '--target':
        targets = parseTargets(requireOptionValue(beforeCommand, ++index, '--target'))
        break
      default:
        throw new Error(`unknown isolated option: ${argument}`)
    }
  }
  if (source.length === 0) throw new Error('isolated requires --source')

  return { command, skills: unique(skills), source, targets }
}

function parseWithDevOptions(args: string[]): WithDevOptions {
  const { beforeCommand, command } = splitCommand(args)
  let consumer = ''
  let dependency = ''
  let scope: Scope | undefined
  let source = ''

  for (let index = 0; index < beforeCommand.length; index += 1) {
    const argument = beforeCommand[index]
    const value = () => requireOptionValue(beforeCommand, ++index, argument ?? '')
    switch (argument) {
      case '--consumer':
        consumer = value()
        break
      case '--dependency':
        dependency = value()
        break
      case '--scope':
        scope = parseScope(value())
        break
      case '--source':
        source = value()
        break
      default:
        throw new Error(`unknown with-dev option: ${argument}`)
    }
  }
  if (consumer.length === 0) throw new Error('with-dev requires --consumer')
  if (dependency.length === 0) throw new Error('with-dev requires --dependency')
  if (scope === undefined) throw new Error('with-dev requires --scope project|global')
  if (source.length === 0) throw new Error('with-dev requires --source')

  return { command, consumer, dependency, scope, source }
}

function parseStatusOptions(args: string[]): StatusOptions {
  if (args.length === 0) return {}
  if (args.length === 2 && args[0] === '--consumer') return { consumer: requireOptionValue(args, 1, '--consumer') }

  throw new Error('usage: apm-skill-dev.ts status [--consumer <absolute root>]')
}

function parseRecoverOptions(args: string[]): RecoverOptions {
  let consumer = ''
  let force = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    switch (argument) {
      case '--consumer':
        consumer = requireOptionValue(args, ++index, '--consumer')
        break
      case '--force':
        force = true
        break
      default:
        throw new Error(`unknown recover option: ${argument}`)
    }
  }
  if (consumer.length === 0) throw new Error('recover requires --consumer')

  return { consumer, force }
}

function splitCommand(args: string[]): { beforeCommand: string[]; command: string[] } {
  const separatorIndex = args.indexOf('--')
  if (separatorIndex === -1) return { beforeCommand: args, command: [] }

  return {
    beforeCommand: args.slice(0, separatorIndex),
    command: args.slice(separatorIndex + 1),
  }
}

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)

  return value
}

function parseTargets(value: string): Target[] {
  const values = unique(value.split(',').map((target) => target.trim()).filter(Boolean))
  if (values.length === 0) throw new Error('--target requires claude,codex')
  const unsupported = values.find((target) => target !== Target.Claude && target !== Target.Codex)
  if (unsupported !== undefined) throw new Error(`unsupported isolated target: ${unsupported}`)

  return values.map((target) => target === Target.Claude ? Target.Claude : Target.Codex)
}

function parseScope(value: string): Scope {
  switch (value) {
    case Scope.Global:
      return Scope.Global
    case Scope.Project:
      return Scope.Project
    default:
      throw new Error(`invalid scope: ${value}`)
  }
}

function validateProducerRoot(path: string): string {
  const root = validateAbsoluteDirectory(path, 'source')
  if (!existsSync(join(root, 'apm.yml'))) throw new Error(`source does not contain apm.yml: ${root}`)

  return root
}

function validateConsumerRoot(path: string): string {
  return validateAbsoluteDirectory(path, 'consumer')
}

function validateAbsoluteDirectory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} root must be absolute: ${path}`)
  if (!existsSync(path)) throw new Error(`${label} root does not exist: ${path}`)
  const root = realpathSync(path)
  if (!lstatSync(root).isDirectory()) throw new Error(`${label} root is not a directory: ${path}`)

  return root
}

function verifyIsolatedMaterialization(root: string, targets: Target[], skills: string[]): void {
  for (const target of targets) {
    const skillsRoot = target === Target.Claude ? join(root, '.claude', 'skills') : join(root, '.agents', 'skills')
    for (const skill of skills) {
      if (!existsSync(join(skillsRoot, skill))) {
        throw new Error(`requested skill was not materialized for ${target}: ${skill}`)
      }
    }
  }
  if (targets.includes(Target.Codex) && !targets.includes(Target.Claude) && existsSync(join(root, '.claude', 'skills'))) {
    throw new Error('unexpected Claude skills directory was materialized for codex-only install')
  }
}

function resolveConsumerPaths(scope: Scope, consumerRoot: string): { lockPath: string; manifestPath: string } {
  if (scope === Scope.Project) {
    return {
      lockPath: join(consumerRoot, 'apm.lock.yaml'),
      manifestPath: join(consumerRoot, 'apm.yml'),
    }
  }
  const home = requireEnvironmentPath('HOME')

  return {
    lockPath: join(home, '.apm', 'apm.lock.yaml'),
    manifestPath: join(home, '.apm', 'apm.yml'),
  }
}

function verifyGlobalPaths(manifestPath: string, lockPath: string): void {
  const dotfiles = requireEnvironmentPath('DOTFILES')
  const expectedRoot = join(dotfiles, 'modules', 'home', 'apm', 'config')
  const pairs = [
    [manifestPath, join(expectedRoot, 'apm.yml')],
    [lockPath, join(expectedRoot, 'apm.lock.yaml')],
  ]
  const invalid = pairs.find(([live, expected]) => {
    if (live === undefined || expected === undefined || !existsSync(live) || !existsSync(expected)) return true

    return realpathSync(live) !== realpathSync(expected)
  })
  if (invalid !== undefined) throw new Error('global APM manifest and lock must resolve to the dotfiles APM config')
}

function requireEnvironmentPath(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`)

  return value
}

function parseManifest(path: string): Record<string, unknown> {
  if (!existsSync(path)) throw new Error(`consumer manifest not found: ${path}`)
  const parsed: unknown = Bun.YAML.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`consumer manifest must be a YAML mapping: ${path}`)

  return parsed
}

function selectProductionDependency(manifest: Record<string, unknown>, selector: string): ManifestSelection {
  const dependencies = apmDependencies(manifest, 'dependencies')
  const pathMatches = dependencies.filter((entry) => {
    const path = entry.path

    return typeof path === 'string' && sourceMatches(path, selector)
  })
  if (pathMatches.length > 0) throw new Error(`path-only production dependency is not allowed: ${selector}`)
  const matchingIndexes = dependencies.flatMap((entry, index) => {
    const git = entry.git

    return typeof git === 'string' && sourceMatches(git, selector) ? [index] : []
  })
  if (matchingIndexes.length === 0) throw new Error(`dependency selector not found: ${selector}`)
  if (matchingIndexes.length !== 1) throw new Error(`ambiguous dependency selector: ${selector}`)
  const selectedIndex = matchingIndexes[0]
  const selected = selectedIndex === undefined ? undefined : dependencies[selectedIndex]
  if (selected === undefined || typeof selected.git !== 'string') throw new Error(`dependency selector not found: ${selector}`)
  if ('path' in selected) throw new Error(`production dependency cannot contain both git and path: ${selector}`)
  const packageName = sourceBasename(selected.git)
  const duplicate = apmDependencies(manifest, 'devDependencies', true).some((entry) => {
    const source = typeof entry.git === 'string' ? entry.git : entry.path

    return typeof source === 'string' && sourceBasename(source) === packageName
  })
  if (duplicate) throw new Error(`production package is also present in devDependencies.apm: ${packageName}`)

  return { manifest, selectedIndex }
}

function apmDependencies(manifest: Record<string, unknown>, key: string, optional = false): Array<Record<string, unknown>> {
  const section = manifest[key]
  if (section === undefined && optional) return []
  if (!isRecord(section)) throw new Error(`${key} must be a mapping`)
  const apm = section.apm
  if (apm === undefined && optional) return []
  if (!Array.isArray(apm)) throw new Error(`${key}.apm must be an array`)
  if (!apm.every(isRecord)) throw new Error(`${key}.apm entries must be mappings`)

  return apm
}

function sourceMatches(source: string, selector: string): boolean {
  return source === selector || sourceBasename(source) === stripGitSuffix(selector)
}

function sourceBasename(source: string): string {
  const normalized = source.replaceAll('\\', '/').replace(/\/+$/, '')
  const tail = normalized.includes(':') && !normalized.includes('://')
    ? normalized.slice(normalized.lastIndexOf(':') + 1)
    : normalized

  return stripGitSuffix(basename(tail))
}

function stripGitSuffix(value: string): string {
  return value.endsWith('.git') ? value.slice(0, -4) : value
}

function replaceDependency(selection: ManifestSelection, source: string): Record<string, unknown> {
  const dependenciesSection = selection.manifest.dependencies
  if (!isRecord(dependenciesSection)) throw new Error('dependencies must be a mapping')
  const dependencies = apmDependencies(selection.manifest, 'dependencies')
  const selected = dependencies[selection.selectedIndex]
  if (selected === undefined) throw new Error('selected dependency disappeared')
  const retained = Object.fromEntries(
    Object.entries(selected).filter(([key]) => key !== 'git' && key !== 'ref' && key !== 'path'),
  )
  const replaced = dependencies.map((entry, index) => index === selection.selectedIndex ? { path: source, ...retained } : entry)

  return {
    ...selection.manifest,
    dependencies: {
      ...dependenciesSection,
      apm: replaced,
    },
  }
}

function createTransaction(input: {
  consumerRoot: string
  lockPath: string
  manifestPath: string
  scope: Scope
  source: string
}): Transaction {
  const stateRoot = transactionStateRoot()
  mkdirSync(stateRoot, { recursive: true })
  const key = sha256(Buffer.from(input.manifestPath))
  const directory = join(stateRoot, key)
  try {
    mkdirSync(directory)
  } catch (error: unknown) {
    if (isErrorCode(error, 'EEXIST')) throw new Error(`consumer is already owned: ${input.consumerRoot}`)
    throw error
  }

  try {
    const manifest = writeSnapshot(directory, 'manifest.snapshot', input.manifestPath)
    const lock = writeSnapshot(directory, 'lock.snapshot', input.lockPath)
    const providerSurface = captureProviderSurface(input.scope, input.consumerRoot)
    const state: TransactionState = {
      consumerRoot: input.consumerRoot,
      lock,
      lockPath: input.lockPath,
      manifest,
      manifestPath: input.manifestPath,
      pid: process.pid,
      providerSurface,
      scope: input.scope,
      source: input.source,
      startedAt: new Date().toISOString(),
      version: 1,
    }
    writeFileSync(join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)

    return { directory, state }
  } catch (error: unknown) {
    rmSync(directory, { force: true, recursive: true })
    throw error
  }
}

function assertNotOwned(manifestPath: string, consumerRoot: string): void {
  const directory = join(transactionStateRoot(), sha256(Buffer.from(manifestPath)))
  if (existsSync(directory)) throw new Error(`consumer is already owned: ${consumerRoot}`)
}

function writeSnapshot(directory: string, name: string, path: string): Snapshot {
  if (!pathEntryExists(path)) {
    const bytes = Buffer.alloc(0)
    writeFileSync(join(directory, name), bytes)

    return { exists: false, hash: sha256(bytes), kind: 'missing' }
  }
  const stat = lstatSync(path)
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`transaction file is not regular or symbolic: ${path}`)
  const bytes = readFileSync(path)
  writeFileSync(join(directory, name), bytes)

  return stat.isSymbolicLink()
    ? { exists: true, hash: sha256(bytes), kind: 'symlink', linkTarget: readlinkSync(path) }
    : { exists: true, hash: sha256(bytes), kind: 'file' }
}

async function restoreTransaction(transaction: Transaction): Promise<number> {
  try {
    validateTransaction(transaction)
    restoreSnapshot(transaction.directory, 'manifest.snapshot', transaction.state.manifestPath, transaction.state.manifest)
    restoreSnapshot(transaction.directory, 'lock.snapshot', transaction.state.lockPath, transaction.state.lock)
  } catch (error: unknown) {
    console.error(`restore failed: ${errorMessage(error)}`)
    return 1
  }

  const frozenCode = await runInstall(transaction.state.scope, transaction.state.consumerRoot, true)
  if (frozenCode !== 0) {
    console.error(`frozen production materialization failed with exit code ${frozenCode}; recovery state retained`)
    return frozenCode
  }

  try {
    restoreProviderSurface(transaction.state)
    verifySnapshot(transaction.state.manifestPath, transaction.state.manifest)
    verifySnapshot(transaction.state.lockPath, transaction.state.lock)
    if (transaction.state.scope === Scope.Global) {
      verifyGlobalPaths(transaction.state.manifestPath, transaction.state.lockPath)
    }
    rmSync(transaction.directory, { recursive: true })
  } catch (error: unknown) {
    console.error(`restore verification failed: ${errorMessage(error)}`)
    return 1
  }

  return 0
}

function restoreSnapshot(directory: string, name: string, path: string, snapshot: Snapshot): void {
  if (!snapshot.exists) {
    if (pathEntryExists(path)) unlinkRegularOrSymlink(path)
    return
  }
  const bytes = readFileSync(join(directory, name))
  if (sha256(bytes) !== snapshot.hash) throw new Error(`snapshot hash mismatch: ${name}`)
  if (snapshot.kind === 'symlink') {
    if (snapshot.linkTarget === undefined) throw new Error(`symlink target missing from snapshot: ${path}`)
    const currentIsExpectedLink = pathEntryExists(path)
      && lstatSync(path).isSymbolicLink()
      && readlinkSync(path) === snapshot.linkTarget
    if (!currentIsExpectedLink) {
      if (pathEntryExists(path)) unlinkRegularOrSymlink(path)
      symlinkSync(snapshot.linkTarget, path)
    }
    writeFileSync(path, bytes)
    return
  }
  if (pathEntryExists(path) && lstatSync(path).isSymbolicLink()) unlinkSync(path)
  if (pathEntryExists(path) && !lstatSync(path).isFile()) throw new Error(`refusing to replace non-file path: ${path}`)
  writeFileSync(path, bytes)
}

function verifySnapshot(path: string, snapshot: Snapshot): void {
  if (!snapshot.exists) {
    if (pathEntryExists(path)) throw new Error(`expected restored path to be absent: ${path}`)
    return
  }
  if (!existsSync(path)) throw new Error(`restored path is missing: ${path}`)
  const stat = lstatSync(path)
  if (snapshot.kind === 'symlink') {
    if (!stat.isSymbolicLink() || readlinkSync(path) !== snapshot.linkTarget) {
      throw new Error(`restored symlink differs: ${path}`)
    }
  } else if (!stat.isFile()) {
    throw new Error(`restored path is not a file: ${path}`)
  }
  if (sha256(readFileSync(path)) !== snapshot.hash) throw new Error(`restored bytes differ: ${path}`)
}

function unlinkRegularOrSymlink(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`refusing to delete non-file path: ${path}`)
  unlinkSync(path)
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error: unknown) {
    if (isErrorCode(error, 'ENOENT')) return false
    throw error
  }
}

function captureProviderSurface(scope: Scope, consumerRoot: string): GeneratedRootInventory[] {
  return generatedRoots(scope, consumerRoot).map(({ base, path, root }) => {
    if (!pathEntryExists(path)) return { base, entries: [], existed: false, root }
    const stat = lstatSync(path)
    const entries = stat.isDirectory() && !stat.isSymbolicLink() ? inventoryDirectory(path) : []

    return { base, entries, existed: true, root }
  })
}

function generatedRoots(scope: Scope, consumerRoot: string): Array<{
  base: 'cache' | 'provider'
  path: string
  root: string
}> {
  const providerBase = scope === Scope.Project ? consumerRoot : requireEnvironmentPath('HOME')
  const providerRoots = providerGeneratedRoots.map((root) => ({
    base: 'provider' as const,
    path: join(providerBase, ...root.split('/')),
    root,
  }))
  const cacheRoots = cacheGeneratedRoots.map((root) => ({
    base: 'cache' as const,
    path: join(consumerRoot, ...root.split('/')),
    root,
  }))

  return [...providerRoots, ...cacheRoots]
}

function inventoryDirectory(root: string): string[] {
  const entries: string[] = []

  function visit(directory: string, prefix: string): void {
    const names = readdirSync(directory).sort()
    for (const name of names) {
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`
      const path = join(directory, name)
      entries.push(relativePath)
      const stat = lstatSync(path)
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path, relativePath)
    }
  }

  visit(root, '')

  return entries
}

function restoreProviderSurface(state: TransactionState): void {
  const rootsByKey = new Map(
    generatedRoots(state.scope, state.consumerRoot).map((root) => [`${root.base}:${root.root}`, root]),
  )
  for (const inventory of state.providerSurface) {
    const root = rootsByKey.get(`${inventory.base}:${inventory.root}`)
    if (root === undefined) throw new Error(`provider inventory contains an unexpected root: ${inventory.root}`)
    rootsByKey.delete(`${inventory.base}:${inventory.root}`)
    const baselineEntries = new Set(inventory.entries)
    const currentEntries = pathEntryExists(root.path)
      && lstatSync(root.path).isDirectory()
      && !lstatSync(root.path).isSymbolicLink()
      ? inventoryDirectory(root.path)
      : []
    const additions = currentEntries
      .filter((entry) => !baselineEntries.has(entry))
      .sort((left, right) => pathDepth(right) - pathDepth(left) || right.localeCompare(left))
    for (const entry of additions) removeGeneratedPath(join(root.path, ...entry.split('/')))
    if (!inventory.existed && pathEntryExists(root.path)) removeGeneratedPath(root.path)
  }
  if (rootsByKey.size > 0) throw new Error('provider inventory is missing generated roots')
}

function removeGeneratedPath(path: string): void {
  if (!pathEntryExists(path)) return
  const stat = lstatSync(path)
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmdirSync(path)
    return
  }
  unlinkSync(path)
}

function pathDepth(path: string): number {
  return path.split('/').length
}

function readTransactionEntries(): Array<{ directory: string; state?: TransactionState }> {
  const root = transactionStateRoot()
  if (!existsSync(root)) return []

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(root, entry.name)
      const statePath = join(directory, 'state.json')
      if (!existsSync(statePath)) return { directory }
      try {
        const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'))

        return { directory, state: parseTransactionState(parsed) }
      } catch {
        return { directory }
      }
    })
}

function parseTransactionState(value: unknown): TransactionState {
  if (!isRecord(value)) throw new Error('state must be an object')
  const { consumerRoot, lock, lockPath, manifest, manifestPath, pid, providerSurface, scope, source, startedAt, version } = value
  if (
    typeof consumerRoot !== 'string'
    || typeof lockPath !== 'string'
    || typeof manifestPath !== 'string'
    || typeof pid !== 'number'
    || !Array.isArray(providerSurface)
    || typeof source !== 'string'
    || typeof startedAt !== 'string'
    || version !== 1
  ) throw new Error('state fields are invalid')
  if (scope !== Scope.Project && scope !== Scope.Global) throw new Error('state scope is invalid')

  return {
    consumerRoot,
    lock: parseSnapshot(lock),
    lockPath,
    manifest: parseSnapshot(manifest),
    manifestPath,
    pid,
    providerSurface: providerSurface.map(parseGeneratedRootInventory),
    scope,
    source,
    startedAt,
    version,
  }
}

function parseGeneratedRootInventory(value: unknown): GeneratedRootInventory {
  if (!isRecord(value)) throw new Error('generated root inventory must be an object')
  const { base, entries, existed, root } = value
  if (base !== 'cache' && base !== 'provider') throw new Error('generated root inventory base is invalid')
  if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string' && isSafeInventoryPath(entry))) {
    throw new Error('generated root inventory entries are invalid')
  }
  if (typeof existed !== 'boolean' || typeof root !== 'string') {
    throw new Error('generated root inventory fields are invalid')
  }
  if (entries.length !== new Set(entries).size) throw new Error('generated root inventory contains duplicate entries')

  return { base, entries, existed, root }
}

function isSafeInventoryPath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path)) return false

  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) throw new Error('snapshot must be an object')
  const { exists, hash, kind, linkTarget } = value
  if (typeof exists !== 'boolean' || typeof hash !== 'string') throw new Error('snapshot fields are invalid')
  if (kind !== 'file' && kind !== 'missing' && kind !== 'symlink') throw new Error('snapshot kind is invalid')
  if (linkTarget !== undefined && typeof linkTarget !== 'string') throw new Error('snapshot link target is invalid')

  return { exists, hash, kind, linkTarget }
}

function transactionStateRoot(): string {
  const base = process.env.XDG_STATE_HOME ?? join(requireEnvironmentPath('HOME'), '.local', 'state')

  return join(base, 'apm-skill-dev')
}

async function runInstall(scope: Scope, consumerRoot: string, frozen: boolean): Promise<number> {
  if (scope === Scope.Project) {
    return runProcess(frozen ? ['apm', 'install', '--frozen'] : ['apm', 'install'], consumerRoot, !frozen)
  }

  return runProcess(
    frozen
      ? ['mise', 'run', 'dot:apm', '--', 'install', '-g', '--frozen']
      : ['mise', 'run', 'dot:apm', '--', 'install', '-g'],
    consumerRoot,
    !frozen,
  )
}

function validateTransaction(transaction: Transaction): void {
  const expectedDirectory = join(transactionStateRoot(), sha256(Buffer.from(transaction.state.manifestPath)))
  if (transaction.directory !== expectedDirectory) throw new Error('transaction directory does not match its manifest')
  const expectedPaths = resolveConsumerPaths(transaction.state.scope, transaction.state.consumerRoot)
  if (
    transaction.state.manifestPath !== expectedPaths.manifestPath
    || transaction.state.lockPath !== expectedPaths.lockPath
  ) throw new Error('transaction paths do not match its consumer')
  const expectedRootKeys = new Set(
    generatedRoots(transaction.state.scope, transaction.state.consumerRoot)
      .map(({ base, root }) => `${base}:${root}`),
  )
  const actualRootKeys = transaction.state.providerSurface.map(({ base, root }) => `${base}:${root}`)
  if (
    actualRootKeys.length !== expectedRootKeys.size
    || new Set(actualRootKeys).size !== expectedRootKeys.size
    || actualRootKeys.some((key) => !expectedRootKeys.has(key))
  ) throw new Error('provider inventory does not match generated roots')
}

async function runProcess(
  command: string[],
  cwd: string,
  canBeInterrupted: boolean,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (command.length === 0) return 0
  const child = Bun.spawn(command, {
    cwd,
    env,
    stderr: 'inherit',
    stdin: 'inherit',
    stdout: 'inherit',
  })
  activeProcess = child
  activeProcessCanBeInterrupted = canBeInterrupted
  if (receivedSignal && canBeInterrupted) child.kill(receivedSignal)

  try {
    return await child.exited
  } finally {
    if (activeProcess === child) {
      activeProcess = undefined
      activeProcessCanBeInterrupted = false
    }
  }
}

function isPidLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if (isErrorCode(error, 'ESRCH')) return false
    return true
  }
}

function signalExitCode(): number | undefined {
  switch (receivedSignal) {
    case 'SIGINT':
      return 130
    case 'SIGTERM':
      return 143
    default:
      return undefined
  }
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
