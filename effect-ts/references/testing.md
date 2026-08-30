# Testing Effect code

## Use `@effect/vitest` if available

`@effect/vitest` provides `it.effect` / `it.scoped` / `it.layer` that wrap test bodies in the Effect runtime with `TestClock` + `TestServices` pre-provided.

```ts
// DO
import { it } from '@effect/vitest'
import { Effect } from 'effect'

it.effect('finds user by id', () =>
  Effect.gen(function* () {
    const service = yield* UserService
    const user = yield* service.findById(testUserId)
    expect(user.name).toBe('Alice')
  }).pipe(Effect.provide(TestUserLayer)),
)
```

```ts
// DON'T — manual Promise unwrapping loses TestClock, test fiber scoping
import { it } from 'vitest'

it('finds user by id', async () => {
  const user = await Effect.runPromise(
    UserService.findById(testUserId).pipe(Effect.provide(TestUserLayer)),
  )
  expect(user.name).toBe('Alice')
})
```

If `@effect/vitest` isn't in the project, `bun:test` / vanilla `vitest` work — but always provide your `MainTest` layer once and `Effect.runPromise` once per test.

## Override `Config` via `ConfigProvider.fromMap`, never mock the service

The `Config` service reads from the current `ConfigProvider` (a FiberRef). Test code injects a map-backed provider — no service mocking, no `as unknown as Config` casts.

```ts
// DO
import { ConfigProvider, Layer } from 'effect'

const TestConfigProvider = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ['API_KEY', 'test-key'],
      ['PORT', '0'],
      ['LOG_LEVEL', 'debug'],
    ]),
  ),
)

const MainTest = Layer.mergeAll(
  Config.Default,           // real Config service
  UserService.Default,
  TestConfigProvider,       // overrides what Config reads from
  SilentLogger,
)
```

```ts
// DON'T — duplicates the service shape, drifts when Config gains fields
const TestConfig = Layer.succeed(Config, {
  getAnthropicKey: Effect.succeed('test-key'),
  getPort: Effect.succeed(0),
  // ...
} as unknown as Config)
```

```ts
// DON'T — mutating shared global state in tests
beforeEach(() => { process.env.API_KEY = 'test-key' })
afterEach(() => { delete process.env.API_KEY })
```

## Mock services with `Layer.succeed(Tag, Tag.make({...}))`

For `Effect.Service` classes, the class itself works as the constructor:

```ts
// DO
const TestUserServiceLive = Layer.succeed(
  UserService,
  UserService.make({
    findById: (id) => Effect.succeed({ id, name: 'Alice' }),
    create: (_data) => Effect.die('not implemented in this test'),
  }),
)
```

```ts
// DON'T
Layer.succeed(UserService, {} as UserService)              // type lies, runtime crashes
Layer.succeed(UserService, { findById } as any)             // same
```

## Always fork sleeps before `TestClock.adjust`

`TestClock` advances time deterministically — but a foreground `Effect.sleep` blocks the test fiber, so `adjust` never runs.

```ts
// DO
it.effect('emits after 10s', () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(Effect.sleep('10 seconds'))
    yield* TestClock.adjust('10 seconds')
    yield* Fiber.join(fiber)
    // assertions...
  }),
)
```

```ts
// DON'T — test fiber blocked, TestClock never advanced
it.effect('emits after 10s', () =>
  Effect.gen(function* () {
    yield* Effect.sleep('10 seconds')      // blocks
    yield* TestClock.adjust('10 seconds')  // unreachable
  }),
)
```

Same rule for any operation that waits internally: queues, deferreds, schedules, retries. Fork it, advance time, then join/assert.

## Assert typed errors via `Effect.either`

```ts
// DO
const result = yield* Effect.either(service.findById(unknownId))
assert(Either.isLeft(result))
expect(result.left._tag).toBe('UserNotFoundError')
expect(result.left.userId).toBe(unknownId)
```

```ts
// DON'T — vanilla try/catch on a runPromise result loses typed channel
try {
  await Effect.runPromise(service.findById(unknownId))
  fail('should have failed')
} catch (e) { /* untyped */ }
```

## Per-test fixtures, not shared state

Build fresh `Ref` / `Queue` / `PubSub` / mock services per test. Shared state leaks across tests, makes failures order-dependent.

```ts
// DO — fresh context per test
const makeTestCtx = Effect.gen(function* () {
  const ref = yield* Ref.make<State>(initialState)
  const queue = yield* Queue.unbounded<Event>()
  return { ref, queue, layer: Layer.mergeAll(
    Layer.succeed(StateTag, ref),
    Layer.succeed(QueueTag, queue),
  )}
})

it.effect('test A', () => Effect.gen(function* () {
  const ctx = yield* makeTestCtx
  // ...
}))
```

```ts
// DON'T — module-scope state, tests interfere
const sharedRef = Effect.runSync(Ref.make<State>(initialState))
// ...
```

## Suppress noisy logs in test layers

```ts
// DO — once, in the test layer
import { Logger, LogLevel } from 'effect'

export const SilentLogger = Logger.minimumLogLevel(LogLevel.None)

export function MainTest() {
  return Layer.mergeAll(
    /* services */,
    SilentLogger,
  )
}
```

Tests stay readable; if you need to assert on logs, swap in `Logger.replace(Logger.defaultLogger, captureLogger)` for that specific test.
