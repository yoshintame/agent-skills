# Errors

## Always tagged, never bare

```ts
// DO — Data.TaggedError: internal domain errors
import { Data } from 'effect'

export class UserNotFoundError extends Data.TaggedError('UserNotFoundError')<{
  readonly userId: UserId
}> {}

export class PaymentDeclined extends Data.TaggedError('PaymentDeclined')<{
  readonly reason: string
  readonly cause?: unknown
}> {}

// DO — Schema.TaggedError: serializable errors for RPC / HttpApi
import { Schema } from 'effect'
import { HttpApiSchema } from '@effect/platform'

export class ApiUserNotFound extends Schema.TaggedError<ApiUserNotFound>()(
  'ApiUserNotFound',
  { userId: UserId, message: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}
```

```ts
// DON'T
throw new Error('User not found')
return Promise.reject('payment failed')
yield* Effect.fail('something broke')  // string in error channel
```

### Picking `Data` vs `Schema`

| Need | Use |
|---|---|
| Internal-only domain error, never crosses serialization boundary | `Data.TaggedError` |
| Returned to RPC client / serialized to HTTP response | `Schema.TaggedError` |
| Already-existing codebase uses one form | Match it — don't mix arbitrarily |

## Fail with `yield* new MyError(...)` for YieldableError

`Data.TaggedError` and `Schema.TaggedError` both produce `YieldableError`. Yield the instance directly — no need for `Effect.fail` wrapper.

```ts
// DO
if (!user) {
  return yield* new UserNotFoundError({ userId: id })
}
```

```ts
// DON'T
if (!user) {
  return yield* Effect.fail(new UserNotFoundError({ userId: id }))  // redundant
}

// DON'T — Effect Language Server flags this as `unnecessaryFailYieldableError`
```

## Never `throw` inside `Effect.gen`

Throws bypass Effect's error channel — `catchTag` won't see them, types lie, traces lose info.

```ts
// DO
yield* Effect.gen(function* () {
  const user = yield* repo.findById(id)
  if (!user.active) return yield* new UserInactiveError({ userId: id })
  return user
})
```

```ts
// DON'T
yield* Effect.gen(function* () {
  const user = yield* repo.findById(id)
  if (!user.active) throw new Error('inactive')  // falls through to defect channel
  return user
})
```

## Catch narrowly with `catchTag` / `catchTags`

```ts
// DO — preserve typed error channel
const safeFlow = riskyOperation.pipe(
  Effect.catchTags({
    DatabaseError: (err) => Effect.fail(new ServiceUnavailableError({ message: err.message })),
    ValidationError: (err) => Effect.fail(new BadRequestError({ issues: err.issues })),
  }),
  // RateLimitError, UnknownError still surface — caller can handle
)
```

```ts
// DON'T — collapses E to one generic error, loses caller's ability to handle by tag
const lossy = riskyOperation.pipe(
  Effect.catchAll(() => Effect.fail(new GenericError({ message: 'failed' }))),
)
```

`catchAll` is acceptable only at terminal boundaries (logging, telemetry top-level handlers) — never as the middle of a pipeline.

## Don't remap domain errors at boundary layers

Let each domain error carry its own status / serialization annotation. Don't translate `UserNotFoundError → NotFoundError` at the HTTP boundary.

```ts
// DO — domain error knows its HTTP status
export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  'UserNotFoundError',
  { userId: UserId, message: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}
// HTTP layer just lets it through; @effect/platform serializes it
```

```ts
// DON'T — boundary translation kills error specificity
const handler = userService.findById(id).pipe(
  Effect.catchTag('UserNotFoundError', () => Effect.fail(new NotFoundError({ message: 'Not found' }))),
)
// Client now sees generic 404 instead of `_tag: 'UserNotFoundError'`
```

### Exception: CLI / TTY output

CLI is the one boundary where you **must** remap — exit codes don't live on the error and the user sees plain text. Centralize in `internal/error-mapping.ts` so adding a new tag becomes a compile error in one file, not a scattered `catchTags` block in `main.ts`.

```ts
export const reportOf = (e: CliError): { exitCode: number; message: string } =>
  Match.value(e).pipe(Match.tagsExhaustive({
    ConfigLoadError: (e) => ({ exitCode: 2, message: `… ${e.path}` }),
    FsError:         (e) => ({ exitCode: 4, message: `cannot ${e.op} ${e.path}` }),
  }))
```

## Inspect `Cause` at the terminal boundary

Errors flowing into the failure channel are typed. But at the very top (telemetry, fatal handlers) you also want defects (unexpected throws) and interruption.

```ts
// DO
program.pipe(
  Effect.catchAllCause((cause) => {
    if (Cause.isInterruptedOnly(cause)) return Effect.void
    const failures = Cause.failures(cause)
    const defects = Cause.defects(cause)
    return Effect.logError('fatal', { failures: Array.from(failures), defects: Array.from(defects) })
  }),
)
```

```ts
// DON'T
program.pipe(
  Effect.catchAll((err) => Effect.logError(`failed: ${err}`)),
  // Misses defects entirely; interruption logged as error
)
```

## Map Promise/throw to typed errors

```ts
// DO
const fetchUser = Effect.tryPromise({
  try: () => fetch('/api/user').then((r) => r.json()),
  catch: (cause) => new FetchError({ cause }),
})

const parseConfig = Effect.try({
  try: () => JSON.parse(rawConfig),
  catch: (cause) => new ConfigParseError({ cause }),
})
```

```ts
// DON'T
const fetchUser = Effect.gen(function* () {
  try {
    const r = yield* Effect.promise(() => fetch('/api/user'))  // Effect.promise eats errors
    return yield* Effect.promise(() => r.json())
  } catch (e) {
    throw new Error('fetch failed')  // not in error channel
  }
})
```

## Use `Effect.either` to assert errors in tests

```ts
// DO
const result = yield* Effect.either(service.findById(badId))
assert(Either.isLeft(result))
expect(result.left._tag).toBe('UserNotFoundError')
expect(result.left.userId).toBe(badId)
```

```ts
// DON'T
let caught: unknown
try {
  yield* service.findById(badId)
} catch (e) { caught = e }
expect(caught).toBeInstanceOf(UserNotFoundError)  // bypasses Effect's error channel
```
