---
name: refactor
description: "Refactoring pattern catalog — code smells to spot and the canonical fix. Use when the user asks to refactor, clean up, audit, or review the codebase (\"refactor\", \"clean up\", \"пройдись по коду\", \"почисти\", \"улучши\"). Encodes recurring smells found across real refactor passes, with reproducible fixes. Pairs with language/stack-specific skills (`/effect-ts`, `/ts-react-style`) — this skill is stack-agnostic."
---

# Refactoring patterns

Catalog of code smells repeatedly seen during refactor-pass sessions, with the canonical fix. **Read fully before opening a refactor pass.** Consult `references/*.md` when applying multi-step refactors.

## How to use

1. Read this file fully before starting a refactor pass.
2. When you spot a smell, look up the row in the catalog — the fix is canonical, not negotiable.
3. For multi-step refactors, see the referenced file.
4. **Verify after every batch:** typecheck + tests + lint. Don't accumulate red.
5. Commit per-pattern (or per-batch of related fixes), not per-file. Conventional Commits.

## Pattern catalog

| # | Smell | Fix | Where |
|---|---|---|---|
| 1 | `const shape: T = {...}; return shape` (intermediate var only for type-check) | Drop the intermediate. Pick by position: **extracted function** → annotate the function's return type (`(args): Effect.Effect<T, E> => Effect.gen(function* () { ... return {...} })`); **inline value in a builder API position** without a declarable signature (e.g. `effect:` of `Effect.Service`, value passed to a function) → `return {...} satisfies T`. Don't wrap a service `effect:` body in an arrow just to use annotation — it duplicates the deps/errors contract that the service already infers. | inline |
| 2 | Inline-typed object-arg `({a}: {a:A})` / `({a,b}: {a:A;b:B})` / etc. | **Two-step decision.** **(a)** If only one key — drop the wrapper, go positional: `fn(value: A)`. The object-arg adds ceremony without payoff at one key. **(b)** Two or more keys — **always** extract a named `interface FInput` next to the function. No key-count threshold within object-arg case. Justification: hover shows `(input: FInput)` (jumpable) instead of an inline structural blob; growing the input later doesn't change the signature line. | inline |
| 3 | Multi-pass `arr.filter(p1)`, `arr.filter(p2)`, `arr.filter(p3)` over the same array with mutually-exclusive predicates | Single pass: `Object.groupBy` (ES2024) or one `for`-loop with `if/else if` | references/single-pass-classification.md |
| 4 | Two or more services with 90% identical pipeline (read → parse → dedupe → shape) | Generic `buildX` helper + thin service shells (~30 lines each) | references/duplicated-services.md |
| 5 | Same expensive I/O called N times by N independent consumers | One service caches the I/O, consumers depend on it via transitive Layer deps | references/repeated-io.md |
| 6 | `as` cast on boundary data after a runtime guard (`raw as Config` post-`isRecord(raw)`) | Drop the cast; signature accepts `Record<string, unknown>` (or `unknown`), walks defensively | inline |
| 7 | Ad-hoc per-tag `Effect.catchTags({A: cb1, B: cb2, ...})` block in CLI/main | Central `internal/error-mapping.ts` with `Match.tagsExhaustive` returning `{exitCode, message}` | see `/effect-ts` `references/errors.md` |
| 8 | Unused deps in `package.json` (declared but never imported) | Delete + resync lockfile. Grep imports first to be sure. | inline |
| 9 | Dead `Shape` methods (interface member with zero call-sites in src + tests) | Delete from interface + impl | inline |
| 10 | Orphan `TODO` without ticket or owner (especially mid-code) | Resolve, file an issue, or delete. Per CLAUDE.md no-comments rule. | inline |
| 11 | Imperative `for + Map.get-or-init + .push` for grouping | `Object.groupBy(items, kindOf)` (ES2024, Bun supports) | references/single-pass-classification.md |
| 12 | Hardcoded multi-branch dispatch (`if x.kind === 'a' / else if 'b' / else if 'c'`) where branches share shape | Lookup table: `const MAP = {...} as const satisfies Record<Kind, Out>` + `MAP[x.kind]`. Compile-time exhaustiveness on `Kind` change. | inline |
| 13 | `JSON.stringify` for change-detection of known-shape data | `Data.struct` + `Equal.equals`, or `HashSet` for dedup | see `/effect-ts` `references/schema-and-boundaries.md` |
| 14 | Inline `Layer.mergeAll(...).pipe(Layer.provide(...))` block in `main.ts` | Extract to `internal/main-live.ts:makeMainLive({...})` parameterised factory | inline |
| 15 | Long-running deep-call pipeline with no `Effect.fn('name')` wrapper | Wrap entry-point service methods with `Effect.fn('Service.method')` for trace name + stack capture | see `/effect-ts` `references/services-and-layers.md` |
| 16 | Repeated `runtime.runPromise(eff)` from a Promise-returning public API | Extract `runPublic(eff)` boundary helper | see `/effect-ts` `references/services-and-layers.md` |
| 17 | Hand-rolled helper that duplicates ES2023+ / ES2024 stdlib (`Array.toSorted`, `Object.groupBy`, `Array.findLast`) | Use the stdlib — check `tsconfig.lib` is `ES2024+` first | inline |

## When NOT to refactor

- **Don't refactor for the sake of refactor.** Each fix must remove duplication, fix a smell, or improve type safety. "Looks nicer" is not enough.
- **Don't apply patterns that require public API changes during a "no-functional-change" pass.** Log to `DECISIONS.md` and defer.
- **Don't replace a 30-line hand-rolled helper with a 90 KB dep** unless the dep adds capability you'll actually use.
- **Don't preempt M-milestone reorganisations** (e.g. `src/public` / `src/internal` split, build configs) that are already planned. Touch only when that milestone lands.
- **If unit tests break,** stop. Either the refactor is wrong, or the test encodes behaviour you weren't preserving. Diagnose before continuing.

## Workflow per pass

1. **Inventory.** Walk the affected area, list smells mentally (or in TodoWrite if 5+).
2. **Prioritise.** P1: type-safety bugs (`as` on boundary). P2: dead code. P3: duplication. P4: style.
3. **Apply in batches.** Related fixes in one commit. After each batch: typecheck + tests + lint. Green → commit. Red → revert that batch.
4. **Document deferred items** in `DECISIONS.md` (or equivalent). Especially for "considered and rejected" — without it, the next session re-litigates.
5. **End-of-pass summary.** What changed, what didn't, what's left, why.

## Heuristic for adding to this catalog

> If a smell came up **twice in one pass**, or you fixed the same kind of thing **across 3+ files**, it belongs here. One-off oddities don't.

Stack-specific patterns belong in the stack skill, not here. (Effect-specific → `/effect-ts`; React-specific → `/ts-react-style`.) This skill is for stack-agnostic recipes.
