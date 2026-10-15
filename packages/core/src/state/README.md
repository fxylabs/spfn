# @spfn/core/state — server-owned state, declared once

A signed-in shell shows a handful of per-person facts: has this person a workspace, agreed to
the current terms, which role here, is the runtime ready. Each used to be wired by hand three
times — a read route for the first paint, a domain event the browser re-interprets into a
value, and a client store that merges the two — and the three drifted.

`defineState` declares such a fact once. `defineStateRouter` derives from that one
declaration the read route, the write route, its entry in a snapshot route and the SSE event.
The server is the single source of truth: every value a client receives is what `read()`
returned, read on the server; the browser never computes one.

This is the server half. The browser client and the React hook (`@spfn/core/state/client`,
`@spfn/core/state/react`) are a separate release.

## Import paths

One entry point, server only.

```typescript
import { defineState, defineStateRouter } from '@spfn/core/state';
import type { InferStateValue, InferStateKey, InferStateInput } from '@spfn/core/state';
import { Type } from '@sinclair/typebox';   // for .key() / .value() / .data() / .write() schemas
```

---

## Public API (complete)

From `@spfn/core/state`:

- Builder: `defineState(id)` → `StateBuilder`
- Router: `defineStateRouter(states, { path?, subject? })` → `StateRouter`
- Types: `StateBuilder`, `StateRouter`, `StateRouterOptions`, `StateRoutes`, `StateEvents`,
  `StatesSnapshot`, `SubjectResolver`, `InferStateValue`, `InferStateKey`, `InferStateInput`,
  `StateShape`, `StateValue`, `StateKey`, `StateResult`, `StateSnapshot`, `StateFrame`,
  `ReadContext`, `PermissionContext`, `WriteContext`, `ChangedPayload`, `GrantTarget`,
  `RevokeTarget`, `StateContract`, `StateWriteOptions`, `RoutableState`

`StateBuilder` methods — immutable, every call returns a new builder, order free, no terminal
method:

