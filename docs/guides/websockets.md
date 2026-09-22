---
title: "WebSockets"
description: "Type-safe bidirectional WebSocket server with server-push events and client→server message handlers"
order: 15
available: true
---

# WebSockets

SPFN provides a type-safe WebSocket layer built on top of the existing event system. Unlike SSE (server→client only), WebSockets support bidirectional communication: the server can push events to clients, and clients can send messages to the server.

## SSE vs WebSocket

| | SSE | WebSocket |
|-|-----|-----------|
| Direction | Server → Client | Bidirectional |
| Browser API | `EventSource` | `WebSocket` |
| Protocol | HTTP/1.1 | ws:// / wss:// |
| Use case | Live feeds, notifications | Chat, presence, collaborative editing |

Use SSE when you only need server-push. Use WebSocket when clients need to send messages back.

## Installation

WebSocket support uses the `ws` package, declared as an **optional dependency** of
`@spfn/core` — a normal install already brings it in. Only if you installed with optional
dependencies disabled do you need to add it yourself:

```bash
pnpm add ws
```

## Define WS Router

```typescript
// src/server/ws.ts
import { defineWSRouter } from '@spfn/core/event/ws';
import { defineEvent } from '@spfn/core/event';
import { Type } from '@sinclair/typebox';

// Reuse existing events or define WS-specific ones
// (export them — the server emits through these same objects)
export const userUpdated = defineEvent('userUpdated', Type.Object({
    userId: Type.String(),
    name: Type.String(),
}));

export const notification = defineEvent('notification', Type.Object({
    message: Type.String(),
    level: Type.Union([Type.Literal('info'), Type.Literal('warning'), Type.Literal('error')]),
}));

export const wsRouter = defineWSRouter({
    events: { userUpdated, notification },  // server → client
    messages: {                              // client → server
        ping: ({ ws }) =>
        {
            ws.send('pong', {});
        },
        'chat.send': async ({ payload, subject, ws }) =>
        {
            // payload is unknown — validate manually
            const { text } = payload as { text: string };
            await broadcastChatMessage(subject!, text);
        },
    },
});

export type WSRouter = typeof wsRouter;
```

### `messages` handlers receive:

| Field | Type | Description |
|-------|------|-------------|
| `payload` | `unknown` | Message data sent by the client |
| `subject` | `string \| undefined` | Authenticated user ID (if auth enabled) |
| `ws` | `WSRawConnection` | Connection handle — `send(type, payload)` and `close(code, reason)` |

## Register with Server

```typescript
// server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { wsRouter } from './ws';

export default defineServerConfig()
    .routes(appRouter)
    .websockets(wsRouter)          // → WS at /ws
    .build();
```

### Custom path

```typescript
.websockets(wsRouter, {
    path: '/realtime',             // Custom endpoint (default: /ws)
    pingInterval: 30000,           // Keep-alive ping interval (default: 30s)
})
```

## Emit Events from Server

Emit events the same way as SSE — all connected clients subscribed to that event receive it:

```typescript
import { userUpdated, notification } from './ws';

// From a route handler, job, or anywhere
await userUpdated.emit({ userId: '123', name: 'Alice' });
await notification.emit({ message: 'Deployment complete', level: 'info' });
```

## Browser Client

```typescript
import { createWSClient } from '@spfn/core/event/ws/client';
import type { WSRouter } from '@/server/ws';

const client = createWSClient<WSRouter>();

// Subscribe — returns unsubscribe function
const unsubscribe = client.subscribe({
    events: ['userUpdated', 'notification'],
    handlers: {
        userUpdated: ({ userId, name }) =>
        {
            console.log(`User ${userId} updated: ${name}`);
        },
        notification: ({ message, level }) =>
        {
            console.log(`[${level}] ${message}`);
        },
    },
    onOpen: () => console.log('WebSocket connected'),
    onClose: () => console.log('WebSocket closed'),
    onError: (err) => console.error('WebSocket error', err),
    onReconnect: (attempt) => console.log(`Reconnecting... attempt ${attempt}`),
});

// Send message to server
client.send('ping', {});
client.send('chat.send', { text: 'Hello!' });

// Cleanup
unsubscribe();
```

