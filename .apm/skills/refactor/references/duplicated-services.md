# Duplicated services / registries

When two or more services share ~90% of their pipeline (read files → parse → dedupe by key → expose shape), extract a generic builder + leave thin shells.

## Smell signal

Lay the bodies of the candidates side-by-side. If only **(a) the parser**, **(b) the key extractor**, **(c) the duplicate-error factory**, and **(d) the deps** differ — they're duplicates.

Example (before — two ~60-line services with the same pipeline):

```ts
// FieldRegistry — walk + filter .field + read + parse + dedupe + shape
// TypeRegistry  — walk + filter .type  + read + parse + dedupe + shape
// VaultIndex    — walk + filter .md    + read + parse + 2-key  + shape   // outlier
```

## Refactor

### Step 1 — Extract the shared pipeline as a generic helper

```ts
// loader/build-registry.ts
export interface BuildRegistryInput<T, E, D> {
  readonly paths: readonly string[]
  readonly parse: (path: string, content: string) => Effect.Effect<T, E>
  readonly keyOf: (item: T) => string
  readonly fileOf: (item: T) => string
  readonly onDuplicate: (name: string, files: readonly string[]) => D
}

export function buildRegistry<T, E, D>(
  input: BuildRegistryInput<T, E, D>,
): Effect.Effect<ReadonlyMap<string, T>, E | D | VaultFSError, VaultFS> {
  return Effect.gen(function* () {
    const vault = yield* VaultFS
    const items = yield* Effect.forEach(input.paths, (path) =>
      Effect.gen(function* () {
        const content = yield* vault.readFile(path)
        return yield* input.parse(path, content)
      }), { concurrency: 'unbounded' })

    const byName = new Map<string, T>()
    const duplicates = new Map<string, string[]>()
    for (const item of items) {
      const name = input.keyOf(item)
      const existing = byName.get(name)
      if (existing === undefined) { byName.set(name, item); continue }
      const group = duplicates.get(name) ?? [input.fileOf(existing)]
      group.push(input.fileOf(item))
      duplicates.set(name, group)
    }
    const first = [...duplicates.entries()][0]
    if (first !== undefined) return yield* Effect.fail(input.onDuplicate(first[0], first[1]))
    return byName
  })
}
```

### Step 2 — Rewrite each service as a thin shell

```ts
class FieldRegistry extends Effect.Service<FieldRegistry>()('FieldRegistry', {
  accessors: true,
  dependencies: [YamlService.Default, VaultManifest.Default],
  effect: Effect.gen(function* () {
    const yaml = yield* YamlService
    const manifest = yield* VaultManifest
    const byName = yield* buildRegistry({
      paths: manifest.fields,
      parse: (path, content) => parseFieldFile({ path, content, yaml }),
      keyOf: (f) => f.name,
      fileOf: (f) => f.source._tag === 'FieldFile' ? f.source.file : '',
      onDuplicate: (name, files) => new DuplicateFieldName({ name, files }),
    })
    return {
      get: (name) => Option.fromNullable(byName.get(name)),
      list: () => [...byName.keys()].toSorted(),
      all: () => [...byName.values()],
    } satisfies FieldRegistryShape
  }),
}) {}
```

Public API of the service unchanged → tests don't move.

## When the outlier doesn't fit — don't force it

If one of the candidates has structural differences (extra keys, no duplicate-fail, additional methods), **don't** force it into the generic helper with 3-4 opt-out flags. Either:

- (a) leave the outlier alone, share only the upstream prerequisite (e.g. the path list via a separate `Manifest` service — see [repeated-io.md](repeated-io.md))
- (b) extract a **second** narrower helper that the outlier uses

Example: a `VaultIndex` with two-key map + folder-note convention shouldn't go through `buildRegistry({allowDuplicates: true, keyOf: (e) => [path, basename]})`. Leave its body as-is, share only the path-source.

## Wiring nuance

When the new helper requires a service (e.g. `VaultFS`), it must appear in the type signature's requirement param `R`. Caller sites that already provide that service satisfy it transitively — no extra wiring in `Layer.mergeAll`.

When the new dep is itself a service (e.g. a `Manifest`), add it to each consumer's `dependencies: [..., Manifest.Default]`. `Effect.Service` dedupes by tag → one instance per scope, even if listed N times.

## Lift to module scope or keep as closure?

When a helper appears inside a service `effect:` body, decide by what it captures:

| Captured | Lift? | Why |
|---|---|---|
| Services (`Effect.Service` / `Context.Tag` instances) | **Yes** — module-level | `R`-channel of the returned `Effect.Effect<A, E, R>` carries the dep contract; the function becomes self-contained, transitively resolved by caller's context. |
| Runtime-built structures (`Map`, `Ref`, local counters), one consumer, small logic | **No** — keep as inner function | Lifting requires either an extra param + wrapper-lambda in the shape, or a curry indirection. Same LOC, worse readability, no new callsite. |
| Runtime-built structures, ≥2 consumers OR non-trivial pure logic worth testing in isolation | **Yes** — module-level with explicit param | The boilerplate of the param + wrapper is worth it for testability / reuse. |

Example (lift wins): a `readEntry(path)` helper that yields `VaultFS` and `YamlService` and returns `Effect<Entry, E, VaultFS | YamlService>`. The signature documents the contract; tests can `Effect.provide` mocks.

Example (closure wins): a `mainFileOf(dir)` helper that reads a `Map<string, Entry>` built earlier in the same `effect:` body. Lifting it module-level would require `mainFileOf(byPath, dir)` + a wrapper `(dir) => mainFileOf(byPath, dir)` in the shape — pure boilerplate.

## Cost / benefit

- Two consumers, ~50 LOC each, 90% identical → **always worth extracting** (saves ~50 LOC, single point of truth for the dedupe logic, easier to evolve — e.g. switch from fail-fast to accumulate-all in one place).
- Two consumers but only 60% identical → **case-by-case.** If the differences fit cleanly behind 1-2 callback params, extract. If you'd need 4+ flags, leave.
- Single consumer → don't extract speculatively. Wait for the second.
