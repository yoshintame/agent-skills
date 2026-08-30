# Repeated I/O across services

When several independent services each call the same expensive I/O (`fs.walk`, `http.get`, `db.query`) at layer-build time, you do N×I/O for a result that's identical each call. Extract a dedicated "manifest" service that owns the I/O once.

## Smell signal

```ts
class A extends Effect.Service<A>()('A', { effect: gen(function*() {
  const all = yield* vault.walk()  // I/O #1
  return /* uses all.filter(...) */
})})

class B extends Effect.Service<B>()('B', { effect: gen(function*() {
  const all = yield* vault.walk()  // I/O #2 — same result
  return /* uses all.filter(...) */
})})

class C extends Effect.Service<C>()('C', { effect: gen(function*() {
  const all = yield* vault.walk()  // I/O #3 — same result
  return /* uses all.filter(...) */
})})
```

Three full filesystem walks per `MainLive` build. Wasteful.

## Refactor

### Step 1 — new `Manifest` service that owns the I/O

```ts
class VaultManifest extends Effect.Service<VaultManifest>()('VaultManifest', {
  accessors: true,
  effect: Effect.gen(function* () {
    const vault = yield* VaultFS
    const all = yield* vault.walk()
    // classify, sort, return — see single-pass-classification.md
    return { all, markdown, fields, types } satisfies VaultManifestShape
  }),
}) {}
```

### Step 2 — consumers depend on the manifest, not the raw I/O

```ts
class A extends Effect.Service<A>()('A', {
  dependencies: [VaultManifest.Default, /* ... */],
  effect: Effect.gen(function* () {
    const manifest = yield* VaultManifest
    // use manifest.markdown / manifest.fields / etc.
  }),
}) {}
```

Repeat for `B` and `C`. **Effect.Service dedupes by tag**, so listing `VaultManifest.Default` in every consumer's `dependencies` still resolves to one instance per Layer scope — exactly one `vault.walk()` per build.

### Step 3 — composers stay the same

The outer `Layer.mergeAll(A.Default, B.Default, C.Default).pipe(...)` doesn't need to mention `VaultManifest`. It's pulled in transitively via each consumer's `dependencies:`. Don't add it explicitly — that's noise.

## Why not cache inside the raw I/O service?

You could put a `Ref<Option<readonly string[]>>` inside `VaultFS.walk()` and lazy-cache. That works but:

- Makes `VaultFS` stateful with a hidden cache — its `Context.Tag` contract no longer matches a pure interface.
- Breaks test isolation (cache survives across `it.effect` cases unless you provide a fresh `VaultFS` per test).
- Couples the cache lifetime to the `VaultFS` instance, not to the consumer's layer scope.

A dedicated `Manifest` service is **explicit**, scope-managed, and easy to mock.

## Why not lazy-on-demand?

Lazy access (compute on first read, then cache) is one more step:

- Replace eager `effect: gen(...)` with `effect: gen(...) /* returns getters */` where each getter wraps the walk in `Effect.cached`.
- Or use `SynchronizedRef` for the cache slot.

Worth it when:
- consumers might never call the manifest (don't want to pay the I/O cost at build)
- the I/O is very expensive (network, multi-second)

Not worth it when consumers always read the manifest (registries always need the path list at build) — eager is simpler.

## Cost / benefit

- 3 walks → 1 walk: usually 2-3× faster `MainLive` build for fs-bound work, much more on slow disks.
- Cost: one new service, one new file. No public API change.
- **Almost always worth it** when ≥2 services call the same I/O.