### Multiple subscriptions

Multiple `subscribe()` calls share one underlying WebSocket connection. The connection closes only when all subscriptions are unsubscribed.

```typescript
const unsubA = client.subscribe({
    events: ['userUpdated'],
    handlers: { userUpdated: (p) => console.log('A', p) },
});

const unsubB = client.subscribe({
    events: ['notification'],
    handlers: { notification: (p) => console.log('B', p) },
});

unsubA(); // connection stays open — unsubB still active
unsubB(); // connection closes
```

If a new subscription requests events not yet on the server, the client reconnects automatically with the merged event list.

## Authentication

WebSocket connections cannot carry custom headers, so SPFN uses the same **Token Exchange** pattern as SSE:

1. Client calls the token endpoint with its normal auth → receives a one-time token
2. Client opens `ws://host/ws?events=...&token=...`
3. Server verifies **and consumes** the token, rejecting with 4001 if it is missing or invalid

The token endpoint path is **derived** from the WS path by replacing its last segment:
`/ws` → `POST /token`, `/realtime/ws` → `POST /realtime/token`. It is registered directly on
the Hono app with your app's named middleware applied — both the server-level
`.middlewares([...])` and the router's `.use([...])` — so whatever authenticates your routes
also authenticates token issuance.

Enable with `auth: { enabled: true }`:

```typescript
// server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { authenticate } from '@spfn/auth/server';

export default defineServerConfig()
    .middlewares([authenticate])
    .routes(appRouter)
    .websockets(wsRouter, {
        auth: { enabled: true },
    })
    .build();
```

### Acquire token in client

The token endpoint is registered directly on the backend server, **not** through the route
DSL — so it never appears in the generated route map and there is no `api.*` entry for it.
SSE ships `createAuthSSEClient` and an `eventRouteMap` for this; WebSocket has no
equivalent, so wire `acquireToken` yourself.

**Through the Next.js RPC proxy (recommended).** Add one entry to the proxy's route map —
the same thing `eventRouteMap` does for SSE:

```typescript
// app/api/rpc/[routeName]/route.ts
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { routeMap } from '@/generated/route-map';

export const { GET, POST } = createRpcProxy({
    routeMap: { ...routeMap, wsToken: { method: 'POST', path: '/token' } },
});
```

```typescript
const client = createWSClient<WSRouter>({
    acquireToken: async () =>
    {
        const res = await fetch('/api/rpc/wsToken', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),          // the proxy 400s on an empty body
        });
        const { token } = await res.json();

        return token;
    },
});
```

**Calling the backend directly.** Works when the browser can reach the backend origin and
carry its own credentials:

```typescript
const client = createWSClient<WSRouter>({
    acquireToken: async () =>
    {
        const res = await fetch(`${process.env.NEXT_PUBLIC_SPFN_API_URL}/token`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${getJwt()}` },
        });
        const { token } = await res.json();

        return token;
    },
});
```

> The WS **upgrade** path (`/ws`) is auto-skipped by proxy-guard, but the **token**
> endpoint is deliberately not — it mints credentials, so it stays guarded. Under
> `proxyGuard({ mode: 'strict' })` the direct call above is rejected; use the proxy route.

### Shared token manager with `@spfn/auth`

When using `@spfn/auth`, share the same token pool:

```typescript
import { createAuthLifecycle, getOneTimeTokenManager } from '@spfn/auth/server';

export default defineServerConfig()
    .lifecycle(createAuthLifecycle())
    .websockets(wsRouter, {
        auth: {
            enabled: true,
            tokenManager: () => getOneTimeTokenManager(),
        },
    })
    .build();
