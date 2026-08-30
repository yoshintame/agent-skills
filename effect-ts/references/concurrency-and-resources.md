# Concurrency, retries, resource safety

## `Effect.forEach` with `concurrency`, not `Promise.all`

```ts
// DO — bounded parallelism, errors short-circuit by default, results in order
const results = yield* Effect.forEach(
  users,
  (user) => processUser(user),
  { concurrency: 5 },
)

// Unbounded (use sparingly):
yield* Effect.forEach(events, sendWebhook, { concurrency: 'unbounded' })

// Discard results when you only care about side effects:
yield* Effect.forEach(events, sendWebhook, { concurrency: 5, discard: true })
```

```ts
// DON'T
const results = yield* Effect.tryPromise({
  try: () => Promise.all(users.map((u) => processUserPromise(u))),
  catch: (e) => new BatchError({ cause: e }),
})
// No interruption propagation, no Effect tracing, can't tune concurrency
```

## Background fibers with `forkScoped`, not bare `runFork`

```ts
// DO — fiber lifetime = enclosing scope; cleaned up on Layer release
export class EventConsumer extends Effect.Service<EventConsumer>()('EventConsumer', {
  scoped: Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Event>()
    yield* Effect.forkScoped(
      queue.pipe(
        Queue.take,
        Effect.flatMap(processEvent),
        Effect.forever,
      ),
    )
    return { offer: (e: Event) => Queue.offer(queue, e) }
  }),
}) {}
```

```ts
// DON'T — fiber outlives scope, can't be interrupted on Layer release
const fiber = Effect.runFork(consumeForever)
// Now what? Cleanup is your problem.
```

### Run `Stream.runDrain` inside `forkScoped`, not before

```ts
// DO
yield* Effect.forkScoped(
  stream.pipe(Stream.mapEffect(handler), Stream.runDrain),
)
```

```ts
// DON'T — `runDrain` runs immediately, blocks the calling fiber, fork is moot
const drained = stream.pipe(Stream.mapEffect(handler), Stream.runDrain)
yield* Effect.forkScoped(drained)  // by here, drained already started in this fiber
```

## Resources: `Effect.acquireRelease` / `Layer.scoped`

```ts
// DO — acquire is uninterruptible; release runs even on interruption/failure
const openConn = Effect.acquireRelease(
  Effect.tryPromise({ try: () => db.connect(), catch: (e) => new DbConnectError({ cause: e }) }),
  (conn) => Effect.promise(() => conn.close()),
)

const program = Effect.gen(function* () {
  const conn = yield* openConn  // released when this scope closes
  return yield* query(conn, sql)
})
```

```ts
// DO — service owns a resource
export class DbPool extends Effect.Service<DbPool>()('DbPool', {
  scoped: Effect.gen(function* () {
    const pool = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => createPool(config), catch: ... }),
      (p) => Effect.promise(() => p.drain()),
    )
    return { withConn: (fn) => Effect.acquireUseRelease(/* ... */) }
  }),
}) {}
```

```ts
// DON'T — try/finally doesn't compose, interruption skips finally
try {
  const conn = await db.connect()
  const result = await query(conn, sql)
  return result
} finally {
  await conn.close()
}
```

## Retry with `Schedule` combinators

```ts
// DO
import { Schedule, Duration } from 'effect'

const retryPolicy = Schedule.exponential('100 millis').pipe(
  Schedule.jittered,                              // ±50% jitter
  Schedule.intersect(Schedule.recurs(3)),          // cap at 3 retries
  Schedule.intersect(Schedule.elapsed(Duration.seconds(30))), // and 30s total
)

yield* httpRequest.pipe(Effect.retry(retryPolicy))
```

```ts
// DON'T
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    return yield* httpRequest
  } catch (e) {
    yield* Effect.sleep(`${100 * 2 ** attempt} millis`)
  }
}
// No jitter, no total-time bound, no Effect interruption, manual error rethrow
```

### Retry only on specific errors

```ts
// DO
yield* httpRequest.pipe(
  Effect.retry({
    schedule: Schedule.exponential('100 millis').pipe(Schedule.intersect(Schedule.recurs(3))),
    while: (err) => err._tag === 'RateLimitError' || err._tag === 'NetworkError',
  }),
)
```

## `Ref.modify` for atomic read-derive-write

```ts
// DO — single atomic op
const [oldValue, newValue] = yield* Ref.modify(ref, (current) => {
  const updated = derive(current)
  return [current, updated]  // [return value, new state]
})

// Just update with no return:
yield* Ref.update(ref, (current) => derive(current))
```

```ts
// DON'T — race: another fiber can modify between get and set
const current = yield* Ref.get(ref)
const updated = derive(current)
yield* Ref.set(ref, updated)
```

## `SynchronizedRef.modifyEffect` when the update is effectful

```ts
// DO — built-in semaphore serializes concurrent updates
yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
  Effect.gen(function* () {
    const enriched = yield* fetchExtra(state.id)
    return [enriched, { ...state, extra: enriched }] as const
  }),
)
```

```ts
// DON'T — no serialization, concurrent fibers race on the slow lookup
const state = yield* Ref.get(stateRef)
const enriched = yield* fetchExtra(state.id)
yield* Ref.set(stateRef, { ...state, extra: enriched })
```

## `Deferred` for one-shot synchronization

```ts
// DO — one fiber resolves, many fibers `await`
const ready = yield* Deferred.make<void, never>()

// Producer:
yield* Effect.forkScoped(
  longSetup.pipe(Effect.tap(() => Deferred.succeed(ready, void 0))),
)

// Consumers:
yield* Deferred.await(ready)
```

`Deferred` is value-set-exactly-once. For repeated updates use `Ref` / `SubscriptionRef`.

## `SubscriptionRef.changes` is the source-of-truth stream

`SubscriptionRef` already gives you a `changes: Stream` that emits the current value + every subsequent change. Don't prepend `Ref.get` + concat.

```ts
// DO
ref.changes.pipe(Stream.changes, Stream.runDrain)
```

```ts
// DON'T
Stream.concat(
  Stream.fromEffect(SubscriptionRef.get(ref)),
  ref.changes,
).pipe(Stream.changes, Stream.runDrain)
// changes already emits the snapshot first
```

Apply `Stream.changes` (no-op dedup) at the **producer** so identity updates don't propagate.
