# Config, logging, observability

## `Config.*` for env, never `process.env`

```ts
// DO
import { Config, ConfigProvider, Effect, Redacted } from 'effect'

const config = Config.all({
  port: Config.integer('PORT').pipe(Config.withDefault(3000)),
  apiKey: Config.redacted('API_KEY'),
  debug: Config.boolean('DEBUG').pipe(Config.withDefault(false)),
  logLevel: Config.literal('debug', 'info', 'warn', 'error')('LOG_LEVEL').pipe(
    Config.withDefault('info' as const),
  ),
})

const program = Effect.gen(function* () {
  const { port, apiKey, logLevel } = yield* config
  const rawKey = Redacted.value(apiKey)  // unwrap only at use-site
  // ...
})
```

```ts
// DON'T
const port = parseInt(process.env.PORT || '3000')           // no validation
const apiKey = process.env.API_KEY                            // can leak via logs
const logLevel = process.env.LOG_LEVEL === 'debug' ? ... : ... // ad-hoc enum
```

### Why `Config.redacted` for secrets

`Redacted<T>` blocks accidental logging — `JSON.stringify`, `Effect.logError`, `Cause` formatters all show `<redacted>`. Unwrap with `Redacted.value` only at the call site that needs the raw value.

### Composing lazily vs eagerly

`Config.all({...})` resolves all fields when yielded. If one field is only needed conditionally, store the `Config` descriptor and yield it on demand:

```ts
// DO — anthropic key only resolved when anthropic provider is selected
sync: () => ({
  getProvider: Config.literal('anthropic', 'claude-code')('AI_PROVIDER').pipe(
    Config.withDefault('claude-code' as const),
  ),
  getAnthropicKey: Config.redacted('ANTHROPIC_API_KEY').pipe(Effect.map(Redacted.value)),
  hasAnthropicKey: Config.option(Config.redacted('ANTHROPIC_API_KEY')).pipe(
    Effect.map(Option.isSome),
  ),
})
```

## `Effect.log` + `annotateLogs`, not `console.log`

```ts
// DO — structured data in annotations, log message is a plain literal
yield* Effect.log('order.received').pipe(
  Effect.annotateLogs({ orderId, userId, amount }),
)

yield* Effect.logError('payment.failed').pipe(
  Effect.annotateLogs({ orderId, reason }),
)
```

```ts
// DON'T
console.log('Order received:', orderId, 'for user', userId)        // unstructured
console.error('Payment failed:', error)                              // bypasses Effect logger
yield* Effect.log(`order ${orderId} received for user ${userId}`)   // interpolated, hard to index
```

### Log levels

| Method | When |
|---|---|
| `Effect.logDebug` | Verbose dev info |
| `Effect.log` | Normal operations |
| `Effect.logInfo` | Same as `Effect.log` |
| `Effect.logWarning` | Recoverable problems |
| `Effect.logError` | Failures requiring attention |
| `Effect.logFatal` | About to crash |

Configure via `Logger.minimumLogLevel(LogLevel.X)` in your `MainLive` / `MainTest` layer.

### Suppress logs in tests

```ts
// DO
import { Layer, Logger, LogLevel } from 'effect'

export const SilentLogger = Logger.minimumLogLevel(LogLevel.None)

export function MainTest() {
  return Layer.mergeAll(/* services */, SilentLogger)
}
```

## `Effect.withSpan` for external I/O

Spans wrap external calls (HTTP, subprocess, DB, LSP) so traces show timing + attributes.

```ts
// DO — span name is a static verb.target; dynamic data goes in attributes
yield* httpClient.get(url).pipe(
  Effect.withSpan('http.fetch', { attributes: { url, method: 'GET' } }),
)

yield* lspClient.executeCommand(cmd).pipe(
  Effect.withSpan('lsp.executeCommand', { attributes: { command: cmd.command } }),
)
```

```ts
// DON'T — dynamic data in span name explodes the metric cardinality
yield* httpClient.get(url).pipe(
  Effect.withSpan(`http.fetch.${url}`),
)
```

## `Effect.fn('Service.method')` for traced methods

`Effect.fn` adds a span name + stack capture automatically. Use for **entry-point service methods**, not for tight inner loops.

```ts
// DO
return {
  createUser: Effect.fn('UserService.createUser')(function* (data: CreateUserInput) {
    const user = yield* repo.create(data)
    yield* Effect.log('user.created').pipe(Effect.annotateLogs({ userId: user.id }))
    return user
  }),
}
```

```ts
// DO — per-element stream handler skips the per-call span overhead
const handler = Effect.fnUntraced(function* (event: Event) {
  yield* process(event)
})
stream.pipe(Stream.mapEffect(handler))
```

```ts
// DON'T — anonymous generator, no trace name, harder to find in telemetry
return {
  createUser: (data: CreateUserInput) => Effect.gen(function* () { /* ... */ }),
}
```

## Annotate spans/logs with business values, not progress steps

```ts
// DO — IDs, amounts, durations
yield* Effect.annotateCurrentSpan('orderId', orderId)
yield* Effect.annotateCurrentSpan('amountCents', amount)
```

```ts
// DON'T — step-by-step narration belongs in code, not telemetry
yield* Effect.annotateCurrentSpan('step', 'validating')
yield* Effect.annotateCurrentSpan('step', 'calling-payment-gateway')
yield* Effect.annotateCurrentSpan('step', 'updating-db')
```

## Naming convention for exported Effect-returning functions

```ts
// DO
export const logGetCommand = Effect.fn(...)        // command verb
export const activation = Effect.fn(...)           // lifecycle moment
export const refreshTokens = Effect.fn(...)        // domain action
```

```ts
// DON'T — `Effect` suffix is redundant (TS type + Effect.fn already convey it)
export const logGetEffect = Effect.fn(...)
export const activateEffect = Effect.fn(...)
```
