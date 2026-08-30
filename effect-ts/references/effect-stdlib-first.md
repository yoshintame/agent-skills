# Effect stdlib first — don't wrap what Effect already gives you

Default failure mode: Claude writes a Path A wrapper over `node:fs` / `Date` / `crypto` / `child_process` (or adds `date-fns` / `zod` / `lodash`) without checking that Effect core or `@effect/platform` already gives the same shape. **Run this catalog before writing any w*rapp*er or adding any dep.**

## Catalog — use these, don't reinvent

| Need                                                        | Use                                                                                  | Skip                                                               |
| -------------------------------------------------------------| --------------------------------------------------------------------------------------| --------------------------------------------------------------------|
| File I/O (read, write, stat, mkdir, watch)                  | `@effect/platform/FileSystem`                                                        | Path A wrapper over `node:fs` / `bun:fs`                           |
| Path manipulation (join, resolve, relative)                 | `@effect/platform/Path`                                                              | `node:path` wrapper                                                |
| HTTP client (request, retry, JSON, streaming)               | `@effect/platform/HttpClient`                                                        | `node:fetch` wrapper, axios, ky                                    |
| HTTP server                                                 | `@effect/platform/HttpServer` (or `@effect/platform-node`)                           | express, fastify in business code                                  |
| Spawn / exec subprocesses                                   | `@effect/platform/Command`                                                           | `node:child_process` / `Bun.spawn` wrapper                         |
| KV / blob storage abstraction                               | `@effect/platform/KeyValueStore`                                                     | custom interface over fs/redis                                     |
| Worker pool / off-thread                                    | `@effect/platform/Worker`                                                            | `node:worker_threads` wrapper                                      |
| Dates, time arithmetic, timezones                           | `Effect.DateTime` + `Effect.Duration`                                                | `Date.UTC()`, date-fns, dayjs, luxon                               |
| Wall-clock time (read current time)                         | `Effect.Clock.currentTimeMillis`                                                     | `Date.now()`                                                       |
| Wait / sleep                                                | `Effect.sleep('500 millis')`                                                         | `setTimeout(...)` promise wrappers                                 |
| Cron schedules                                              | `Effect.Cron`                                                                        | `node-cron`, `cron-parser`                                         |
| Random (seedable, testable)                                 | `Effect.Random`                                                                      | `Math.random()`, `crypto.randomUUID()` (for IDs use `Schema.UUID`) |
| Hashing / equality on data                                  | `Hash.hash`, `Equal.equals`, `Data.struct`, `Data.array`                             | manual deep-equal, JSON.stringify dedup                            |
| Hash collections                                            | `HashSet`, `HashMap`                                                                 | `Map`/`Set` of structural objects (compares by reference)          |
| Schema parsing / validation                                 | `effect/Schema` (or `@effect/schema`)                                                | zod, yup, joi, ajv                                                 |
| Pattern matching on ADTs                                    | `Match.discriminatorsExhaustive` / `Match.tagsExhaustive` / `Data.taggedEnum.$match` | hand-rolled `if (x.kind === ...)` chains                           |
| Option / Either / Result                                    | `Option`, `Either` (built-in)                                                        | `ts-results`, `neverthrow`, custom `Result<E, A>`                  |
| Concurrency primitives (queue, pubsub, deferred, semaphore) | `Queue`, `PubSub`, `Deferred`, `Effect.Semaphore`                                    | wrapper around `node:events` / custom mutex                        |
| Retry / repeat schedules                                    | `Effect.retry` + `Schedule.*`                                                        | custom `for (let i = 0; ...)`                                      |
| Cache (in-memory, TTL, request dedup)                       | `Cache.make`, `Cache.makeWith`                                                       | LRU libs, custom Map+TTL                                           |
| Logging                                                     | `Effect.log` / `Logger.*` (built-in)                                                 | pino, winston in services                                          |
| Tracing / spans                                             | `Effect.withSpan`, `Effect.fn(name)`                                                 | OpenTelemetry SDK directly                                         |
| Metrics                                                     | `Metric.counter` / `Metric.histogram`                                                | prom-client wrapper                                                |
| Config / env                                                | `Config.*` + `ConfigProvider`                                                        | `process.env`, `dotenv`, convict, env-var                          |
| Resource lifecycle                                          | `Effect.acquireRelease`, `Layer.scoped`, `Scope`                                     | `try/finally`, manual cleanup                                      |
| String / array combinators                                  | `Array.*`, `Chunk.*`, `String.*` modules in Effect                                   | lodash, ramda                                                      |
| Order / comparators                                         | `Order.*`                                                                            | manual `(a, b) => a.x - b.x`                                       |
| Brand types                                                 | `Schema.brand(...)` / `Brand.refined`                                                | manual `string & { __brand: 'X' }`                                 |

## Pre-check protocol

Before adding ANY external dependency or writing a Path A wrapper:

1. **Grep the catalog above** for the need. If listed — use Effect's version.
2. **Check `@effect/platform`** docs page if it's I/O or platform-shaped.
3. **Check `effect/<Module>`** if it's pure data / algorithmic.
4. **Only then** consider Path A wrapping or *an external dep.*

## *Anti*-patterns

```ts
// DON'T — wrapping node:fs by hand
import { readFile } from 'node:fs/promises'

export class Filesystem extends Effect.Service<Filesystem>()('Filesystem', {
  sync: () => ({
    readText: Effect.fn('Filesystem.readText')(function* (path: string) {
      return yield* Effect.tryPromise({
        try: () => readFile(path, 'utf8'),
        catch: (cause) => new FsError({ path, cause }),
      })
    }),
  }),
}) {}

// DO — use @effect/platform/FileSystem; it's already the wrapper, with typed errors and platform abstraction
import { FileSystem } from '@effect/platform'

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path)
  return text
})
```

```ts
// DON'T — manual UTC math
const startOfMonth = new Date(Date.UTC(year, month - 1, 1))
const daysInMonth = new Date(Date.UTC(year, month, 0)).getDate()
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

// DO — Effect.DateTime + Duration
import { DateTime, Duration } from 'effect'

const start = DateTime.makeZoned({ year, month, day: 1 }, { timeZone: 'UTC' })
const daysInMonth = DateTime.daysInMonth(start)
```

```ts
// DON'T — JSON.stringify dedup of structural objects
const uniq = Array.from(
  new Map(items.map((x) => [JSON.stringify(x, Object.keys(x).sort()), x])).values(),
)

// DO — Data.struct gives structural equality; HashSet dedups in O(n)
import { Data, HashSet } from 'effect'

const uniq = HashSet.fromIterable(items.map(Data.struct)).pipe(HashSet.toArray)
```

```ts
// DON'T — adding date-fns / dayjs for date diffs
import { differenceInDays } from 'date-fns'
const days = differenceInDays(end, start)

// DO — Effect.Duration on DateTime diff
import { DateTime, Duration } from 'effect'
const days = DateTime.distance(start, end).pipe(Duration.toDays)
```

## When external dep IS warranted

Effect doesn't cover everything. Legitimate external deps:

- **Binary-format SDKs** (image processing: sharp; PDF: pdf-lib; AV: ffmpeg-static)
- **Vendor SDKs** with no Effect equivalent (Stripe, AWS, OpenAI, YNAB, Anthropic) — wrap Path A then
- **Domain-specific algorithms** Effect doesn't ship (ML models, parsers for niche formats, geo libraries)

For these, Path A wrapping is correct. For everything in the catalog above, it's reinventing.
