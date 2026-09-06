# Plain TypeScript

## Types

- Never `any` — not even to silence a TS error. Use `unknown` and narrow it,
  or fix the actual type.
- Prefer `interface` over `type` everywhere an interface can express it. `type`
  only for unions, intersections, tuples, mapped / conditional / utility types.
- Type guards live in one shared `falsy` / `truthy` / `isX` module — no ad-hoc
  inline checks.

## Constants & enums

- **Default to `enum` over a string-literal union for any value-set used as a
  value** — statuses, modes, kinds, formats, roles; even 2-value sets. Named
  members, find-references, nominal narrowing. Use string enums (`enum X { A =
  'a' }`) so the wire value survives at runtime.
- **Keep a string literal, NOT an enum**, for: discriminant *tags* of an object
  union (the `kind` / `_tag` you dispatch on — a tag isn't a value-set), and
  wire / error-code contracts read or written verbatim by an external system (a
  nominal enum inside + string outside is the worst half).
- **Bridge a string boundary:** when the value is authored or read as a plain
  string (config files, public return types), expose `` `${Enum}` `` on the
  surface and keep the enum internal — `{ location: 'either' }` still
  type-checks. Decode string → member at the edge (`z.nativeEnum` /
  `Schema.Enums`).
- `as const satisfies Record<Enum, ...>` for label / config / lookup maps, keyed
  by enum members:

  ```ts
  const statusLabels = {
    [Status.Pending]: 'Pending',
    [Status.Done]: 'Done',
  } as const satisfies Record<Status, string>
  ```

## Pattern matching

- **Default to `ts-pattern` `match(...).with(...).exhaustive()`** for any
  dispatch over a discriminator (`kind` / `_tag` / a literal-union or enum tag)
  or any multi-field condition. Reach for it on sight — it reads better and
  `.exhaustive()` breaks compile on a missing case. A deliberate style default.
- **Reflex: any `switch`, and any run of 2+ consecutive `if`s, is a refactor
  target** — there's almost always a cleaner form: `match` for dispatch, a `??`
  chain for first-hit-wins, an array `.every()` / `.some()` for field-by-field
  checks. A void / side-effecting switch also silently drops a new variant;
  multi-field validation is ts-pattern's sweet spot — don't nest guards inside
  `switch` cases.
- No `ts-pattern`? Add it (it's a preferred lib) rather than hand-roll a switch;
  the zero-dep fallback is a `switch` with a `default: x satisfies never`
  exhaustiveness guard.
- What survives the reflex: a **single** guard clause / early-return (`if
  (!user.active) return …`) — one `if`, one exit. A *run* of guards isn't an
  exception, it's the target.
- **No `&&` / `||` chains for deriving a boolean or gating logic** (`a && b &&
  c`, `cond && doThing()`) — logical-operator precedence reads poorly. Spell it
  as a ternary or an explicit `if`; a ternary beats an `&&` chain.

## Validation at boundaries

- Parse external / unknown data with Zod (API responses, env, storage,
  payloads) — parse, never cast.
- Derive TS types from the schema; don't declare them twice.

## Classes

- Explicit accessibility modifier on every member.
- Constructor parameter properties for DI: `constructor(private readonly page: Page) {}`.

## Naming

- Name a `Map` / lookup `<values>By<key>` so the key is obvious from the name:
  `backlinksByTarget` (keyed by target path), `usersById`. Not a bare `index` /
  `map` / `cache`.
- When the same concept exists in a raw and a resolved form, give each a
  distinct name — `linkTarget` (raw `[[...]]` string) vs `targetPath` (resolved
  vault path). Don't reuse one word for both states.

## Modules

- Relative imports inside a module; absolute alias imports across modules, only
  from the public `index.ts` barrel.
- Barrels export only public API.

## Preferred libraries

Before writing a utility, check the libraries below first — reach for a hand-
rolled helper only when none of them covers the case. Specifically: no custom
array / object / function helpers that `es-toolkit` already provides, and no
custom utility types that `type-fest` already provides.

- `zod` — runtime validation
- `ts-pattern` — complex pattern matching
- `es-toolkit` — general utilities (over lodash)
- `date-fns` — dates
- `type-fest` — advanced utility types
- `nanoid` — ID generation
