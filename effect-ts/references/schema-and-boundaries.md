# Schema, branded types, parsing boundaries

## Parse unknown data at the boundary, not later

Any data crossing into your program is `unknown`. Parse it once at the boundary, then downstream code is typed. Boundaries include:

- HTTP request body / response body
- LSP / RPC / WebSocket messages
- File reads (config JSON, payee rules, fixtures, cached state)
- Env vars / CLI args
- MCP tool results
- Queue / PubSub messages
- **AI / LLM output** — the model may return malformed JSON even when prompted for strict schema
- Subprocess stdout

If it didn't originate inside your own typed code path, it's a boundary.

```ts
// DO
import { Schema } from 'effect'

const User = Schema.Struct({
  id: Schema.UUID,
  email: Schema.String,
  createdAt: Schema.DateFromString,
})
type User = Schema.Schema.Type<typeof User>

const handleRequest = Effect.gen(function* () {
  const body = yield* httpClient.get('/user')           // unknown
  const user = yield* Schema.decodeUnknown(User)(body)  // User, typed
  return yield* process(user)
})
```

```ts
// DON'T
const body = yield* httpClient.get('/user')
const user = body as User                  // lie
const user2 = body as unknown as User       // longer lie
return yield* process(user)                 // crashes at runtime field access
```

## Round-trip parse equality for strict format checks, not regex

Regex matches the **shape**, not the **validity**. `^\d{4}-\d{2}-\d{2}$` accepts `2026-02-30`, `2026-13-01`, `2026-00-00`. Strict validation = parse and re-format; if it round-trips, it's valid.

```ts
// DO — strict ISO date validation via schema
import { Schema } from 'effect'

const IsoDate = Schema.DateFromString.pipe(
  Schema.filter((d) => !Number.isNaN(d.getTime())),
)

const validated = yield* Schema.decodeUnknown(IsoDate)(input)
// '2026-02-30' fails: parses to Invalid Date

// DO — round-trip check for custom formats (e.g. `YYYY-MM-DD`)
import { DateTime } from 'effect'

const isValidYmd = (s: string): boolean => {
  const parsed = DateTime.makeFromIsoString(s)
  if (Option.isNone(parsed)) return false
  return DateTime.formatIsoDate(parsed.value) === s
}
```

```ts
// DON'T — regex accepts impossible dates
const isValidYmd = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s)
isValidYmd('2026-02-30')  // ✅ passes regex
isValidYmd('2026-13-01')  // ✅ passes regex
// Both are invalid; consumer crashes later.
```

Same principle for: emails (parse via `Schema.String.pipe(Schema.pattern(...))` + post-parse normalize), URLs (`new URL(s).href === s`), UUIDs (`Schema.UUID` not regex).

## Structural equality / dedup: use `Data` + `Equal` + `HashSet`, not JSON.stringify

JS `===` is reference equality. For dedupping structural objects or comparing them in `.filter`/`.some`, reach for Effect's data + equality modules — not JSON.stringify hacks or hand-rolled deep-equal.

```ts
// DO — Data.struct wraps a plain shape with structural equality + hash
import { Data, Equal, HashSet } from 'effect'

const a = Data.struct({ ynabId: 'tx_1', sourceId: 'src_1' })
const b = Data.struct({ ynabId: 'tx_1', sourceId: 'src_1' })
Equal.equals(a, b)  // true

// Dedup in O(n):
const uniq = HashSet.fromIterable(matches.map(Data.struct)).pipe(HashSet.toReadonlyArray)
```

```ts
// DO — Data.taggedEnum gives structural equality for free
import { Data } from 'effect'

type Match = Data.TaggedEnum<{
  exact: { readonly ynabId: string; readonly sourceId: string }
  fuzzy: { readonly ynabId: string; readonly sourceId: string; readonly score: number }
}>
const Match = Data.taggedEnum<Match>()

const seen = HashSet.fromIterable([Match.exact({...}), Match.fuzzy({...})])
HashSet.has(seen, Match.exact({...}))  // works structurally
```

```ts
// DON'T — JSON.stringify dedup; O(n) stringification per item, sensitive to key order
const uniq = Array.from(
  new Map(items.map((x) => [JSON.stringify(x, Object.keys(x).sort()), x])).values(),
)

// DON'T — hand-rolled deep-equal in .some()
const uniq = items.reduce<Item[]>((acc, x) => {
  if (acc.some((y) => y.a === x.a && y.b === x.b && y.c === x.c)) return acc
  return [...acc, x]
}, [])
// O(n²), forgets a field when shape grows, no shared semantics
```

For Map/Set keys: `Map<Data.Struct, V>` is **still reference-keyed** in plain JS. Use `HashMap` / `HashSet` from Effect for structural keying.

## Brand entity IDs

A bare `string` for `userId` will silently accept `orderId`. Brands enforce nominal typing.

