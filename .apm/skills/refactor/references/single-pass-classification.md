# Single-pass classification

When the same array is filtered N times over mutually-exclusive predicates, one pass beats N. Three approaches, in preference order.

## Approach 1 — `Object.groupBy` + lookup table (ES2024)

Best when (a) the classifier is data-driven by a small dictionary, (b) all groups share the same result shape, (c) you want to add a new group with a one-line diff.

```ts
const KIND_BY_EXT = {
  '.md': 'markdown',
  '.field': 'fields',
  '.type': 'types',
} as const

type Kind = (typeof KIND_BY_EXT)[keyof typeof KIND_BY_EXT]

function kindOf(path: string): Kind | 'other' {
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot)
  return KIND_BY_EXT[ext as keyof typeof KIND_BY_EXT] ?? 'other'
}

const groups = Object.groupBy(paths, kindOf)

const sorted = Object.values(KIND_BY_EXT).reduce(
  (acc, kind) => {
    acc[kind] = (groups[kind] ?? []).toSorted()
    return acc
  },
  {} as Record<Kind, readonly string[]>,
)
```

Combine with a mapped-type shape to make `Kind` the single source of truth:

```ts
export type ManifestShape = {
  readonly all: readonly string[]
} & Readonly<Record<Kind, readonly string[]>>
```

Now adding `.template` → 1 line in `KIND_BY_EXT`, shape extends, reduce picks it up.

## Approach 2 — explicit `for` + `if/else if`

Best when (a) only 2-4 groups, (b) classifier has guard logic per group (not just a key lookup), (c) downstream needs each group with a distinct type.

```ts
const markdown: string[] = []
const fields: string[] = []
const types: string[] = []
for (const path of paths) {
  if (path.endsWith('.md')) markdown.push(path)
  else if (path.endsWith('.field')) fields.push(path)
  else if (path.endsWith('.type')) types.push(path)
}
```

Simpler than Approach 1 when there's no lookup table to extract. Use when the dispatch can't reasonably be a single-key index.

## Approach 3 — `Array.partition` (binary only)

`Effect.Array.partition` returns `[no, yes]`. Only useful for two-way splits.

```ts
import { Array as Arr } from 'effect'
const [files, dirs] = Arr.partition(entries, (e) => e.isDirectory)
```

## Anti-patterns

```ts
// DON'T — three full passes over `all`, each comparing one suffix
return {
  markdown: all.filter((p) => p.endsWith('.md')).toSorted(),
  fields: all.filter((p) => p.endsWith('.field')).toSorted(),
  types: all.filter((p) => p.endsWith('.type')).toSorted(),
}
```

```ts
// DON'T — for-loop with Map<string, T[]> and manual get-or-init
const byKind = new Map<string, string[]>()
for (const path of paths) {
  const key = classifierOf(path)
  const bucket = byKind.get(key) ?? []
  bucket.push(path)
  byKind.set(key, bucket)
}
// Object.groupBy does this in one call with typed keys.
```

## Cost / benefit

- **Big input, few groups:** Object.groupBy wins by big margin (one walk, native impl).
- **Small input, simple classifier:** all three are within noise. Pick what reads cleanest.
- **Need typed group keys at compile time:** Approach 1 with lookup table beats Approach 3.
