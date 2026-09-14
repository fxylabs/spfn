# @spfn/core/event — Decoupled pub/sub events + SSE streaming

In-memory pub/sub event system with TypeBox-typed payloads, optional cache-backed
multi-instance broadcast, job-queue fan-out, and Server-Sent Events (SSE) streaming to the
browser. A WebSocket variant shares the same event definitions.

## Import paths

There are **four** entry points. Picking the wrong one breaks the build (client code must
never pull the Hono handler; the handler must never pull the EventSource client).

```typescript
// Event definitions, router, route-map — isomorphic (define + emit + subscribe)
import { defineEvent, defineEventRouter, eventRouteMap } from '@spfn/core/event';

// Server SSE handler + token manager — SERVER ONLY (Hono, node:crypto)
import { createSSEHandler, SSETokenManager, CacheTokenStore } from '@spfn/core/event/sse';

// Browser SSE client — CLIENT ONLY (EventSource)
import { createSSEClient, createAuthSSEClient, subscribeToEvents } from '@spfn/core/event/sse/client';

// WebSocket router/handler/client — separate surface (see "WebSocket" below)
import { defineWSRouter } from '@spfn/core/event';          // or '@spfn/core/event/ws'
import { attachWSHandler } from '@spfn/core/event/ws';       // server
import { createWSClient } from '@spfn/core/event/ws/client'; // browser
```

> `createSSEClient` / `createAuthSSEClient` / `subscribeToEvents` live in
> `@spfn/core/event/sse/**client**` — **not** in `@spfn/core/event/sse`. The bare
> `@spfn/core/event/sse` is the server handler surface.

