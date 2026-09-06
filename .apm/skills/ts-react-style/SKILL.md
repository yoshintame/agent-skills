---
name: ts-react-style
description: "User's personal TypeScript and React code conventions — naming, formatting, type style, error handling, component structure, accessibility. Use when writing or reviewing TypeScript or React code. Read references/typescript.md for plain TS rules, references/react.md for React/JSX rules."
---

# TypeScript & React style

Encodes the user's personal conventions for writing TypeScript and React code.
Base TS/React knowledge is assumed — this file only lists the choices that
differ from default code generation.

## How to use

1. Read this file fully — it covers rules common to all TypeScript code.
2. Read the relevant reference:
   - Plain TypeScript (types, errors, classes, modules) → [references/typescript.md](references/typescript.md)
   - React components, JSX, hooks, styling, a11y → [references/react.md](references/react.md)
3. If the project ships its own style skill or rules (an Effect skill,
   project `.cursor/rules`, a local `CLAUDE.md`), those take precedence —
   this skill is the fallback for stack-agnostic preferences.

## Common rules (DO / DON'T)

| Area | DO | DON'T |
|---|---|---|
| Files & dirs | kebab-case everywhere (`partner-balance-form.tsx`) | PascalCase / camelCase file names |
| Exports | named exports | `export default` |
| Functions | top-level `function` declarations | top-level `const fn = () => {}` |
| Callbacks | arrow functions for inline callbacks | wrapping inline callbacks in declarations |
| Parameters | destructure in the signature | positional params + `.prop` access inside |
| Comments | none — write self-documenting code; the only carve-outs: a one-line hint over a field of an exported shared type (autocomplete surface), and a one-line "why" at the exact spot of a non-derivable constraint (`biome-ignore`-shaped, ideally naming the spec that owns the full context) | inline / JSDoc / TODO comments unless asked; block comments that retell architecture or intent — that knowledge lives in the spec, and comments have no actualize process so they rot faster than the code they sit on |
| Debug logs | `console.log({ value })` | `console.log(value)` |
| Quotes / semicolons | single quotes, no semicolons | double quotes, trailing semicolons |
| Indentation | spaces | tabs |
| Branching | `ts-pattern` `match().exhaustive()` for dispatch / multi-field | `switch`, or a run of 2+ consecutive `if`s |
| Value-sets | string `enum` (+ `` `${E}` `` at string boundaries) | string-literal union used as a value |

## Formatting

Biome is the formatter and linter: single quotes, semicolons as-needed (i.e.
omitted), space indentation.

Biome `organizeImports` groups and orders imports automatically (built-ins →
external packages → shared-layer alias → other aliases → relative → URL, with
blank lines between groups). Don't hand-order imports against it.

Separate logical blocks inside a function body with a single blank line (guard
clauses, the main loop, the final return / aggregation). Biome keeps single
blank lines (and collapses runs of 2+ to one), so they survive formatting.
Don't write dense wall-of-statements bodies.

## Module layout

- The file's primary export comes first — the class / service / React component
  the file is named for. Module-private helpers it uses go **below** it, as
  `function` declarations. Function declarations hoist, so use-before-definition
  is fine; read top-down: the headline, then the supporting detail.
- Only pure helpers (no closure capture) lift to module level below the export.
  A helper that needs the surrounding closure (a shared `Map` / `Ref`, captured
  config) stays inside that scope — see the Effect skill for service bodies.
