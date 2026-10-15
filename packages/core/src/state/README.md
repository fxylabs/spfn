# @spfn/core/state — server-owned state, declared once

A signed-in shell shows a handful of per-person facts: has this person a workspace, agreed to
the current terms, which role here, is the runtime ready. Each used to be wired by hand three
times — a read route for the first paint, a domain event the browser re-interprets into a
value, and a client store that merges the two — and the three drifted.

`defineState` declares such a fact once. `defineStateRouter` derives from that one
declaration the read route, the write route, its entry in a snapshot route and the SSE event.
The server is the single source of truth: every value a client receives is what `read()`
returned, read on the server; the browser never computes one.

The browser side — `@spfn/core/state/client` and the React hook `@spfn/core/state/react` —
is described under [Browser](#browser).

## Import paths

```typescript
// server
import { defineState, defineStateRouter } from '@spfn/core/state';
import type { InferStateValue, InferStateKey, InferStateInput } from '@spfn/core/state';
import { Type } from '@sinclair/typebox';   // for .key() / .value() / .data() / .write() schemas

// browser — the router by type only
import { createStateClient } from '@spfn/core/state/client';
import { useServerState } from '@spfn/core/state/react';
import type { states } from '@/server/states';
```

---

## Public API (complete)

From `@spfn/core/state`:

- Builder: `defineState(id)` → `StateBuilder`
- Router: `defineStateRouter(states, { path?, subject? })` → `StateRouter`
- Types: `StateBuilder`, `StateRouter`, `StateRouterOptions`, `StateRoutes`, `StateEvents`,
  `StatesSnapshot`, `StatesManifest`, `SubjectResolver`, `InferStateValue`, `InferStateKey`, `InferStateInput`,
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
  throws fails the whole request — an error is not a permission. The answer is
  `{ at, states, manifest }`: `manifest` is `{ [id]: { key: string[]; write: boolean } }` for
  every state in declaration order — the key fields (`[]` when keyless) and whether it has a
  write — built once when the router is built. It is what the [browser client](#browser)
  knows of the router at runtime.

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
not contracted, its `manifest` included. A `value` literal removed later is `response.type-changed` on the read
operation and `event.payload.type-changed` on the event, as any route and event.

---

## Browser

`@spfn/core/state/client` is the browser side of a state router: it calls the derived read,
write and snapshot routes, keeps one SSE stream open for every state, and decides per
`(id, key)` which of a snapshot, a frame, a read or a write answer is current.
`@spfn/core/state/react` puts one state into a component. The router is known **by type
only** — `import type { states }` — so no server code reaches the browser bundle;
`@spfn/core/state/client` imports nothing from `@spfn/core/state` at runtime.

```typescript
// src/client/state.ts
import { createStateClient } from '@spfn/core/state/client';
import { createAuthSSEClient } from '@spfn/core/event/sse/client';
import type { states } from '@/server/states';                     // type only

export const state = createStateClient<typeof states>({
    sse: createAuthSSEClient(),                                     // the state client's own
    api: { baseUrl: '/api/rpc' },                                   // passed to createApi
});
```

```tsx
'use client';
import { useServerState } from '@spfn/core/state/react';
import { state } from '@/client/state';

function Shell({ workspaceId }: { workspaceId: string })
{
    const consent = useServerState(state, 'consent');                 // keyless
    const runtime = useServerState(state, 'runtime', { workspaceId }); // keyed

    if (consent.status === 'loading' || runtime.status === 'loading')
    {
        return <Spinner />;
    }

    return consent.value === 'pending'
        ? <Terms onAgree={marketing => consent.write({ termsVersion: '2026-10', marketing })} />
        : <Workspace runtime={runtime.value} />;
}
```

### The manifest

A type cannot be read at runtime, and the client needs three facts the router type carries:
every state id (the stream requests every state event), each keyed state's key fields (to tell
which key a snapshot entry belongs to) and which states have a write. The snapshot route
answers them as `manifest`, so the app declares the router once, on the server.

The first `subscribe` — or `get`, `write`, `snapshot` — therefore reads the snapshot **first**:
the client installs its manifest, then applies its states, then opens the stream with
`events=` from the manifest, in its order. Until then a `subscribe` waits (it never throws),
and `current()` is `undefined`; a `subscribe` while that snapshot is in flight is served by it,
not by a second read. Once the manifest is known, a `subscribe` whose id it does not name, or
whose key fields differ from the state's, is refused: the error, naming the state and both sets
of fields, goes to `onError`, and the subscription is dropped without reopening the stream. A
`write` on a state the manifest marks `write: false` rejects naming the state, before any
request. A first snapshot that fails goes to `onError` (or rejects the call that needed it).
While subscriptions wait on it, it is read again every `retryDelay` (default 3000 ms, the SSE
client's `reconnectDelay`), each failure to `onError`, until it succeeds, `close()` runs, or
nothing is subscribed; a `get`, `write` or `snapshot` that reads it first serves the waiting
subscriptions too — whichever call brings the manifest opens the stream. `close()` while it is
in flight discards its answer, and a `get` or `write` waiting on it rejects: the client was
closed.

### `createStateClient<typeof states>({ sse, api?, onError?, retryDelay? })`

| Member | Behaviour |
| --- | --- |
| `get(id, key?)` | `GET` `get<Id>State`, key fields in the query. The answer is applied under the ordering rule and returned |
| `snapshot(query?)` | `GET getStates`, by default with the stream's query. Each state in the answer is applied, and each subscribed state it omits is marked `'revoked'` (below); the snapshot is returned. A rejected fetch rejects and changes nothing |
| `subscribe(id, key?, listener)` | Registers the listener for `(id, key)` and returns its unsubscribe (idempotent). The client's first subscriber reads the snapshot, then opens the stream (below) |
| `write(id, input, key?)` | `put<Id>State` with the input as the body, key fields in the query. The answer is applied at once — before the frame the write also sends — and returned. Typed only for a state with a write, and requires the key on a keyed one |
| `current(id, key?)` | Synchronous: `{ at, value, data?, status }`, `{ status: 'revoked' }` for a state revoked before any value arrived, or `undefined`. The same frozen object until a change is applied |
| `close()` | Closes the stream, drops every listener. Idempotent |

`onError` receives a failure of something the client ran on its own — the first snapshot, the
snapshot after the stream opened, the read after a grant — and a refused `subscribe` (default
`console.error`). Calls the app makes reject.

A listener that throws is logged at warn with the state id and does not stop the others.

Give the state client an `SSEClient` of its own: an `SSEClient` holds one subscription, and
the state client's supersedes any other made on it.

### Ordering

Per `(id, key)`, every arrival — a snapshot entry, a frame, a read or a write answer — goes
through one rule. `at` is the time the server's read started, so a larger `at` is a later value.

| Arrival | Result |
| --- | --- |
| no current entry, or `at` newer than the current | applied, listeners notified |
| `at` equal to the current | one read stamps one `at`, so this is the same value: applied and notified only when `value` or `data` differ (deep-equal) or the entry is `'revoked'` |
| `at` older than the current | dropped |
| a snapshot older than one state's entry | that state keeps its entry; the others take the snapshot |
| a write answer | applied like a frame — its own frame, arriving later with the same `at` and value, changes nothing |
| a frame for a key not subscribed here | dropped (the server already filters by the connect query; this is the second guard) |

The ordering rule decides the value; the status is decided apart (next section): an arrival
on a revoked `(id, key)` supplies its value and leaves it `'revoked'`.

An applied change replaces the entry with a new frozen object; nothing else does. That is
what `useSyncExternalStore` needs: `getSnapshot` returns the same reference while nothing
changed.

### The stream

- **One stream per client**, opened when the first subscriber arrives and closed when the last
  leaves. Subscriptions made in the same task (components mounting together, a StrictMode
  unmount-remount) are batched into one change.
- **Snapshot first**: the first stream opens after the first snapshot, whose manifest it needs.
- **Every event requested**: `events=` lists `state.<id>.changed` for every state of the
  manifest, in its order, never only the subscribed ones. The server's `grant` activates only an event the
  connection requested, so a state subscribed later would otherwise be ungrantable.
- **Keys in the query**: the connect query is the union of the subscribed keys' fields (SSE
  `subscribe({ query })`). A new key value, or the last subscriber of one leaving, closes the
  stream and opens it with the new query.
- **Snapshot on every open** — the first, a reconnect, a reopen on a key change. A frame sent
  while no stream was open is lost, whether its key changed or not; the snapshot read after
  the open covers that gap. (It runs on the stream's `open`, not at `onReconnect`: a snapshot
  read before the new stream is live would leave the same gap.)
- **One value per key field per connection.** A connect query carries one `workspaceId`; when
  two subscribed keys disagree on a field, the most recently subscribed key is carried. A key
  the stream does not carry is read once (`get`) when the stream opens and receives no frames
  until it is carried again. A screen that must follow two workspaces live uses a second
  state client.

### `'revoked'` — the server does not serve this to you

One status says the server stopped serving a `(id, key)` to this subject, however the client
learned it. The mark is kept per `(id, key)` apart from the value, so it holds even when no
value has arrived yet.

| Arrival | Client |
| --- | --- |
| `subscription.revoked` for `state.<id>.changed` | the entry of `id` for **the key the connection carries** (keyless: its one entry) gets `status: 'revoked'`, value kept, listeners notified. The server scopes a revoke by the connect query, so a shadowed key of the same state is untouched |
| a snapshot that omits a subscribed state — keyless, or keyed with its key in the query | `'revoked'`, value kept if one exists, listeners notified. This is also a state denied at connect (`canRead` false, absent from the snapshot), and a reconnect after access was lost while the stream was down, when no revoke could arrive. A keyed state whose key the query did not carry is not marked |
| a frame, a read or a snapshot started before the revoke | supplies its value under the ordering rule; the status stays `'revoked'` |
| `subscription.granted` for it | clears the mark for the carried key and reads it once (`get`); the server also sends a frame, before or after the control frame. Both arrive `'ready'`, and either order ends at the latest value |
| the snapshot of a connection opened after the revoke, holding the state | clears the mark: that connection's own connect check served it |
| the read of a shadowed key when a connection opened after the revoke, answered | clears the mark the same way: the read route served it |
| an answer of such a read older than the entry — a frame or a `write()` answer of the new connection landed first | its value is dropped under the ordering rule, while the mark is still lifted: the lift goes by the connection, not by `at` |

Every automatic read is tagged with the connection it was started for, which is how a
snapshot in flight across a revoke is told from one read after it.

### `useServerState(client, id, key?)`

```typescript
// → { status: 'loading' | 'ready' | 'revoked'; at?: string; value?: V; data?: D; write?: (input) => Promise<StateFrame> }
```

- Built on `useSyncExternalStore`: `subscribe` is `client.subscribe(id, key, cb)`,
  `getSnapshot` is `client.current(id, key)`, and the server snapshot is `undefined` — a
  server render is `'loading'` and opens nothing.
- The key is compared by its fields (stable-stringified), so `{ workspaceId }` written inline
  does not resubscribe on every render; another `workspaceId` unsubscribes and subscribes. A
  key never seen is `'loading'` until it has an entry; a key seen before shows its cached
  entry as `'ready'` until the reopen snapshot lands (entries are not evicted).
- `write` is typed only for a state with a write, bound to the hook's key. At runtime it is on
  every result — the type decides, so no render waits on the manifest — and on a state
  without a write it rejects naming the state.
- `react` (`^18 || ^19`) is an **optional peer** of `@spfn/core`: only `@spfn/core/state/react`
  imports it. `@spfn/core/state/client` is framework-neutral.

A page's first paint still comes from a server component reading the state's route with the
app's `api.` client; the hook takes over in the browser.

### Types

From `@spfn/core/state/client`: `createStateClient`, `StateClient<TStates>`,
`StateClientConfig`, `StateFrame<V, D>`, `StateEntry<V, D>` (a frame plus `status`, or
`{ status: 'revoked' }` alone), `StateListener`, `StateId`, `StateKeyArgs`, `WritableStateId`,
`StateCatalog`, `StateFrameOf`, `InferStateData`, and — re-exported type-only from the server
module — `InferStateValue`, `InferStateKey`, `InferStateInput`. From `@spfn/core/state/react`:
`useServerState`, `ServerState<TStates, Id>`.

---

## Out of scope

- Browser-only state (an open panel, a draft), session and network state.
- Optimistic updates: the client applies what the server read, never a guess.
- In the browser client: optimistic updates, offline queueing of writes, more than one SSE
  connection per client, WebSocket, and Next.js server components (a server component reads
  the route with the app's `api.` client as any other initial data).
- De-duplicating `read()` across subscribers of a per-subject keyed state (each subject has
  its own value; a shared key is read once).
- A route-level "refuse until state X is Y" gate.
