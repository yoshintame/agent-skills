# Services & Layers

## Use `Effect.Service`, not bare `Context.Tag`

`Effect.Service` bundles tag + Layer + accessors + dependency declaration in one class. `Context.Tag` is acceptable only for **runtime-injected infrastructure** (e.g. `vscode.ExtensionContext`, Cloudflare worker bindings, externally-provided handles).

```ts
// DO
export class UserService extends Effect.Service<UserService>()('UserService', {
  accessors: true,
  dependencies: [UserRepo.Default, Cache.Default],
  effect: Effect.gen(function* () {
    const repo = yield* UserRepo
    const cache = yield* Cache

    const findById = Effect.fn('UserService.findById')(function* (id: UserId) {
      const cached = yield* cache.get(id)
      if (Option.isSome(cached)) return cached.value
      const user = yield* repo.findById(id)
      yield* cache.set(id, user)
      return user
    })

    return { findById }
  }),
}) {}

// At app entry:
const MainLive = Layer.mergeAll(UserService.Default, OtherService.Default)
```

```ts
// DON'T (for business logic)
export const UserService = Context.GenericTag<{ findById: (id: UserId) => Effect.Effect<User, UserNotFoundError> }>('UserService')
// Now you maintain the Layer separately, no Default, no auto-accessors, dependencies wire by hand.
```

## Pick the constructor by build behavior

| Constructor | When |
|---|---|
| `sync: () => Shape` | Pure synchronous construction, no I/O, no env reads |
| `effect: Effect.Effect<Shape, E, R>` | Build needs other services or one-time I/O, no cleanup |
| `scoped: Effect.Effect<Shape, E, R \| Scope>` | Service owns a resource needing release (sockets, subscriptions, background fibers) |

If you reach for `sync:` but the body calls `process.env` / `fs.readFileSync` / spawns work — switch to `effect:` so the build runs lazily inside the Effect runtime, with proper error channel.

## Declare dependencies in the service, not at call sites

```ts
// DO — wiring lives once, in the service definition
export class OrderService extends Effect.Service<OrderService>()('OrderService', {
  dependencies: [UserService.Default, PaymentService.Default, AuditLog.Default],
  effect: Effect.gen(function* () { /* ... */ }),
}) {}

// Caller just uses:
const program = Effect.gen(function* () {
  return yield* OrderService.placeOrder(...)
}).pipe(Effect.provide(OrderService.Default))
```

```ts
// DON'T — wiring scattered, breaks when a third dep is added
const program = OrderService.placeOrder(...).pipe(
  Effect.provide(UserService.Default),
  Effect.provide(PaymentService.Default),
)
```

## Params vs dependencies

- **Params** = data per call (entity IDs, user input, request-scoped flags)
- **Dependencies** = shared infrastructure (Ref, PubSub, SubscriptionRef, services) — yield from context

```ts
// DO — shared infra built in layer, yielded inside
const PubSubTag = Context.GenericTag<PubSub.PubSub<Event>>('PubSub')
const StateTag = Context.GenericTag<SubscriptionRef.SubscriptionRef<State>>('State')

export class Coordinator extends Effect.Service<Coordinator>()('Coordinator', {
  dependencies: [...],
  effect: Effect.gen(function* () {
    const pubsub = yield* PubSubTag
    const state = yield* StateTag
    return { publish: (e: Event) => PubSub.publish(pubsub, e) }
  }),
}) {}
```

```ts
// DON'T — shared infra passed as params; caller forced to construct + thread it
const makeCoordinator = (pubsub: PubSub.PubSub<Event>, state: SubscriptionRef.SubscriptionRef<State>) =>
  Effect.gen(function* () { /* ... */ })
```

## `Effect.fn` for named methods, `Effect.fnUntraced` for hot paths

```ts
// DO — entry-point methods get a span name (for tracing) + stack capture
const create = Effect.fn('UserService.create')(function* (data: CreateUserInput) {
  const user = yield* repo.create(data)
  yield* Effect.log('User created', { userId: user.id })
  return user
})

// DO — per-element callbacks in tight loops skip the per-call span
const handler = Effect.fnUntraced(function* (msg: Message) { /* ... */ })
stream.pipe(Stream.mapEffect(handler))
```

