---
name: mobx-keystone
description: "Conventions for projects using `mobx-keystone` + `mobx-react-lite`. Use when writing or reviewing models, stores, refs, persistence, and React integration — `@model`, `Model`, `prop`, `idProp`, `ExtendedModel`, `modelAction`, `rootRef`, `getSnapshot`/`applySnapshot`/`onSnapshot`, `mobx-keystone-persist`, or the matching `observer`/`useStore` wiring. Encodes the gap between the docs and idiomatic usage in this codebase."
---

# mobx-keystone conventions

This skill encodes **only the gap** between Claude's defaults and idiomatic mobx-keystone usage in this codebase. mobx-keystone API knowledge is assumed.

## How to use

1. Read this file fully before writing or reviewing a model, store, ref, or persistence config.
2. If the project ships a stricter local convention (`CLAUDE.md`, `.cursor/rules`), it wins.
3. Pair with [`ts-react-style`](../ts-react-style/SKILL.md) for React/observer naming and file layout.

## Critical rules (DO / DON'T)

| Area | DO | DON'T |
|---|---|---|
| **Define a model** | `@model('app/Foo') class Foo extends Model({ ... }) {}` | Plain class with mobx `@observable` props |
| **Mutations** | `@modelAction method() { this.x = 1 }` | Free mutation outside an action (strict mode warns/throws) |
| **Prop defaults** | `prop<T>(() => default)` — always supply a default factory | `prop<T>()` for fields that won't always be in input snapshots |
| **Single-id models** | `id: idProp` — id IS `$modelId` | Custom `id: prop<string>()` + `this.$modelId = this.id` in `onInit` |
| **Composite-id models** | `chatId: prop<string>(), chatType: prop<ChatType>()` + `onInit() { this.$modelId = this.chatKey.toString() }` | Storing composite key as a separate field while leaving `$modelId` auto-generated |
| **Keyed stores** | `class FooStore extends ExtendedModel(createModelStore(Foo), {}) { @modelAction ensure(id) { ... } }` | Custom `Record<string, Foo>` prop without the store helper |
| **Cross-tree refs** | `const fooRef = rootRef<Foo>('app/Foo/ref', { onResolvedValueChange(ref, _new, old) { if (old && !_new) detach(ref) } })` | Storing model instances by value in another model |
| **Singleton + RootStore** | Export `const fooState = new Foo({})` and pass into `RootStore({ fooState })` (slot name = singleton name) | Two parallel instances (singleton + `new Foo({})` inside RootStore prop default) — they diverge |
| **Slot name suffix** | Slot name carries the class kind: `chatsStore: ChatStore`, `orderState: OrderState`, `i18nModel: I18nModel`. Match the suffix to the class type. | Bare slot `order: OrderState` — readers (humans and AI) can't tell observable from plain value without checking the type |
| **React component reads** | `const { orderState } = useStore(); const { selectedTab } = orderState` inside `observer($Foo)` | Imported singleton inside the component body — bypasses provider, breaks Storybook/per-instance |
| **React mutations only** | `const { orderState } = useStore(); onClick={() => orderState.setX(1)}` — observer NOT required | Wrapping write-only components in `observer` for no reason |
| **Non-React mutators** | TanStack `onEnter`/`onLeave`, util fns, callbacks outside the tree → import singleton directly (`orderState.method(...)`) | Calling `useStore()` outside a React component |
| **Observer wrapping** | `function $Foo(...) { ... } export const Foo = observer($Foo)` | `observer(function Foo(...) { ... })` inline — breaks codebase pattern |
| **Snapshot vs persist** | Volatile field stays in snapshot; persist filter excludes it from storage | `prop(…).withSnapshotProcessor({ toSnapshot: () => undefined })` to "hide from localStorage" — also kills `onSnapshot` reactivity |
| **Persist whitelist** | Top-level keys via `mobx-keystone-persist` `whitelist`, OR custom wrapper with path-based `excludePaths` (with `*` for record keys) for nested filtering | One snapshot processor per volatile field (couples persist concern to snapshot concern) |
| **applySnapshot input** | Pass a snapshot with all whitelisted keys merged onto defaults: `applySnapshot(root, { ...getSnapshot(root), ...persisted })` | Apply partial root snapshot — fails on required-prop validation |
| **Store names** | `appModelName('Foo')` so every `@model('…/Foo')` is unique across projects | Bare `@model('Foo')` — clashes between unrelated packages |
| **Iteration shadow** | If slot name collides with a local iteration var (`orders.map((order) => ...)`), alias on destructure: `const { orderState } = useStore()` — different name avoids shadow | `const { order } = useStore()` then `orders.map((order) => order.x)` — inner shadows the store |

