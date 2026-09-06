---
name: effect-ts
description: "Idiomatic Effect.ts 3.x conventions. Use when writing or reviewing code in a project depending on the `effect` package — Effect.Service definitions, error handling, Layer composition, Config, logging, Schema, testing with @effect/vitest. Encodes only the gap between Claude's defaults and idiomatic Effect — does not reteach Effect basics."
---

# Effect.ts 3.x conventions

This skill encodes **only the gap** between Claude's default code generation and idiomatic Effect 3.x usage. Effect API knowledge is assumed — this file lists what Claude predictably forgets to apply.

## How to use

1. **Read this file fully** before generating Effect code.
2. **Read the relevant reference** when working in that area:
   - Defining/composing services → [references/services-and-layers.md](references/services-and-layers.md)
   - Declaring or handling errors → [references/errors.md](references/errors.md)
   - Reading env / logging / spans → [references/config-and-logging.md](references/config-and-logging.md)
   - Writing tests → [references/testing.md](references/testing.md)
   - Forking, retries, resource lifecycle → [references/concurrency-and-resources.md](references/concurrency-and-resources.md)
   - Schema / branded types / parsing boundaries → [references/schema-and-boundaries.md](references/schema-and-boundaries.md)
   - Discriminated unions / ADTs / `Match` → [references/pattern-matching.md](references/pattern-matching.md)
   - **Before adding any dep or writing a Path A wrapper** → [references/effect-stdlib-first.md](references/effect-stdlib-first.md)
3. **Run Effect Language Server diagnostics** on edited files: `bunx effect-language-service diagnostics --file <path>` (or `--project tsconfig.json`). Fixes diagnostics like `unnecessaryFailYieldableError`.

## Critical rules (DO / DON'T)