```ts
// DON'T — anonymous generator, no span, no stack
const create = (data: CreateUserInput) => Effect.gen(function* () { /* ... */ })

// DON'T — span per stream element
stream.pipe(Stream.mapEffect((msg) => Effect.fn('handler')(function* () { /* ... */ })))
```

The `effect:` / `scoped:` body itself stays a plain `Effect.gen` — it's the layer constructor, run once at layer build. `Effect.fn` belongs on the methods it returns.

## Inline the returned shape; indirect only when it buys something

Define a returned method directly inside `return { ... }` when it's used only as the public method. The `const name = ...; return { name }` indirection earns its keep only when the method needs an `Effect.fn` span (above) or is also called internally — by another method or by the build body (the boot loop). Closure-private helpers stay as `function` declarations inside the `Effect.gen`; pure helpers move below the service (see the ts-react-style "Module layout" rule).

```ts
// DO
effect: Effect.gen(function* () {
  const store = yield* NoteStore
  const index = new Map<string, Entry[]>()

  function ingest(h: Header): void { /* used by the boot loop AND refresh */ }

  for (const h of store.headers()) ingest(h)

  return {
    byTarget: (path) => index.get(path) ?? [],
    refresh: (paths) => {
      for (const p of paths) ingest(/* ... */)
    },
  }
})
```

```ts
// DON'T — needless const indirection for methods used only in the shape
const byTarget = (path: string) => index.get(path) ?? []
const refresh = (paths: readonly string[]) => { /* ... */ }
return { byTarget, refresh }
```

A method that needs a traced span stays `const m = Effect.fn('Svc.m')(…)` above and is referenced in the shape — that indirection is the point.

## `Layer.provide` vs `Layer.provideMerge` vs `Layer.mergeAll`

| Combinator | Effect on output | Use for |
|---|---|---|
| `Layer.mergeAll(A, B, C)` | Outputs: A \| B \| C; requirements unioned | Sibling services at same level |
| `child.pipe(Layer.provide(parent))` | parent satisfies child's deps; parent's outputs hidden | Internal plumbing |
| `child.pipe(Layer.provideMerge(parent))` | parent satisfies child's deps; parent's outputs surfaced | Caller needs access to both |

```ts
// DO
const AppLive = Layer.mergeAll(UserService.Default, OrderService.Default).pipe(
  Layer.provide(DatabaseLive),  // Database is internal — callers don't see it
)

// DO when caller needs both
const TestLive = AppLive.pipe(Layer.provideMerge(TestClockLive))
```

## State lives inside service, not at module scope

```ts
// DO
export class Counter extends Effect.Service<Counter>()('Counter', {
  effect: Effect.gen(function* () {
    const ref = yield* Ref.make(0)
    return {
      incr: Ref.update(ref, (n) => n + 1),
      read: Ref.get(ref),
    }
  }),
}) {}
```

```ts
// DON'T — lifetime tied to module load, no scope, no test isolation
const counterRef = Effect.runSync(Ref.make(0))
export const incr = Ref.update(counterRef, (n) => n + 1)
```

## Top-level boundary: run Effects only at the edge

```ts
// DO — services return Effects; only the entry point runs them
export const userRouteHandler = (id: string) =>
  UserService.findById(id).pipe(Effect.provide(MainLive), Effect.runPromise)

// DO — wrap a boundary helper for public-API surfaces
export async function runPublic<A, E>(eff: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(eff)
}
```

```ts
// DON'T — service body runs another Effect synchronously
export class UserService extends Effect.Service<UserService>()('UserService', {
  effect: Effect.gen(function* () {
    return {
      findById: (id: UserId) => {
        const user = Effect.runSync(repo.findById(id)) // FORBIDDEN
        return user
      },
    }
  }),
}) {}
```