```

Pass a **lazy resolver** (`() => getOneTimeTokenManager()`), not the manager itself —
`getOneTimeTokenManager()` throws until `createAuthLifecycle()` has run. With the pool
shared, any token from auth's own endpoint also opens the socket, so `acquireToken` can be
`() => authApi.issueOneTimeToken.call().then(r => r.token)` (the generated route map holds
that route once the app router mounts `authRouter` with `.packages()`).

### Authorization

#### `authorize` — Subscription authorization (once on connect)

```typescript
.websockets(wsRouter, {
    auth: {
        enabled: true,
        authorize: async (subject, events) =>
        {
            const user = await usersRepository.findById(subject);
            if (user.role === 'admin') return events;
            return events.filter(e => !e.startsWith('admin'));
        },
    },
})
```

#### `filter` — Per-event payload filter (on every emission)

```typescript
.websockets(wsRouter, {
    auth: {
        enabled: true,
        filter: {
            userUpdated: (subject, payload) => payload.userId === subject,
        },
    },
})
```

## Close Codes

| Code | Reason |
|------|--------|
| `4000` | No valid event names in request |
| `4001` | Missing or invalid token |
| `4003` | Not authorized for any requested events |
| `1001` | Server shutting down |
| `1002` | Unparseable request URL |
| `1008` | `Origin` not in `allowedOrigins` |
| `1013` | At capacity — `maxConnections`, `maxConnectionsPerSubject`, or send-buffer overflow |
| `1011` | Internal server error during connection setup |

## API Reference

### `defineWSRouter(def)`

```typescript
defineWSRouter({
    events: Record<string, EventDef>,   // server → client events
    messages?: Record<string, WSMessageHandlerFn>,  // client → server handlers
})
```

### `createWSClient<TRouter>(config?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | string | `NEXT_PUBLIC_SPFN_API_URL` (ws://) | Backend WS host |
| `pathname` | string | `/ws` | WS endpoint pathname |
| `reconnect` | boolean | `true` | Auto reconnect on disconnect |
| `reconnectDelay` | number | `3000` | Reconnect delay (ms) |
| `maxReconnectAttempts` | number | `0` | Max attempts (0 = infinite) |
| `acquireToken` | `() => Promise<string>` | - | Token acquisition for auth |

### `WSClient` methods

| Method | Description |
|--------|-------------|
| `subscribe(options)` | Subscribe to events. Returns unsubscribe function |
| `send(type, payload)` | Send a message to the server |
| `getState()` | Returns current state: `'connecting' \| 'open' \| 'closed' \| 'error'` |
| `close()` | Permanently close the connection |

### `.websockets(router, config?)` options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `path` | string | `/ws` | WS endpoint path. Token endpoint replaces the last segment (`/ws` → `/token`) |
| `pingInterval` | number | `30000` | Keep-alive ping interval (ms). `0` to disable. A socket that misses a pong is terminated |
| `maxPayload` | number | `1048576` | Max inbound frame size (bytes) |
| `maxBufferedBytes` | number | `1048576` | Outbound buffer cap; over it the connection is closed with `1013` |
| `maxConnections` | number | `10000` | Global concurrent-connection cap |
| `maxConnectionsPerSubject` | number | `0` | Per-subject cap (`0` = unlimited) |
| `allowedOrigins` | string[] | - | `Origin` allow-list for the upgrade. Unset = no check |
| `auth.enabled` | boolean | `false` | Enable token authentication |
| `auth.tokenTtl` | number | `30000` | Token TTL (ms) |
| `auth.store` | SSETokenStore | Auto (Cache → InMemory) | Token store |
| `auth.tokenManager` | `SSETokenManager \| () => SSETokenManager` | - | External token manager |
| `auth.getSubject` | `(c) => string \| null` | `c.get('auth')?.userId` | Extract subject from Hono context |
| `auth.authorize` | `(subject, events) => events[]` | - | Subscription authorization hook |
| `auth.filter` | `{ [event]: (subject, payload) => boolean }` | - | Per-event payload filter |

## Related

- [Events](/docs/packages/core/event) — pub/sub event system and SSE streaming
- [Authentication](/docs/guides/authentication) — JWT auth and one-time tokens