| Area | DO | DON'T |
|---|---|---|
| **Config** | `yield* Config.string('KEY').pipe(Config.withDefault('x'))` | `process.env.KEY ?? 'x'` |
| **Secrets** | `Config.redacted('KEY')` + `Redacted.value` at use-site | `Config.string('KEY')` for tokens / API keys |
| **Logging** | `Effect.log('event').pipe(Effect.annotateLogs({ id }))` | `console.log` / `Effect.log(\`event ${id}\`)` |
| **Errors** | `Data.TaggedError('Tag')<{...}>` + `yield* new MyError({...})` | `throw new Error(...)` / `Effect.fail(throw ...)` |
| **Catching** | `Effect.catchTag('Tag', fn)` / `Effect.catchTags({...})` | `Effect.catchAll` / `Effect.mapError` to generic |
| **Services** | `class S extends Effect.Service<S>()('S', { dependencies: [...], effect })` | `Context.Tag` for business logic |
| **Service methods** | `Effect.fn('S.method')(function* (...) {...})` | Anonymous `(...) => Effect.gen(...)` |
| **Promises** | `Effect.tryPromise({ try, catch: e => new MyError({ cause: e }) })` | Raw `await` in service body / `async` in service signature |
| **Sync throw** | `Effect.try({ try, catch: e => new MyError({ cause: e }) })` | bare `try/catch` |
| **Unknown data** | `Schema.decodeUnknown(MySchema)(raw)` | `raw as MyType` / `as unknown as T` |
| **Nullability** | `Option<T>` in domain; `Option.fromNullable` at boundary | `T \| null` / `T \| undefined` in domain types |
| **Option access** | `Option.match(o, { onNone, onSome })` | `Option.getOrThrow(o)` |
| **Concurrency** | `Effect.forEach(xs, fn, { concurrency: N })` | `Promise.all(xs.map(fn))` |
| **Background fibers** | `yield* Effect.forkScoped(stream.pipe(Stream.runDrain))` | `Stream.runDrain` without `forkScoped`; module-scope `Effect.runFork` |
| **Top-level run** | `Effect.runPromise` only at app entry / boundary helper | `Effect.runSync`/`runPromise` inside any service body |
| **Resources** | `Effect.acquireRelease(acquire, release)` or `Layer.scoped` | `try/finally` for cleanup |
| **Retry** | `Schedule.exponential('100 millis').pipe(Schedule.jittered, Schedule.intersect(Schedule.recurs(3)))` | `for (let i = 0; i < 3; i++)` |
| **State in service** | `Ref.make(...)` inside service `effect:` body | `const ref = await Ref.make(...)` at module scope |
| **Ref update** | `Ref.modify(ref, old => [result, next])` (atomic) | `Ref.get` → compute → `Ref.set` (race) |
| **Branded IDs** | `Schema.UUID.pipe(Schema.brand('@app/UserId'))` | `type UserId = string` |
| **Stdlib first** | `@effect/platform` (FileSystem, Path, HttpClient, Command), `Effect.DateTime`/`Duration`/`Clock`, `Schema`, `Match`, `Data.taggedEnum`, `Equal`/`HashSet`/`HashMap` | Path A wrapper over `node:fs` / manual `Date.UTC` math / `JSON.stringify` dedup / adding `date-fns` / `zod` / `lodash` |
| **Strict format** | `Schema.decodeUnknown(IsoDate)(s)` or round-trip `format(parse(s)) === s` | regex `^\d{4}-\d{2}-\d{2}$` (passes `2026-02-30`) |
| **Structural eq** | `Data.struct({...})` + `Equal.equals` / `HashSet.fromIterable(items.map(Data.struct))` | `JSON.stringify` dedup, hand-rolled deep-equal in `.some()` |
| **ADT / tag dispatch** | `Match.discriminatorsExhaustive('kind')({...})` / `Data.taggedEnum` + `$match` | `switch (x.kind)` / `if (x.kind === 'a') … else if …` |
| **Value-sets** | string `enum` + `Schema.Enums(E)` decode; `` `${E}` `` to bridge a string surface | `Schema.Literal('a','b')` for a value used *as a value* |
| **Span attrs** | `Effect.withSpan('verb.target', { attributes: { id } })` | Interpolating dynamic data into span name |
| **Tests** | `it.effect('...', Effect.fn(function* () {...}))` from `@effect/vitest` | `await Effect.runPromise(...)` inside vanilla `it` |
| **Test config** | `Layer.setConfigProvider(ConfigProvider.fromMap(new Map([...])))` | Mutating `process.env` / mocking the `Config` service |
| **Test sleeps** | `yield* Effect.fork(sleepEffect); yield* TestClock.adjust('1 sec')` | `yield* sleepEffect; yield* TestClock.adjust(...)` (deadlocks) |

## Anti-patterns (forbidden)

- **Path A wrapper over `node:fs` / `node:path` / `node:child_process` / `Date` / `crypto`** — `@effect/platform` and Effect core already provide these. See [references/effect-stdlib-first.md](references/effect-stdlib-first.md) before writing any wrapper.
- **`throw` inside `Effect.gen`** — bypasses error channel, can't be caught with `catchTag`. Always `yield* new MyError({...})`.
- **`Effect.runSync` / `runPromise` inside a service** — breaks composition. Services return Effects; only the boundary runs them.
- **`async`/`await` in a service method signature** — loses error channel, tracing, interruption. Wrap with `Effect.tryPromise`.
- **`as` casts for external data** — `Schema.decodeUnknown` parses at the boundary; downstream code stays typed.
- **`null`/`undefined` in domain types** — `Option<T>`. Convert at boundary with `Option.fromNullable`.
- **`Option.getOrThrow`** — always pattern-match or provide default.
- **`catchAll` to a generic error** — collapses the typed error channel. Use `catchTag`/`catchTags` and let unhandled tags surface.
- **`Layer.provide` chains scattered at usage sites** — declare in `dependencies: [Dep.Default]` once, in the service.
- **Module-scope `Effect.runFork` / `Ref.make` / `Queue.unbounded`** — ties resource lifetime to module load. Build inside a layer's `effect:` body.

## Heuristic for adding to this skill

> If Claude would already do this by default without the rule, **don't write the rule**. Skill is the diff between default behavior and required behavior. Library theory belongs in the library docs, not here.