```ts
// DO
export const UserId = Schema.UUID.pipe(Schema.brand('@app/UserId'))
export type UserId = Schema.Schema.Type<typeof UserId>

export const OrderId = Schema.UUID.pipe(Schema.brand('@app/OrderId'))
export type OrderId = Schema.Schema.Type<typeof OrderId>

declare function findOrder(id: OrderId): Effect.Effect<Order, OrderNotFound>
findOrder(someUserId)  // ❌ TS error
```

```ts
// DON'T
export type UserId = string
export type OrderId = string
findOrder(someUserId)  // ✅ compiles, ❌ wrong
```

Namespace the brand (`@app/UserId`, `@yoshintame/extractor-runtime/SourceTxId`) so brands from different packages don't collide.

## `Schema.optional` / `optionalWith` / Option fields

| Want | Use |
|---|---|
| Field may be absent on input, decode as `T \| undefined` | `Schema.optional(T)` |
| Field may be `null` or absent | `Schema.optionalWith(T, { nullable: true })` |
| Field may be absent, decode as `Option<T>` | `Schema.optionalWith(T, { as: 'Option' })` |
| Field may be absent, decode with default | `Schema.optionalWith(T, { default: () => fallback })` |

```ts
// DO
const User = Schema.Struct({
  id: UserId,
  email: Schema.String,
  bio: Schema.optionalWith(Schema.String, { as: 'Option' }),  // Option<string>
  name: Schema.String.pipe(
    Schema.optionalWith({ nullable: true }),
    Schema.withDecodingDefault(() => '<unnamed>'),
  ),
})
```

```ts
// DON'T
const User = Schema.Struct({
  id: UserId,
  email: Schema.String,
  bio: Schema.Union(Schema.String, Schema.Null, Schema.Undefined),
  // No standard semantics, downstream consumers each handle null/undefined differently
})
```

## `Option<T>` in domain types, not `T | null`

```ts
// DO
type User = {
  readonly id: UserId
  readonly email: string
  readonly bio: Option.Option<string>
  readonly avatar: Option.Option<URL>
}

const greeting = (u: User) =>
  Option.match(u.bio, {
    onNone: () => `Hi, ${u.email}`,
    onSome: (bio) => `Hi, ${u.email} — ${bio}`,
  })
```

```ts
// DON'T
type User = {
  readonly id: UserId
  readonly email: string
  readonly bio: string | null
  readonly avatar: URL | undefined
}
// Now every consumer writes its own null check; one will be forgotten.
```

## Wrap nullable boundary values once with `Option.fromNullable`

```ts
// DO — at the API boundary, convert null/undefined to Option
const editor = Option.fromNullable(vscode.window.activeTextEditor)
return Option.match(editor, {
  onNone: () => Effect.fail(new NoEditorOpenError()),
  onSome: (ed) => useEditor(ed),
})
```

```ts
// DON'T — null check leaks into business logic
const editor = vscode.window.activeTextEditor
if (editor === null || editor === undefined) {
  return yield* new NoEditorOpenError()
}
return yield* useEditor(editor)
```

## `Schema.Class` for entities with computed properties

```ts
// DO — methods + computed properties live with the schema
class User extends Schema.Class<User>('User')({
  id: UserId,
  email: Schema.String,
  roles: Schema.Array(Schema.String),
}) {
  get isAdmin() {
    return this.roles.includes('admin')
  }

  hasPermission(p: Permission) {
    return checkPermission(this.roles, p)
  }
}

const user: User = yield* Schema.decodeUnknown(User)(raw)
user.isAdmin       // ✅
user.hasPermission('write:user')  // ✅
```

```ts
// DON'T — schema and methods drift apart
const UserSchema = Schema.Struct({ id: UserId, email: Schema.String, roles: Schema.Array(Schema.String) })
type User = Schema.Schema.Type<typeof UserSchema>
function isAdmin(u: User) { return u.roles.includes('admin') }
```

## Recursive schemas: declare interface, suspend the recursion

```ts
// DO
interface Tree {
  readonly name: string
  readonly children: ReadonlyArray<Tree>
}

const Tree: Schema.Schema<Tree> = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend(() => Tree)),
})
```

```ts
// DON'T — direct self-reference, TS inference fails
const Tree = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Tree),  // ❌ used before declared
})
```

## `Schema.Struct` vs `Schema.Class` quick rule

| Use | When |
|---|---|
| `Schema.Struct({...})` | Plain data, no behavior, just shape |
| `Schema.Class('Name')({...})` | Entity with methods, computed props, or `_tag` discrimination |
| `Schema.TaggedError('Tag')<...>` | Serializable error (RPC/HTTP boundary) |
| `Data.TaggedError('Tag')<...>` | Internal domain error (no serialization) |

## Encoding/decoding direction

- `Schema.decodeUnknown(S)(input)` — `unknown → A`, parsing data INTO your domain
- `Schema.encode(S)(value)` — `A → I`, serializing your domain OUT
- `Schema.decode(S)(input)` — typed input variant (when you already know `I`)

Use `decodeUnknown` at every untrusted boundary; `encode` when serializing back out (HTTP response, queue payload, file write).