In practice you rarely call `createSSEHandler` directly — `defineServerConfig().events(router)`
mounts it for you (see [Server setup](#server-setup-via-defineserverconfig)).

---

## Public API (complete)

From `@spfn/core/event`:

- `defineEvent(name)` / `defineEvent(name, schema)` — define an event
- `defineEventRouter(events)` — group events for SSE
- `defineWSRouter({ events, messages? })` — group events + message handlers for WebSocket
- `eventRouteMap` — `{ eventsToken: { method: 'POST', path: '/events/token' } }` (merge into RPC proxy)
- Types: `EventDef`, `EventHandler`, `InferEventPayload`, `PubSubCache`, `JobQueueSender`,
  `EventRouterDef`, `InferEventNames`, `InferEventPayloads`,
  `InferRouterEventPayload` (the two-arg router variant — see note)

From `@spfn/core/event/sse`:

- `createSSEHandler(router, config?, tokenManager?)` — Hono GET handler
- `SSETokenManager` (class), `CacheTokenStore` (class)
- Types: `SSEToken`, `SSETokenStore`, `SSETokenManagerConfig`, `SSEMessage`,
  `SSEHandlerConfig`, `SSEHandlerAuthConfig`, `SSEAuthConfig`, `SSEClientConfig`,
  `SSEEventHandler`, `SSEEventHandlers`, `SSESubscribeOptions`, `SSEConnectionState`,
  `SSEUnsubscribe`

From `@spfn/core/event/sse/client`:

- `createSSEClient(config?)`, `createAuthSSEClient(config?)`, `subscribeToEvents(events, handlers, config?)`
- Type: `SSEClient`, `AuthSSEClientConfig`

From `@spfn/core/event/ws` / `@spfn/core/event/ws/client`: see [WebSocket](#websocket).

> **Two `InferEventPayload`s.** The name `InferEventPayload` exported from
> `@spfn/core/event` is the **single-arg** one (`InferEventPayload<typeof userCreated>` →
> payload of one event). The router module's **two-arg** version
> (`<Router, 'eventName'>`) is re-exported under the alias **`InferRouterEventPayload`** to
> avoid a clash. Inside the SSE types it is the two-arg form.
>
> **No such API.** There is no `event.on(...)`, no `event.publish(...)`, no
> `createEventBus()`, no `emitSync()`. The model is: `defineEvent` → `.subscribe()` /
> `.emit()` / `.useCache()`. SSE clients are created with `createSSEClient` /
> `createAuthSSEClient`, never `new EventSource` directly (that loses typing and token handling).

---

## Quick Start

```typescript
import { defineEvent } from '@spfn/core/event';
import { Type } from '@sinclair/typebox';

// 1. Define an event with a typed payload
export const userCreated = defineEvent('user.created', Type.Object({
    userId: Type.String(),
    email: Type.String(),
}));

// 2. Subscribe (in-memory) — returns an unsubscribe function
const unsubscribe = userCreated.subscribe((payload) =>
{
    // payload: { userId: string; email: string }
    console.log('User created:', payload.userId);
});

// 3. Emit — awaits all handlers
await userCreated.emit({ userId: '123', email: 'user@example.com' });

// 4. Cleanup
unsubscribe();
```

### Event without payload

```typescript
export const serverStarted = defineEvent('server.started'); // EventDef<void>

serverStarted.subscribe(() => console.log('started'));
await serverStarted.emit();   // emit() takes no argument when there is no schema
```

`emit` is typed off the payload: `() => Promise<void>` for void events, `(payload) =>
Promise<void>` otherwise. Handlers run via `Promise.allSettled` — see
[error isolation](#error-isolation).

---

## EventDef methods

`defineEvent` returns an `EventDef<TPayload>`:

| Member | Signature | Notes |
|--------|-----------|-------|
| `name` | `readonly string` | event name (e.g. `'user.created'`) |
| `schema` | `readonly TSchema?` | the TypeBox schema, if provided |
| `subscribe(handler)` | `(payload) => void \| Promise<void>` ⇒ returns `() => void` | in-memory; returns unsubscribe |
| `unsubscribeAll()` | `() => void` | drop all in-memory handlers |
| `emit(payload?)` | `Promise<void>` | fan-out to handlers (or cache) + job queues |
| `useCache(cache)` | `(PubSubCache) => Promise<EventDef>` | enable cross-instance broadcast (must `await`) |

> `_registerJobQueue` and `_payload` exist on the interface but are **internal** —
> `_registerJobQueue` is called by `@spfn/core/job` when a job does `.on(event)`; `_payload`
> is a type-inference carrier (always `undefined` at runtime). Don't call them.

---

## Server setup (via `defineServerConfig`)

To stream events to the browser, group them with `defineEventRouter` and register the
router on the server. `.events()` mounts the SSE handler — you don't call `createSSEHandler`
yourself.

```typescript
// src/server/events.ts
import { defineEvent, defineEventRouter } from '@spfn/core/event';
import { Type } from '@sinclair/typebox';

export const userCreated = defineEvent('user.created', Type.Object({
    userId: Type.String(),
    email: Type.String(),
}));
export const orderPlaced = defineEvent('order.placed', Type.Object({
    orderId: Type.String(),
    userId: Type.String(),
    amount: Type.Number(),
}));

export const eventRouter = defineEventRouter({ userCreated, orderPlaced });
export type EventRouter = typeof eventRouter;
```

```typescript
// server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { eventRouter } from './server/events';

export default defineServerConfig()
    .routes(appRouter)
    .jobs(jobRouter)
    .events(eventRouter)              // → GET /events/stream
    .build();

// Custom path + ping interval:
.events(eventRouter, {
    path: '/sse',                     // default: '/events/stream'
    pingInterval: 10000,              // keep-alive interval, ms (default: 10000 — under proxy idle timeouts)
})
```

`.events(router, config)` accepts `Omit<SSEHandlerConfig, 'auth'> & { path?, auth?:
SSEAuthConfig<TRouter> }`. The `auth` field is the **generic** `SSEAuthConfig<TRouter>` so
`authorize`/`filter` get full event-name and payload inference from your router.

`config` also carries the cross-pod transport knobs (see
[Multi-instance broadcast](#multi-instance-broadcast-cross-pod-fan-out)):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `multiInstance` | `boolean` | `true` | auto-wire Redis pub/sub when a cache is configured; `false` forces in-process |
| `channelPrefix` | `string` | env `SPFN_SSE_CHANNEL_PREFIX` or `spfn:sse:` | pub/sub channel prefix; set distinct prefixes to isolate apps sharing one Redis |

> `.websockets(router, config)` accepts the same `multiInstance` / `channelPrefix` knobs.
> Events shared by both routers are wired once.

> **Backpressure (`maxQueue`, default 1000).** Each connection's outbound frames go through a
> single drain loop that `await`s every write, so a slow client applies real backpressure
> instead of letting frames buffer unboundedly in memory. If the per-connection queue exceeds
> `maxQueue`, the connection is **closed** (the client reconnects) rather than dropping frames —
> dropping a chunk would corrupt an ordered token stream. Raise `maxQueue` for very bursty
> producers; lower it to cap memory more aggressively.

> `SSEHandlerConfig` also declares a `headers` field, but the current handler only reads
> `pingInterval`, `auth`, and `maxQueue`. Setting custom `headers` here is a no-op — set
> response headers in middleware instead.

---

## SSE authentication (Token Exchange)

The browser `EventSource` API cannot send custom headers, so a `Authorization: Bearer` JWT
can't ride along on the stream request. SPFN uses a **token exchange**: an authenticated
`POST /events/token` mints a one-time, short-TTL token; the stream request carries it as
`?token=...`.

```
Client                              Server
  │  POST /events/token (Bearer JWT) │  ← protected by config.middlewares (e.g. authenticate)
  │ ───────────────────────────────► │  getSubject(c) → issue one-time token
  │  ◄─────────────────────────────  │  { token: "..." }   (default TTL 30s)
  │  GET /events/stream?token=…&events=…
  │ ───────────────────────────────► │  verify+consume token (one-time)
  │                                   │  → authorize(subject, events)
  │  ◄═══════════════════════════════ │  SSE stream opens
  │  event: <name> / data: {…}        │  ← filter(subject, payload) per emission
```

Enable it with `auth: { enabled: true }`:

```typescript
import { defineServerConfig } from '@spfn/core/server';
import { authenticate } from '@spfn/auth/server';

export default defineServerConfig()
    .middlewares([authenticate])          // protects POST /events/token
    .routes(appRouter)
    .events(eventRouter, {
        auth: { enabled: true },
    })
    .build();
// → POST /events/token   (mints token; subject = c.get('auth').userId by default)
// → GET  /events/stream?token=…&events=…
```

The token endpoint path is **derived** from the stream path: `/events/stream` →
`/events/token`, `/sse` → `/token`. It is registered with your app's named middleware
applied — both the server-level `.middlewares([...])` and the router's `.use([...])` — so
whatever authenticates your routes also authenticates token issuance.

### Token store (multi-instance)

One-time tokens are stored. With `auth.enabled` and no explicit `store`, the server
auto-detects a cache at startup via `getCache()`:

| Environment | Store | How |
|-------------|-------|-----|
| No cache (`CACHE_URL` unset) | `InMemoryTokenStore` (Map) | automatic fallback |
| Cache connected | `CacheTokenStore` (Redis/Valkey, `SET EX` + `GETDEL`, prefix `sse:token:`) | auto-detected |
| Custom | your `SSETokenStore` impl | pass `auth.store` |

Manual / custom store:

```typescript
import { CacheTokenStore } from '@spfn/core/event/sse';
import { getCache } from '@spfn/core/cache';

.events(eventRouter, {
    auth: { enabled: true, store: new CacheTokenStore(getCache()!) },
})
```

```typescript
import type { SSETokenStore, SSEToken } from '@spfn/core/event/sse';

class DynamoTokenStore implements SSETokenStore
{
    async set(token: string, data: SSEToken): Promise<void> { /* ... */ }
    async consume(token: string): Promise<SSEToken | null> { /* one-time get+delete */ }
    async cleanup(): Promise<void> { /* remove expired */ }
}
```

### Sharing a token manager with `@spfn/auth`

If you already run `@spfn/auth`'s one-time-token system, hand SSE the **same** manager via
`tokenManager` instead of letting it create its own — both SSE and direct API calls then
draw from one token pool. Use a **lazy resolver** because `getOneTimeTokenManager()` only
exists after the auth lifecycle's `afterInfrastructure` runs:

```typescript
import { createAuthLifecycle, getOneTimeTokenManager } from '@spfn/auth/server';

export default defineServerConfig()
    .lifecycle(createAuthLifecycle())
    .events(eventRouter, {
        auth: {
            enabled: true,
            tokenManager: () => getOneTimeTokenManager(), // resolved at server start
        },
    })
    .build();
```

When `tokenManager` is provided, `store`/`tokenTtl` are ignored (the external manager owns them).

### Authorization hooks

Both hooks get full type inference from the router (no casting).

`authorize` — runs **once on connect**, decides which events the subject may subscribe to.
Return the allowed subset; an empty array ⇒ `403`.

```typescript
.events(eventRouter, {
    auth: {
        enabled: true,
        authorize: async (subject, events) =>
        {
            // events: ('userCreated' | 'orderPlaced')[] — inferred
            const user = await usersRepository.findById(subject);
            return user.role === 'admin' ? events : events.filter(e => !e.startsWith('admin.'));
        },
    },
})
```

`filter` — runs **per emission**, decides whether a given payload goes to this subject.
Return `false` to skip. Payload is typed per event.

```typescript
.events(eventRouter, {
    auth: {
        enabled: true,
        filter: {
            // payload: { orderId; userId; amount } — inferred
            orderPlaced: (subject, payload) => payload.userId === subject,
            // userCreated: omitted → delivered to all authorized subscribers
        },
    },
})
```

### SSE auth config (`SSEAuthConfig<TRouter>`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | turn on token auth |
| `tokenTtl` | `number` | `30000` | token TTL (ms) |
| `store` | `SSETokenStore` | auto (Cache → InMemory) | token storage backend |
| `tokenManager` | `SSETokenManager \| () => SSETokenManager` | — | reuse an external manager (lazy resolver recommended); overrides `store`/`tokenTtl` |
| `getSubject` | `(c: Context) => string \| null` | `c.get('auth')?.userId ?? null` | extract subject on the token endpoint |
| `authorize` | `(subject, events[]) => events[] \| Promise<…>` | — | subscription authorization (once on connect) |
| `filter` | `{ [event]?: (subject, payload) => boolean }` | — | per-event payload filter |

---

## Browser client

### `createSSEClient(config?)` — no auth

```typescript
import { createSSEClient } from '@spfn/core/event/sse/client';
import type { EventRouter } from '@/server/events';

// Defaults: NEXT_PUBLIC_SPFN_API_URL (or http://localhost:8790) + /events/stream
const client = createSSEClient<EventRouter>();

const unsubscribe = client.subscribe({
    events: ['userCreated', 'orderPlaced'], // names inferred from EventRouter
    handlers: {
        userCreated: (payload) => console.log('user', payload.userId),
        orderPlaced: (payload) => console.log('order', payload.orderId),
    },
    onOpen: () => console.log('connected'),
    onError: (err) => console.error(err),
    onReconnect: (attempt) => console.log('reconnect', attempt),
    onClose: () => console.log('closed for good'),
});

client.getState();  // 'connecting' | 'open' | 'closed' | 'error'
client.close();     // tear down the active connection
unsubscribe();      // same as close() for that subscription
```

`SSEClientConfig`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | `NEXT_PUBLIC_SPFN_API_URL` or `http://localhost:8790` | backend host |
| `pathname` | `string` | `/events/stream` | SSE endpoint path |
| `url` | `string` | — | **deprecated**; full URL overriding host+pathname |
| `reconnect` | `boolean` | `true` | auto-reconnect on drop |
| `reconnectDelay` | `number` | `3000` | delay between attempts (ms) |
| `maxReconnectAttempts` | `number` | `0` | `0` = infinite |
| `withCredentials` | `boolean` | `false` | send cookies with the EventSource request |
| `acquireToken` | `() => Promise<string>` | — | mint a token before each (re)connect; appended as `?token=…` |

### `createAuthSSEClient(config?)` — with auth (recommended)

Wraps `createSSEClient` and wires `acquireToken` to fetch a one-time token from the RPC
proxy automatically on every (re)connect.

```typescript
import { createAuthSSEClient } from '@spfn/core/event/sse/client';
import type { EventRouter } from '@/server/events';

const client = createAuthSSEClient<EventRouter>(); // POSTs /api/rpc/eventsToken under the hood

client.subscribe({
    events: ['userCreated'],
    handlers: { userCreated: (p) => console.log(p) },
});
```

`AuthSSEClientConfig` = `Omit<SSEClientConfig, 'acquireToken'>` plus `rpcBaseUrl` (default
`/api/rpc`). It requires `eventRouteMap` merged into your RPC proxy so `eventsToken`
resolves to `POST /events/token`. That token request is a cookie-authenticated POST
through the proxy, so `@spfn/auth`'s CSRF rule applies to it: the client mirrors the
readable `spfn_csrf` cookie family into the `x-spfn-csrf` header, the way the api
client does, so the stream opens under `SPFN_AUTH_CSRF=enforce` too. A custom
`acquireToken` passed to `createSSEClient` has to send that header itself
(`csrfHeaderValue` and `documentCookieEntries` from `@spfn/core/nextjs` build it).

```typescript
// app/api/rpc/[routeName]/route.ts
import '@spfn/auth/nextjs/api';
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { eventRouteMap } from '@spfn/core/event';
import { routeMap } from '@/generated/route-map';

export const { GET, POST } = createRpcProxy({
    routeMap: { ...routeMap, ...eventRouteMap },
});
```

### `subscribeToEvents(events, handlers, config?)` — one-shot helper

```typescript
import { subscribeToEvents } from '@spfn/core/event/sse/client';
import type { EventRouter } from '@/server/events';

const unsubscribe = subscribeToEvents<EventRouter>(
    ['userCreated'],
    { userCreated: (payload) => console.log(payload) },
    { host: 'https://api.example.com' }, // optional SSEClientConfig
);
```

It creates a throwaway client and subscribes once. For auth, prefer `createAuthSSEClient`
(this helper takes a plain `SSEClientConfig`, so you'd have to wire `acquireToken` yourself).

---

## Multi-instance broadcast (cross-pod fan-out)

By default `emit` only reaches handlers in the **same process**. Across multiple pods, an
`emit` on the pod that handles the chat POST must still reach the SSE stream pinned to a
**different** pod — otherwise the stream silently stalls.

**This is automatic.** When a cache is configured (`CACHE_URL` / `getCache()` returns a
client), `.events(router)` and `.websockets(router)` wire every event to a Redis/Valkey
pub/sub transport at startup. No code change in your app — register the router as usual and
multi-pod fan-out just works. Without a cache it is a no-op and events stay in-process, so a
single pod (or local dev) behaves exactly as before.

```typescript
export default defineServerConfig()
    .events(eventRouter)          // CACHE_URL set → cross-pod fan-out; unset → in-process
    .build();

// Force in-process even when a cache is present, or set an isolation prefix:
.events(eventRouter, {
    multiInstance: false,         // default true
    channelPrefix: 'my-app:',     // default: env SPFN_SSE_CHANNEL_PREFIX, else 'spfn:sse:'
})
```

Mechanics (from `event.ts`): once a cache is wired, `emit` calls `cache.publish(name,
payload)` **instead of** triggering local handlers directly — local handlers (including the
SSE stream on the same pod) fire when the message comes back through the pub/sub `subscribe`
callback. Auth `filter` still runs per-subscriber on the **receiving** pod's SSE handler —
the transport only fans out by event name. Job queues receive the payload on every emit
regardless of cache.

> **Process-global.** `multiInstance` and `channelPrefix` are resolved **once per process**
> (first `.events()`/`.websockets()` wiring wins); a second router can't change them. That's
> correct because one process serves one app. An event shared by both routers is wired once.
>
> **Payloads must be JSON-serializable** when fan-out is on (they cross Redis as JSON). A
> `Date` arrives as an ISO string; a void event arrives as `null` on remote pods (vs
> `undefined` in-process). `bigint`/circular payloads can't serialize — see degrade below.
>
> **Ordering needs sequential `await` _and_ healthy publishes.** Per-channel order is preserved
> end-to-end only if the producer awaits each emit in turn (`for (const c of chunks) await
> event.emit(c)`). Fire-and-forget (`chunks.forEach(c => event.emit(c))`) races the publishes
> and can reorder a token stream. Also: a mid-stream publish **failure** delivers its event via
> the synchronous local fallback, which can land ahead of an earlier successful emit whose echo
> is still in flight — so a Redis blip mid-stream may reorder relative to in-flight emits. The
> transport adds no sequence number; if strict order matters across failures, carry one in the
> payload and reorder on the client.
>
> **Channel isolation & receive-side trust.** The default prefix `spfn:sse:` is shared by every
> SPFN app, so apps sharing **one** Redis with a colliding event name would cross-talk. Set
> `channelPrefix` / `SPFN_SSE_CHANNEL_PREFIX` per app (the server logs a WARN at startup if
> you're on the default); separate `CACHE_URL`s per app are isolated already. Note the receiving
> pod does **not** re-validate a payload against the event schema before delivering it to
> `filter`/handlers — anything with Redis access can publish to a channel, so treat Redis access
> as a trust boundary (same level as the one-time-token store).

**Degrade**: SSE is lossy (at-most-once). If a publish can't reach Redis (a blip) or the
payload can't serialize, the event is **still delivered to this pod's own subscribers**
(local fallback) and logged; only **remote** pods miss it. The same local fallback covers the
asymmetric case where the publish succeeds but **this pod's subscriber socket is down** (its
echo — the only path to same-pod streams — wouldn't arrive). A sustained publish outage trips
a short circuit breaker so emits fast-path to local instead of each paying the publish timeout.
A publish never crashes `emit` or kills a stream. ioredis auto-reconnects and re-subscribes
(autoResubscribe, default true). A per-event SUBSCRIBE failure at
startup degrades that event to in-process (logged) rather than aborting boot. Same-pod
delivery costs one Redis round-trip — for a single-replica deploy with a cache, prefer
`multiInstance: false` to skip it.

### Manual `useCache` (advanced)

You rarely need this — the server wires it for you. `EventDef.useCache(cache)` is the
underlying primitive if you drive events outside `defineServerConfig` (e.g. a worker). The
`PubSubCache` shape it expects:

```typescript
import { getCache } from '@spfn/core/cache';

const cache = getCache();
if (cache)
{
    await userCreated.useCache({
        publish: async (channel, message) =>
        {
            await cache.publish(channel, JSON.stringify(message));
        },
        subscribe: async (channel, handler) =>
        {
            const sub = cache.duplicate();
            await sub.subscribe(channel);
            sub.on('message', (ch, msg) =>
            {
                if (ch === channel) handler(JSON.parse(msg));
            });
        },
    });
}

await userCreated.emit({ userId: '123', email: 'a@b.com' }); // broadcasts to all instances
```

**`await` `useCache` before emitting** — it must finish subscribing first. A direct second
call on the same `EventDef` logs `Cache already configured` and is ignored. (Separately, the
server's auto-wiring dedups by **event name** across the SSE and WS routers — tracked in the
transport, so a shared event's `useCache` is invoked only once and the warn never fires.)

---

## Job integration

A job subscribing to an event with `.on(event)` registers itself on the event's job queue;
the event's `emit` then enqueues the payload to every such queue (in addition to in-memory
handlers / cache broadcast).

```typescript
import { defineEvent } from '@spfn/core/event';
import { job, defineJobRouter } from '@spfn/core/job';
import { Type } from '@sinclair/typebox';

export const orderPlaced = defineEvent('order.placed', Type.Object({
    orderId: Type.String(),
    userId: Type.String(),
}));

export const sendConfirmation = job('send-order-confirmation')
    .on(orderPlaced)                          // payload type inferred from the event
    .handler(async (payload) => emailService.send(payload.orderId));

export const updateInventory = job('update-inventory')
    .on(orderPlaced)
    .handler(async (payload) => inventoryService.reserve(payload.orderId));

export const jobRouter = defineJobRouter({ sendConfirmation, updateInventory });

await orderPlaced.emit({ orderId: 'ord-1', userId: 'u-1' }); // both jobs enqueue
```

One emit fans out to in-memory handlers, the SSE stream, and every subscribed job queue —
fully decoupled.

---

## Pitfalls & anti-patterns

- **Wrong import depth for the client.** `createSSEClient` / `createAuthSSEClient` /
  `subscribeToEvents` are in `@spfn/core/event/sse/**client**`, not `@spfn/core/event/sse`.
  The bare `/sse` is the server (Hono) surface; importing it into the browser pulls server code.
- **`useCache` not awaited before `emit`.** `useCache` is async (it subscribes to the
  channel). Emitting before it resolves can drop the very first cross-instance events. Always
  `await event.useCache(...)` first.
- **Calling `useCache` twice.** A second call logs `Cache already configured for event: …`
  and is ignored. Configure the cache once per event instance (typically at startup).
- **Emitting before subscribing (in-memory).** `subscribe` registers a handler set; an
  `emit` that runs before any `subscribe` simply has no handlers. Register handlers / jobs at
  startup, not lazily after the first emit.
- **`auth.headers`/`SSEHandlerConfig.headers` does nothing.** The handler reads only
  `pingInterval`, `auth`, and `maxQueue`. Don't expect custom response headers from config.
- **A slow client is dropped, not buffered forever.** Writes are bounded (`maxQueue`, default
  1000): if a client can't keep up with a fast producer, its connection is closed instead of
  growing memory without limit. Expect occasional reconnects under heavy streaming to slow
  clients; that's the backpressure working, not a bug.
- **Don't `new EventSource(...)` by hand.** You lose type inference, the `connected`/`ping`
  control-event handling, one-time-token reconnect, and StrictMode-safe teardown that the
  client implements. Use `createSSEClient` / `createAuthSSEClient`.
- **Token-auth + browser auto-retry.** A one-time token is consumed on first use, so the
  browser's built-in EventSource retry would reconnect with a dead token. The client handles
  this: on error with `acquireToken` set, it closes and reconnects through its own path to
  mint a fresh token. Don't disable `reconnect` expecting native retry to work with auth.
- **Stream-time errors aren't subscription errors.** `authorize` returning `[]` ⇒ `403` at
  connect; invalid event names ⇒ `400`; missing/expired token ⇒ `401`. `onError` on the
  client fires for transport-level drops, not for these HTTP rejections — check the network
  response when a connection never opens.
- **Subject default.** Without a custom `getSubject`, the token endpoint reads
  `c.get('auth')?.userId`. If your auth middleware stores the user elsewhere, supply
  `getSubject` or token issuance returns `401`.
- **One subscription per client.** `createSSEClient(...).subscribe(...)` supersedes any
  previous subscription on that client (the prior connection is closed). For independent
  streams, create separate clients.
- **`SSETokenManager` keeps a cleanup timer.** It runs an `unref`'d interval; the in-memory
  store needs it to expire tokens. If you construct a manager manually (outside the server),
  call `destroy()` on shutdown. The Redis-backed `CacheTokenStore` relies on TTL and its
  `cleanup()` is a no-op.

---

## WebSocket (bidirectional variant)

For client→server messages in addition to server→client push, use a WS router. It reuses
the same `defineEvent` definitions and shares the SSE token manager / auth model.

```typescript
// server
import { defineWSRouter } from '@spfn/core/event';     // also re-exported from /event/ws
import { attachWSHandler } from '@spfn/core/event/ws';

export const wsRouter = defineWSRouter({
    events: { userUpdated, notification },               // server → client push
    messages: {                                          // client → server handlers
        ping: ({ ws }) => ws.send('pong', {}),
        'chat.send': ({ payload, subject }) => handleChat(payload, subject),
    },
});
export type WSRouter = typeof wsRouter;

// usually mounted via defineServerConfig().websockets(wsRouter)
```

```typescript
// browser
import { createWSClient } from '@spfn/core/event/ws/client';
import type { WSRouter } from '@/server/ws';

const client = createWSClient<WSRouter>();
client.subscribe({ events: ['userUpdated'], handlers: { userUpdated: (p) => {} } });
client.send('ping', {});
```

`WSRouterDef` extends `EventRouterDef` with a `messages` map. Message handlers receive
`{ payload, subject?, ws }` (`WSMessageContext`). See `@spfn/core/event/ws` exports for
`WSHandlerConfig`, `WSAuthConfig`, `WSClientConfig`, etc.

### Resource limits & backpressure (`WSHandlerConfig`)

The WS server is hardened like the SSE path — a slow or dead client cannot exhaust memory
or connection slots:

| Option | Default | Effect |
|---|---|---|
| `maxPayload` | `1048576` (1 MiB) | Max inbound frame size; larger frames are rejected by `ws` before they are buffered/parsed. |
| `maxBufferedBytes` | `1048576` (1 MiB) | Backpressure cap — if a connection's outbound buffer (`bufferedAmount`) exceeds this, the connection is closed with `1013` instead of buffering more (no OOM from a slow consumer). The client reconnects and re-subscribes. |
| `maxConnections` | `10000` | Global concurrent-connection cap; connections beyond it are rejected with `1013`. |
| `maxConnectionsPerSubject` | `0` (unlimited) | Per-authenticated-subject connection cap. |

Keep-alive also tracks **pongs**: a socket that doesn't answer a ping by the next
`pingInterval` tick is `terminate()`d, so half-open connections (sleeping device, NAT drop)
are reaped instead of lingering with their subscriptions and buffers.

---

## Types reference

```typescript
interface EventDef<TPayload = void> {
    readonly name: string;
    readonly schema?: TSchema;
    subscribe: (handler: EventHandler<TPayload>) => () => void;
    unsubscribeAll: () => void;
    emit: TPayload extends void ? () => Promise<void> : (payload: TPayload) => Promise<void>;
    useCache: (cache: PubSubCache) => Promise<EventDef<TPayload>>;
}

type EventHandler<TPayload> = (payload: TPayload) => void | Promise<void>;
type InferEventPayload<TEvent> = TEvent extends EventDef<infer P> ? P : never; // single-arg

interface PubSubCache {
    publish(channel: string, message: unknown): Promise<void>;
    subscribe(channel: string, handler: (message: unknown) => void | Promise<void>): Promise<void>;
}
type JobQueueSender = (queueName: string, payload: unknown) => Promise<void>;

interface EventRouterDef<TEvents> {
    readonly events: TEvents;
    readonly eventNames: (keyof TEvents)[];
    readonly _types: { [K in keyof TEvents]: TEvents[K]['_payload'] };
}
type InferEventNames<T>     = /* keyof router events as string union */;
type InferEventPayloads<T>  = T['_types'];
// router two-arg payload, exported as `InferRouterEventPayload`:
type InferRouterEventPayload<T, K> = T['_types'][K];

interface SSEMessage<TEvent extends string = string, TPayload = unknown> {
    event: TEvent; data: TPayload; id?: string;
}
type SSEConnectionState = 'connecting' | 'open' | 'closed' | 'error';

interface SSEToken { token: string; subject: string; expiresAt: number; }
interface SSETokenStore {
    set(token: string, data: SSEToken): Promise<void>;
    consume(token: string): Promise<SSEToken | null>; // one-time get+delete
    cleanup(): Promise<void>;
}
```

## Related

- [@spfn/core/job](../job/README.md) — background jobs that subscribe to events via `.on()`
- [@spfn/core/cache](../cache/README.md) — Redis/Valkey backing for multi-instance broadcast + token store
- [@spfn/core/server](../server/README.md) — `defineServerConfig().events()` / `.websockets()`
- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