| Method | Effect | Refused |
| --- | --- | --- |
| `.key(schema, { shared? })` | Key fields: one value per key. `shared: true` — the value does not depend on the subject | a non-object schema; a field that is not a required `Type.String()`; a field named `events` or `token`; a second call |
| `.value(schema)` | The value. Required | a second call |
| `.data(schema)` | Data attached to the value. Optional | a second call |
| `.use(mws)` / `.skip(names)` | Middleware for the two per-state routes, `get<Id>State` / `put<Id>State`; calls add up. **Not authorization** — the snapshot and the SSE stream cannot run it; authorize with `.canRead()` (see [Permissions](#permissions)) | at `defineStateRouter`, when the state declares no `.canRead()` |
| `.contract({ since, auth?, requiresSession?, deprecatedIn?, removedIn? })` | Publishes the read route, the write route and the event | a second call |
| `.canRead(fn)` | `({ subject, principal, key? }) => boolean \| Promise<boolean>`. Required on a keyed state | a second call |
| `.canWrite(fn)` | Same shape. Absent → `canRead` decides | a second call |
| `.read(fn)` | The only source of a value. Required. Returns `{ value }`, or `{ value, data }` with `.data` — checked against the declaration on every path | a second call |
| `.write(input, fn, { since?, deprecatedIn?, removedIn? })` | Derives the write route. `fn` gets the read context plus `input` and returns nothing | a second call |
| `.changedBy(events)` | Domain events whose payload is read like the change signal's (see [The change signal](#the-change-signal)) | a second call; at `defineStateRouter`, an event whose payload schema lacks a required field |

`StateBuilder` members: `.changed` (the change signal), `.grant({ subject, key })` (`key` on a
keyed state only, and required there), `.revoke({ subject, key? })`, `.id`.

`StateRouter`: `.router` (a `Router` from `defineRouter`), `.events` (`Record` of the SSE
events keyed by wire name), `.states` (the declarations as given).

The types of `.read()`, `.write()`, `.canRead()` and `.canWrite()` contexts and of `R` are
computed from the schemas declared *before* the call — runtime order is free, but declare
`.key()`, `.value()` and `.data()` first to have the functions checked against them.

---

## Quick start

```typescript
// src/server/state.ts
import { defineState, defineStateRouter } from '@spfn/core/state';
import { Type } from '@sinclair/typebox';

export const consent = defineState('consent')                       // keyless: one value per subject
    .value(Type.Union([Type.Literal('pending'), Type.Literal('agreed')]))
    .data(Type.Object({ marketing: Type.Boolean() }))
    .contract({ since: '1.3.0', auth: 'clientProofV1', requiresSession: true })
    .read(({ subject }) => consentService.current(subject))
    .write(Type.Object({ termsVersion: Type.String(), marketing: Type.Boolean() }),
           ({ subject, input }) => consentService.record(subject, input));

export const runtime = defineState('runtime')                       // keyed, shared by every reader of the key
    .key(Type.Object({ workspaceId: Type.String() }), { shared: true })
    .value(Type.Union([Type.Literal('provisioning'), Type.Literal('ready')]))
    .canRead(({ subject, key }) => memberService.isMember(subject, key.workspaceId))
    .canWrite(({ subject, key }) => memberService.isAdmin(subject, key.workspaceId))
    .read(({ key }) => runtimeService.status(key.workspaceId))
    .write(Type.Object({ action: Type.Literal('restart') }), ({ key }) => runtimeService.restart(key.workspaceId));

export const member = defineState('member')                         // keyed, one value per (subject, key)
    .key(Type.Object({ workspaceId: Type.String() }))
    .value(Type.Union([Type.Literal('owner'), Type.Literal('admin'), Type.Literal('member')]))
    .canRead(({ subject, key }) => memberService.isMember(subject, key.workspaceId))
    .read(({ subject, key }) => memberService.roleOf(subject, key.workspaceId));

export const states = defineStateRouter({ consent, runtime, member });
```

```typescript
// server.config.ts
export default defineServerConfig()
    .routes(appRouter.packages([states.router]))
    .events(defineEventRouter({ ...appEvents, ...states.events }), { auth: { enabled: true, resolvePrincipal } })
    .build();
```

`.packages([states.router])` is the documented mount: the routes reach the generated route map
like `authRouter`'s, and an app route with the same name is refused by the route-map
generator's existing duplicate check. Spreading `states.router.routes` into the app router also
works. `read()` and `write()` are service calls; database access stays in repositories.

After a commit that changed a value, the app emits the change signal:

```typescript
await consent.changed.emit({ subject: userId });
await member.changed.emit({ workspaceId, subject: userId });
await runtime.changed.emit({ workspaceId });
```

---

## Three kinds of subject

| Declaration | `read()` receives | One value per | Frame reaches |
| --- | --- | --- | --- |
| no `.key()` | `{ subject, principal }` | subject | that subject's connections |
| `.key(K)` | `{ subject, principal, key }` | subject and key | that subject's connections that declared the key |
| `.key(K, { shared: true })` | `{ principal, key }` — no `subject` | key | every connection that declared the key and passed `canRead` |

A keyed state must declare `.canRead()`: the key comes from the request, so without it any
subject could read any key. `defineStateRouter` refuses one that does not.

Key fields are required strings. They travel as query parameters (always strings) and the
SSE frame filter compares them with the connect query as strings, so a `Type.Number()` key
would never match — `.key()` refuses it rather than coercing on one side. `events` and
`token` are refused as field names: the SSE stream reads them from the same connect query.

---

## What one declaration derives

With the default `path` `/state`:

| Derived | Shape |
| --- | --- |
| `getConsentState` | `GET /state/consent` → `{ at, value, data }`. Keyed: key fields in the query, validated by the route (missing → 400) |
| `putConsentState` | `PUT /state/consent`, only when `.write()` exists. Body = the input schema, keyed: key fields in the query. → `{ at, value, data }` |
| `getStates` | `GET /state` → `{ at, states: { consent: { value, data }, … } }` in declaration order — one for all states of the router |
| `states.events['state.consent.changed']` | the SSE event, payload `{ at, value, data, key?, subject? }` — `key` on a keyed state, `subject` unless shared |
| `consent.changed` | the change signal, payload keyless `{ subject }`, keyed `{ ...keyFields, subject }`, shared `{ ...keyFields }` |

`data` is present exactly when `.data()` is declared, in every response and frame.

Route names are `get<Id>State` / `put<Id>State` with the id's first letter upper-cased, so an
id must match `^[a-z][a-zA-Z0-9]*$` — `defineState` refuses another.

`defineStateRouter` refuses, naming the state: no `.value()` or `.read()`; a keyed state
without `.canRead()`; a state with `.use()` or `.skip()` but no `.canRead()`; a
`.changedBy()` event whose payload schema lacks a field the signal needs; two states with one
id; a `.write(…, { since })` on a state without `.contract()`; a state already grouped by
another router (each router subscribes the change signal, so every change would be read and
sent twice). A builder without `.value()` or
`.read()` is also a type error at the call.

---

## Handler order

The subject comes from `options.subject(c)`, default `c.get('auth')?.userId ?? null` — the
SSE `getSubject` default. No subject → `UnauthorizedError` (401). The principal on HTTP is
`c.get('auth')` as the app's middleware set it.

- **Read** `GET <path>/<id>`: subject → key (query, validated) → `canRead` (false → 403) →
  `at` → `read()` → `{ at, value, data }`.
- **Write** `PUT <path>/<id>`: subject → key → `canWrite ?? canRead` (false → 403, `write` not
  called) → `write({ …, input })` → `at` → `read()` → one SSE frame → `{ at, value, data }`.
  A `write` that throws propagates; nothing is read and no frame is sent. The input is a
  command, never the value: what the route answers is re-read.
- **Snapshot** `GET <path>`: subject → one `at` → for each state, in declaration order: a keyed
  state whose key fields are not all in the query is omitted; `canRead` false → omitted;
  otherwise `read()`. A keyed state left out never stops a later keyless one. A `read()` that
  throws fails the whole request — an error is not a permission.

Every `read()` result is checked against `{ value, data }` as declared — `data` exactly when
`.data()` is, no other field — with a schema built once per state when the router is built.
A result that does not match fails the read, write and snapshot routes with an `Error` (500)
naming the state and the first validation message, never the value; on the change signal it
is logged at warn and sends nothing; `grant` rejects with the same error and sends nothing.

A write that committed and then failed to read — `read()` threw or returned an undeclared
result — answers 500 and sends no frame, although the write ran. There is no value to report;
the next signal or read brings the client up to date.

The derived routes are ordinary `RouteDef`s registered by `registerRoutes`, so `.use()`
middleware runs inside the route's own chain, after the app's global middleware — it sees the
`auth` the app set. It runs on the two per-state routes only: the snapshot route and the SSE
stream carry no state's `.use()`. That is why `.use()` / `.skip()` require `.canRead()` — a
guard in middleware would hold on `GET <path>/<id>` and leak through `GET <path>` and the
stream. A state that needs middleware only for, say, rate limiting declares
`.canRead(() => true)` to say so.

---

## The change signal

The app emits `state.changed` **after the commit** that changed the value — from
`onAfterCommit` (`@spfn/core/db`), not inside the transaction. The module never reads on its
own: no polling, no database trigger. On each signal it reads and sends one frame:

| State | Read | Frame |
| --- | --- | --- |
| keyless | `read({ subject })` | `{ at, value, data, subject }` |
| keyed | `read({ subject, key })` | `{ at, value, data, key, subject }` |
| keyed shared | `read({ key })` once, however many connections hold the key | `{ at, value, data, key }` |

`emit` validates its payload and refuses a missing field — the module reads exactly what the
payload names. On the signal path `principal` is `undefined`. A `read()` that throws is logged
at warn with the state id and sends nothing; the next signal works as usual.

The signal is in-process: the pod that committed reads and emits, and the SSE event (wired to
the cache like any event in `.events()`) carries the frame to every pod. Do not attach a cache
to `state.changed` itself — every pod would read and send the frame again.

`changed.emit` on a builder no router grouped throws, naming the state. Every builder call
returns a new builder and the router subscribes the signal of the instance it was given, so
export that final instance — an intermediate `base` in `base.write(…)` is never routed.

**`.changedBy([event, …])`.** A domain event the app already emits can stand in for the
signal: the router subscribes each listed `EventDef` and reads its payload like
`changed.emit`'s — keyless `subject`; keyed the key fields and `subject`; shared the key
fields. `defineStateRouter` refuses an event whose declared payload schema lacks one of those
as a required property, naming the event and the field. A payload that fails the same check at
runtime is logged at warn and skipped (the app emitted it; there is nobody to throw to). The
module attaches nothing to the event — no `canSubscribe`, no `filter`; it only subscribes.

- An event listed by two states re-reads both and sends two frames.
- An event that is also in the app's SSE router reaches the browser twice by design: as itself,
  and through the state as `state.<id>.changed`.
- One pod re-reads: the pod that emitted the event. A listed event bound to the cache transport
  (every event in `.events()` is) reaches every pod, so the router subscribes it with
  `{ localOnly: true }`; the derived `state.<id>.changed` frame then fans out to every pod
  through the cache like any event. One emit, one read, one frame.
- On the emitting pod `await domainEvent.emit()` also awaits the state's `read()` and its frame
  publish, so a slow `read()` delays the caller of `emit`.
- The payload is checked against the signal's fields only; a field the state does not name is
  ignored, even when the key schema declares `additionalProperties: false`.

`read()`'s result is copied into the frame, so neither a handler mutating what it returned nor
a subscriber mutating the payload changes the other.

---

## Permissions

| Predicate | Enforced at | On refusal |
| --- | --- | --- |
| `canRead` | `GET <path>/<id>` | 403 |
| `canRead` | `GET <path>` | that state omitted |
| `canRead` | SSE connect (`canSubscribe`), with the key from the connect query | that event in `connected.deniedEvents` |
| `canWrite ?? canRead` | `PUT <path>/<id>` | 403 |

On SSE the connection declares its key in the connect query —
`/events/stream?events=state.runtime.changed&workspaceId=w1&token=…`. The module sets each
derived event's `.canSubscribe()` and `.filter()` (`@spfn/core/event`):

- `canSubscribe`: keyed — any key field missing from the query denies without calling
  `canRead`; otherwise `canRead({ subject, principal, key })`. Keyless — `canRead` when
  declared, else allowed (a subject exists; the handler asks only then). `principal` is what
  the SSE auth config's `resolvePrincipal` returned.
- `filter`: every key field of the frame equals the query's, and a frame carrying `subject`
  reaches only that subject.

`canRead` runs once per connection. A membership that ends while the connection is open is
the app's `revoke` call — nothing re-evaluates it.

**State events require an authenticated stream** (`auth: { enabled: true }` in `.events()`).
Without auth a connection has no subject, the handler never asks `canSubscribe`, and so
`canRead` would be skipped; the derived `filter` therefore refuses every connection without a
subject, and no state frame is delivered on such a stream.

## `grant` / `revoke`

```typescript
await runtime.revoke({ subject: userId });                          // membership ended
await runtime.grant({ subject: userId, key: { workspaceId } });     // membership began
```

`grant` opens exactly the granted key and does not consult `canRead` — it is the app's
statement that the subject may now read it. On a keyed state it calls the derived event's
`grant(subject, { query: key })`, so only the subject's connections whose connect query
declared that key are activated; a tab of the same subject on another key — one `canRead`
refused — stays shut. Then it reads the current value for that subject and key and sends it as
one frame, so the client has the value at once. `key` is required on a keyed state (a type
error, and a refusal naming the state at runtime); a keyless state takes `{ subject }`.

The key is checked against `.key()`: an empty or partial key (or a non-string field) rejects
naming the state and the field, since it would match every connection of the subject. A field
`.key()` does not declare is dropped, never matched on. `revoke({ subject, key })` checks the
same way.

`revoke({ subject, key })` deactivates the event on the subject's connections that declared
`key`; `revoke({ subject })` without a key reaches every connection of the subject, whatever
key it declared. Each receives `subscription.revoked`.

Both reach every pod through the cache transport, which applies the same key rule. A `read()`
that throws, or returns an undeclared result, in `grant` rejects the call and sends nothing
(the grant itself is already applied). Across pods the grant's control message and its frame
travel on separate channels, so a tab on another pod may still be denied when the frame arrives
and drop it; the next signal brings it up to date.

---

## `at`

`at` is `new Date().toISOString()` taken **before** `read()` starts. Every response and frame
carries the `at` of the read that produced it, and a snapshot carries one `at` for all its
states. A client applies a value only when its `at` is not older than the one it holds.

`at` is wall-clock: across pods it is as good as their clocks, typically within a few
milliseconds of each other. Two values with the same `at` are resolved as "same value, no
change" by the client (implemented in the client half). There is no version counter.

## Contract

`.contract({ since, auth?, requiresSession?, deprecatedIn?, removedIn? })` publishes, in
`contracts/current.json`:

- the read operation, response `Type.Object({ at: Type.String(), value, data })` (`data` when declared),
  key fields as the request query;
- the write operation, request body = the input schema, the same response, and its own
  `since` / `deprecatedIn` / `removedIn` from `.write(…, options)` falling back field by field
  to the state's;
- the SSE event `state.<id>.changed` with `since` / `deprecatedIn` / `removedIn`.

A state without `.contract()` appears nowhere, like a route without one. The snapshot route is
not contracted. A `value` literal removed later is `response.type-changed` on the read
operation and `event.payload.type-changed` on the event, as any route and event.

---

## Out of scope

- Browser-only state (an open panel, a draft), session and network state.
- Optimistic updates: the client applies what the server read, never a guess.
- The browser client and the React hook — `@spfn/core/state/client`, `@spfn/core/state/react`,
  a separate release.
- De-duplicating `read()` across subscribers of a per-subject keyed state (each subject has
  its own value; a shared key is read once).
- A route-level "refuse until state X is Y" gate.
