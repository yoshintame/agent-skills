---
name: tanstack-react-router
description: Conventions for TanStack Router (file-based) in this codebase — route-object exports, params/search/loader access, typed links, and the view-in-path-param pattern. Use when writing or reviewing routes or any feature that reads route state.
---

# TanStack Router conventions

Encodes **only the gap** between the library's defaults and idiomatic usage in
this codebase. TanStack Router API knowledge is assumed. Pair with
[`ts-react-style`](../ts-react-style/SKILL.md).

## Route objects are exported and imported — never `getRouteApi` in a feature

Each route file exports its `Route` under a named alias; consumers import that
object and call its hooks. `getRouteApi('/literal/route/id')` is **banned in
features**: it hardcodes the generated route-id string and bypasses the import
graph, so a moved/renamed route fails at runtime instead of at compile time.

```ts
// routes/.../orders/index.tsx
export { Route as OrderListRoute }

// features/order/ui/order-list-header.tsx
import { OrderListRoute } from '@/routes/_protected/_sidebard/orders'
const navigate = OrderListRoute.useNavigate()
<Link to={OrderListRoute.fullPath} search={(prev) => ({ ...prev })}>
```

`Route.useSearch()`, `Route.useLoaderData()`, `Route.useParams()`,
`Route.useNavigate()`, `Route.fullPath` all read off the imported object.

## A route reads its own params, never a child's

Inside a route file use the file's own `Route.useParams()` — it returns the
route's own params **plus ancestors**, never descendants. A parent reaching a
child's params (`getRouteApi(childId).useParams()`) is the smell: push the
component that needs the child param — and any provider it requires — **down**
into the route that owns it. Each route then subscribes only to its own params,
which is also what keeps the re-render boundary tight (a parent that reads a
child param re-renders on every child navigation).

```tsx
// parent layout route: owns clientId, not chatId
function ChatChrome() {
  const { clientId } = Route.useParams() // { chatType, clientId } — no chatId
  return <><ClientBlock clientId={clientId} /><Outlet /></>
}

// child leaf route: owns chatId, hosts the provider that needs it
function NestedChat() {
  const { chatType, chatId } = Route.useParams()
  return <ChatProvider chatId={chatId} chatType={chatTypeFromSection(chatType)}>...</ChatProvider>
}
```

## How a feature component gets route state

- Bound to exactly one route → import that route object and use its hooks.
- Rendered under several routes (lists, shared chrome) → take the value as a
  **prop** from the route, or read it through a **dedicated feature hook** that
  wraps `useParams({ strict: false })`. Do not scatter `useParams({ strict:
  false })` across components; give the feature one accessor.
- A route's index component owns its param — pass it down as a typed prop rather
  than re-reading loose params with a `!` assertion in the child.
- The feature accessor takes its own `strict` flag and never fabricates a
  default: strict callers (always under the route) get a guaranteed value or a
  throw; loose callers (off-route, e.g. a global sidebar) get `undefined` and
  handle it. Defaulting a missing identity param to some value hides the
  off-route case.

```ts
// one feature hook over loose params — not getRouteApi, not ad-hoc useParams
export function useChatRouteParams(opts: { strict: true }): { chatType: ChatType }
export function useChatRouteParams(opts?: { strict?: false }): { chatType?: ChatType }
export function useChatRouteParams(opts?: { strict?: boolean }) {
  const { chatType } = useParams({ strict: false })
  const decoded = chatType ? chatTypeFromSection(chatType) : undefined
  if (opts?.strict && !decoded) throw new Error('no active chat section')
  return { chatType: decoded }
}
```

## View-in-path-param pattern

When a variant is part of a resource's **identity** (chat kind, entity type),
put it in a `$param` path segment (a section slug), not in `search`. `search`
stays for filter/preset/view state. The slug⇄enum mapping lives in **pure
functions in the feature model**; components never index the slug record
directly, and the route boundary validates/decodes it.

```ts
// feature/model — the slug is an implementation detail behind these
export function sectionFromChatType(chatType: ChatType): ChatSection { ... }
export function chatTypeFromSection(section: string): ChatType { ... }
export function isChatSection(value: string): value is ChatSection { ... }

// route guard decodes/validates at the boundary; an unrecognized identity
// param is a 404, not a silent redirect to a default
beforeLoad: ({ params }) => {
  if (!isChatSection(params.chatType)) throw notFound()
}
```

An invalid path-param value (unknown section, malformed id) is `notFound()`, not
`redirect(...)` to a default — silently defaulting hides broken links. Unknown
routes already fall through to the root `notFoundComponent`.

Route-lifecycle helpers (`onEnter`/`onStay`/`loader`) take the **raw param**
(the section slug string) and decode it internally, so call sites pass
`params.chatType` straight through instead of wrapping every call in the decoder.

## Typed navigation

`to` is the route path template, `$params` go in `params`; for static routes use
`Route.fullPath`. Don't hand-build `to` as a bare untyped `string` when the
typed template works — that drops Link's param/search checking.

```tsx
<Link to="/$chatType/client/$clientId/$chatId" params={{ chatType: sectionFromChatType(type), clientId, chatId }} />
```

## When skimming routes/features

Red flags:
- `getRouteApi(...)` anywhere under `features/` → import the exported Route object instead
- a parent route reading a child param via `getRouteApi(childId)` → move the consumer/provider down
- `useParams({ strict: false })` repeated across components of one feature → extract a feature hook
- `params.x!` / `clientId!` in a component that is always under the owning route → take a typed prop
- a slug record indexed directly in a component (`SECTION_MAP[x]`) → funnel through the mapping function
- chat/entity **kind** carried in `search` instead of a path `$param`
- `to={someString}` typed as bare `string` → use the route template or `Route.fullPath`
- an invalid path-param guard that `redirect`s to a default instead of `notFound()`
- a param accessor that defaults a missing identity param to a value instead of `undefined`/strict
- a component threading an optional param (`clientId?`) with `!`/`hasClient` across both a scoped and an unscoped route → split into scoped + lean variants so each takes a required (or no) param
