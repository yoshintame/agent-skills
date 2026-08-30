# Pattern matching

## Discriminated unions: `Match` + `discriminatorsExhaustive`, not `if (x.kind === '…')`

**Reflex: every `switch`, and every run of 2+ consecutive `if`s, is a refactor target — there is almost always a cleaner functional form** (`Match` for tag / multi-field dispatch, `Option.orElse` for first-hit-wins, `Equal.equals` for field-by-field comparison, an `Either` / `Option` chain for validation). For tag dispatch specifically: chain-of-ifs (and void / side-effecting switches) silently absorb a new variant, while `Match.discriminatorsExhaustive` and `Match.tagsExhaustive` break the compile. Even a return-typed switch that TS *does* exhaustiveness-check reads worse than `Match` — prefer it.

```ts
// DO — exhaustive, new variants break compile
import { Match } from 'effect'

const fmtHint = (h: Hint, currency: string): string =>
  Match.value(h).pipe(
    Match.discriminatorsExhaustive('kind')({
      'duplicate-cluster': (h) => `⚠ cluster ${h.clusterId} (${h.pairs.length})`,
      'collapsed-transfer-fee': (h) => `⚠ fee ${fmtAmount(h.suspectedFee, currency)}`,
      'list-truncation-suspect': (h) => `⚠ truncation src=${h.sourceCount} ynab=${h.ynabCount}`,
      'boundary-overlap': (h) => `⚠ edge ${h.windowEdge}: ${h.tx.date}`,
    }),
  )
```

```ts
// DON'T — fallthrough `return` hides missing variants
function fmtHint(h: Hint, currency: string): string {
  if (h.kind === 'duplicate-cluster') return `...`
  if (h.kind === 'collapsed-transfer-fee') return `...`
  if (h.kind === 'list-truncation-suspect') return `...`
  return `boundary-overlap ...`  // ❌ silently absorbs any new tag
}
```

For ADTs tagged with `_tag` (Effect-style — `Data.TaggedError`, `Schema.TaggedClass`), use `Match.tagsExhaustive` (see `error-mapping.ts` for a canonical example).

## Defining ADTs: `Data.taggedEnum` over hand-rolled unions

If you're defining a sum type from scratch, `Data.taggedEnum` gives constructors, guards, and `$match` for free — and downstream consumers get exhaustiveness automatically.

```ts
// DO
import { Data } from 'effect'

export type Op = Data.TaggedEnum<{
  create: { readonly tx: NewTx }
  update: { readonly id: string; readonly patch: Partial<TxPatch> }
  delete: { readonly id: string }
}>
export const Op = Data.taggedEnum<Op>()

// Constructors:
const op = Op.create({ tx })
// Guards (for .filter / .find):
const creates = ops.filter(Op.$is('create'))
// Exhaustive match:
const summary = Op.$match(op, {
  create: () => 'C',
  update: () => 'U',
  delete: () => 'D',
})
```

```ts
// DON'T — manual union, manual narrowing, no `$is` / `$match`
export type Op =
  | { kind: 'create'; tx: NewTx }
  | { kind: 'update'; id: string; patch: Partial<TxPatch> }
  | { kind: 'delete'; id: string }
```

**Carve-out — a boundary-decoded union stays `Schema.Union`, not `Data.taggedEnum`.** `Data.taggedEnum` is a runtime ADT helper; it can't parse external data. A union decoded from YAML/JSON is `Schema.Union(Schema.Struct({ kind: Schema.Literal('plain'), … }), …)` with `kind` the wire field — keep it and dispatch via `Match.discriminatorsExhaustive('kind')`. `Data.taggedEnum` is for sum types you *construct* in memory (an op-log, a command queue), not ones you *parse*.

## Value-sets: `enum` + `Schema.Enums`, not a `Schema.Literal` union

A value-set referenced *as a value* (status, mode, format — not a discriminant tag) is a TS string `enum`, decoded with `Schema.Enums(MyEnum)` (wire string → member). Keep public surfaces string by deriving `` `${MyEnum}` `` for config input / returned values; bridge a CLI flag with `Options.choiceWithValue`; test membership with `Object.values(MyEnum)`, never a hand-kept parallel array.

```ts
export enum Severity { Error = 'error', Warning = 'warning', Off = 'off' }
const SeveritySchema = Schema.Enums(Severity)  // decode 'error' → Severity.Error
type SeverityInput = `${Severity}`             // 'error' | 'warning' | 'off' for authoring / public reads
```

String enums *do* compile with string-literal keys (`{ error: 0 } satisfies Record<Severity, number>`) and `x === 'error'` comparisons — but prefer `[Severity.Error]` keys and `=== Severity.Error` so find-references stays whole. Discriminant tags (`_tag`, the `kind` of a `Schema.Union`) and error-`code` / wire contracts stay string literals. `verbatimModuleSyntax` ⇒ value import (`import { Severity }`, not `import type`).

## When NOT to reach for `Match` (and when you can't)

The reflex targets *runs* of branches and *dispatch*. What survives it:

- A **single** guard clause / early-return — `if (!user.active) return yield* new InactiveError(...)`. One `if`, one exit; a `Match` here is pure noise.
- A genuine 2-branch split where `Match.when` reads worse than the `if`.

A *run* of guards is the target, not an exception: field-by-field comparison is `Equal.equals(Data.struct(a), Data.struct(b))`, first-hit-wins is `Option.orElse`, multi-step validation is an `Either` / `Option` chain. The one guard-shaped `Match` win: dispatch on **2+ boolean flags with distinct semantics per cell** — `Match.value({a, b}).pipe(Match.when({a:T,b:T},...), ..., Match.exhaustive)` lays out the state table and fails compile on a missing cell.

**Dep-free modules:** where a module must not import `effect` (a mobile-safe core, a shared leaf lib), `Match` / `Option` / `Data` are off the table — keep the `switch` but guard it with `default: x satisfies never`, and write first-hit-wins as a `??` chain. The reflex still applies; only the tool changes.

## Option fallback: `Option.orElse` chain, not an `Option.isSome` ladder

"First hit wins" across a series of `Option` lookups is an `Option.orElse` chain, not a ladder of `if (Option.isSome(x)) return x.value`. `Option.map` transforms the hit, `Option.as` swaps it for a fixed value, `Option.getOrNull` / `Option.getOrElse` lands the result.

```ts
// DO
function resolveTargetPath(target: string, store: Store): string | null {
  return store.byBasename(target).pipe(
    Option.map((h) => h.path),
    Option.orElse(() => Option.as(store.byPath(target), target)),
    Option.orElse(() => Option.as(store.byPath(`${target}.md`), `${target}.md`)),
    Option.getOrNull,
  )
}
```

```ts
// DON'T — imperative isSome ladder + early returns
const byBase = store.byBasename(target)
if (Option.isSome(byBase)) return byBase.value.path
if (Option.isSome(store.byPath(target))) return target
return null
```

`orElse` is lazy (thunks run only if the prior is `None`), so the chain preserves the short-circuit order of the ladder.