## Slot name suffix convention

Slot names in the RootStore — and therefore the destructured local names — carry the **kind** of object. The class name's suffix dictates the slot name's suffix:

| Class suffix | Slot suffix | Example |
|---|---|---|
| `Store` (collection of entities) | `Store` | `chatsStore: ChatStore`, `clientsStore: ClientStore` |
| `State` (singleton UI/widget state) | `State` | `orderState: OrderState`, `chatSidebarState: ChatSidebarState` |
| `Model` (single domain model) | `Model` | `i18nModel: I18nModel`, `sidebarModel: SidebarModel` |

Why: when a reader (human or AI) sees `useEffect(() => doStuff(orderState.selectedTab), [orderState])`, the suffix instantly flags **«this is mobx, deps will not fire on internal mutation; need `reaction`/`autorun` or `observer`»**. With bare `order`, the same code looks like a normal value and the bug ships.

Same rule for destructure-rename when shadowing: keep the suffix.

```ts
// In a file that also iterates orders.map((order) => …):
const { orderState } = useStore()  // slot name already disambiguates
```

## Singleton + RootStore pattern

This codebase wires every domain model as a module singleton AND a RootStore slot. The slot key matches the singleton export name.

```ts
// features/foo/model/state.ts
@model(appModelName('FooState'))
export class FooState extends Model({ ... }) { @modelAction ... }
export const fooState = new FooState({})

// config/store.tsx
@model(appModelName('RootStore'))
class RootStore extends Model({
  fooState: prop<FooState>(),  // slot name = singleton name; no default — instance comes from constructor
}) {}

export const store = new RootStore({ fooState })  // shorthand because key === variable name
```

Why both: `useStore().fooState === fooState` (same identity). React consumers go through the provider for testability; routes and utility callbacks reach the singleton directly without a hook.

If you create a model that ALWAYS has a fresh instance per RootStore (e.g. a `Store` whose lifetime is the root, no module-level access from outside React), skip the singleton: `fooStore: prop<FooStore>(() => new FooStore({}))`.

## Snapshot/persist split (most-violated rule)

`withSnapshotProcessor({ toSnapshot: () => undefined })` does two things at once: (1) the field disappears from `getSnapshot()`; (2) the field is invisible to `onSnapshot` subscribers. Persistence skips it (good) AND any external adapter listening for changes can never see it (often bad).

**When the goal is "don't persist this":** use a path-based persist filter, not a snapshot processor. Keep the snapshot reactive.

```ts
// shared/lib/persist-store.ts (sketch)
await persistRootStore(store, {
  storageKey: 'RootStore',
  whitelist: ['chats', 'chatList', ...] as const,
  excludePaths: [
    ['chats', 'items', '*', 'chatScroll'],
    ['chats', 'items', '*', 'pendingMessagesRefs'],
  ],
})
```

**When the goal is "this field has values that can't serialize (`File`, DOM refs, etc.) — even in-memory snapshots":** snapshot processor is the right tool. The field is in scope of `onSnapshot` but the JSON is safe.

```ts
files: prop<File[]>(() => []).withSnapshotProcessor({
  toSnapshot: () => [] as File[],
})
```

## `applySnapshot` doesn't run prop defaults for missing fields

When restoring persisted state, mobx-keystone does use `prop(() => default)` factories for keys absent from the input snapshot — but only if the prop has a default factory. Required props without defaults throw on missing input.

Rule: every persistable model's props get a default factory. Type-only props (`prop<T>()` without a fn) are only safe for slots passed via `new RootStore({ slot: instance })`.

## `createModelStore` keyed collection

Use the shared helper for any store that's a map keyed by `$modelId`:

```ts
@model(appModelName('FooStore'))
export class FooStore extends ExtendedModel(createModelStore(Foo), {}) {
  @modelAction
  ensure(id: ID): Foo {
    if (!this.has(id)) this.put({ id })
    return this.getOrThrow(id)
  }
}
```

The helper provides `get`, `getOrThrow`, `has`, `set`, `put`, `remove`, `clear`. Don't duplicate them by hand.

## `rootRef` for cross-tree links

When model A holds a list of model-B instances that live in another store, store **refs** not values:

```ts
const fooRef = rootRef<Foo>(appModelName('Foo/ref'), {
  onResolvedValueChange(ref, newFoo, oldFoo) {
    if (oldFoo && !newFoo) detach(ref)  // auto-cleanup dangling ref
  },
})

class Bar extends Model({
  fooRefs: prop<Ref<Foo>[]>(() => []),
}) {
  @modelAction
  linkFoo(fooId: ID) {
    if (this.fooRefs.some((ref) => ref.id === fooId)) return
    this.fooRefs.push(fooRef(fooId))
  }
}
```

`ref.id` is the target `$modelId`; `ref.maybeCurrent` is `T | undefined`; `ref.current` throws if unresolved. The factory resolves via the root store, so the target can live anywhere under the same root.

## Anti-patterns (forbidden)

- **Using `withSnapshotProcessor({ toSnapshot: () => undefined })` to keep a field out of `localStorage`.** Couples persist to snapshot reactivity. Use a persist-layer allowlist instead.
- **`new Model({})` in a `prop(() => new Foo({}))` AND also `export const fooState = new Foo({})`** — two instances, the singleton import is silently stale.
- **`useStore()` inside a TanStack `onEnter`/`onLeave` or a utility function** — no React context, will throw. Use the singleton.
- **`applySnapshot(root, partial)` where `partial` is missing root-level keys** — required props validation fails. Merge with `getSnapshot(root)` first.
- **`prop<T>()` (no default) on a field that gets restored from persistence** — `applySnapshot` leaves it `undefined`.
- **`observer(...)` on a component that only writes** (`onClick={() => order.setX(1)}` and nothing else). It's a no-op cost.
- **Mutating an observable map/array outside `@modelAction`** in strict mode. Even if it "works", it bypasses snapshot/action tracking.
- **Reusing a model name across `@model('Foo')` calls** in different packages. Always namespace via `appModelName`/equivalent prefix.
- **Reaching `store.foo.method(...)` from a React component when `useStore` is available.** Works but breaks the per-instance abstraction that lets tests/Storybook swap stores.

## When skimming PRs

Red flags to look for:
- `import { fooState }` inside a `*.tsx` component file → should be `useStore().fooState`
- `const { foo } = useStore()` where `foo` lacks a `Store`/`State`/`Model` suffix → reader can't tell it's observable, deps-related bugs slip through
- `withSnapshotProcessor({ toSnapshot: () => undefined })` → ask whether the goal is persistence or snapshot reactivity; usually it's persistence and should move to a persist filter
- `prop<T>()` without default + `prop()` in persist whitelist → next reload throws or silently undefines
- A new `@model('FooStore')` without `appModelName(...)` → namespace clash risk
- `useStore()` call inside `onEnter`/`onLeave` of a TanStack route → no provider mounted, will throw
- `useEffect(() => …, [orderState])` with no `reaction`/`autorun` inside → deps fire only when the instance reference changes (~never); mutations inside `orderState` are invisible

## Heuristic for extending this skill

> If Claude would already do this by default, don't add the rule. The skill is the diff between default behavior and required behavior. mobx-keystone API knowledge belongs in the upstream docs.
