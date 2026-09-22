# @spfn/core/nextjs — Type-safe Next.js RPC client + proxy

End-to-end type-safe API client (`createApi<AppRouter>()`) and an RPC proxy route handler
(`createRpcProxy`) that bridges a Next.js App Router app to a SPFN `define-route` backend.
No per-route metadata codegen is required for the client — method/path resolution happens
at the proxy from a generated `routeMap`.

```
Client (browser / RSC)                Proxy (Next.js API route)         SPFN backend
  api.getUser.call({...})  ──GET/POST──▶  /api/rpc/{routeName}  ──HTTP──▶  resolved method+path
  createApi<AppRouter>()                  createRpcProxy({ routeMap })      define-route handler
```

## Import paths

There are **two** entry points. Picking the wrong one breaks the build — `/server` pulls in
`next/headers` + `next/server` and must never reach a Client Component bundle.

```typescript
// Client-safe (Client Components, Server Components, anywhere). NO next/headers.
import { createApi, ApiError } from '@spfn/core/nextjs';

// Server-only (API routes, Server Components). Uses next/headers + next/server.
import { createRpcProxy, registerInterceptors } from '@spfn/core/nextjs/server';
```

`createRpcProxy` and the interceptor registry are **only** exported from
`@spfn/core/nextjs/server`. `createApi` / `ApiError` are **only** exported from
`@spfn/core/nextjs`. There is no barrel that re-exports both.

| Path | Environment | Exports |
|------|-------------|---------|
| `@spfn/core/nextjs` | Client + Server | `createApi`, `ApiError`, all client types |
| `@spfn/core/nextjs/server` | Server only | `createRpcProxy`, interceptor registry + helpers, interceptor types |

---

## Public API (complete)

From `@spfn/core/nextjs` (client-safe):

- Values: `createApi`, `ApiError`
- Types: `Client`, `RouteClient`, `ApiConfig`, `CallOptions`, `InferRouteInput`,
  `InferRouteOutput`, `RouterInput`, `RouterOutput`, `StructuredInput`,
  `RequestInterceptor`, `ResponseInterceptor`, `CookieOptions`, `SetCookie`

From `@spfn/core/nextjs/server` (server-only):

- Values: `createRpcProxy`, `registerInterceptors`, `interceptorRegistry`, `matchPath`,
  `matchMethod`, `filterMatchingInterceptors`, `executeRequestInterceptors`,
  `executeResponseInterceptors`
- Types: `RpcProxyConfig`, `RequestInterceptorContext`, `ResponseInterceptorContext`,
  `RequestInterceptor`, `ResponseInterceptor` (the *proxy* `(ctx, next)` shape — distinct
  from the client interceptor types of the same name), `InterceptorRule`, `ProxyConfig`

> The client `RequestInterceptor`/`ResponseInterceptor` (`(url, init)` / `(response, body)`)
> and the proxy `RequestInterceptor`/`ResponseInterceptor` (`(ctx, next) => Promise<void>`)
> are **different types that share a name** across the two entry points. Don't cross them.

---

## Quick Start

### 1. Define the router (server)

```typescript
// server/router.ts
import { defineRouter, route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';

export const appRouter = defineRouter({
    getUser: route.get('/users/:id')
        .input({ params: Type.Object({ id: Type.String() }) })
        .handler(async (c) => {
            const { params } = await c.data();
            return { id: params.id, name: 'John' };
        }),

    createUser: route.post('/users')
        .input({ body: Type.Object({ name: Type.String() }) })
        .handler(async (c) => {
            const { body } = await c.data();
            return { id: '2', name: body.name };
        }),
});

export type AppRouter = typeof appRouter;
```

### 2. Create the client (no metadata needed)

```typescript
// lib/api.ts
import { createApi } from '@spfn/core/nextjs';
import type { AppRouter } from '@/server/router';

export const api = createApi<AppRouter>();
```

### 3. Mount the proxy route

```typescript
// app/api/rpc/[routeName]/route.ts
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { routeMap } from '@/generated/route-map';

export const { GET, POST } = createRpcProxy({ routeMap });
```

### 4. Call it

```typescript
const user = await api.getUser.call({ params: { id: '123' } });    // GET  /api/rpc/getUser?input=...
const created = await api.createUser.call({ body: { name: 'A' } }); // POST /api/rpc/createUser
```

---

## Client — `createApi`

```typescript
function createApi<TRouter extends Router<any>>(config?: ApiConfig): Client<TRouter>;
```

Returns a `Proxy`: every property access (`api.getUser`) yields a `RouteClient` builder.
Calls are made via `.call(input)`.

The client is one **flat** namespace, holding exactly the names the server registers. A
route declared inside a nested `defineRouter` is reached by its own key — `registerRoutes`
mounts it under that key, the proxy resolves that name against the route map, and
`RouterOutput` takes the same name:

```typescript
const appRouter = defineRouter({
    getRoot,
    users: defineRouter({ getUser }),
});

await api.getUser.call({ params: { id: '123' } });   // ✅ GET /api/rpc/getUser
await api.users.getUser.call({ ... });               // ❌ compile error — `users` is a group
```

There is no dot notation: a property access never yields another proxy, so a group key
names nothing on either side. A name two branches both declare is left out of the client
rather than resolved to one of them, and `.packages()` routes stay out on purpose — call
them through the package's own client (`authApi`, `cmsApi`).

### Structured input

Input mirrors the route's `.input({...})` definition exactly. Empty sections are omitted
from the type, so you only pass what the route declares:

```typescript
await api.getUser.call({ params: { id: '123' } });
await api.getUser.call({ params: { id: '123' }, query: { include: 'posts' } });
await api.createUser.call({ body: { name: 'John', email: 'a@b.com' } });
await api.updateUser.call({ params: { id: '123' }, body: { name: 'Jane' } });

// Route with no required input → call() with no argument:
await api.listAll.call();
```

### Method detection (client → proxy URL)

The client picks the HTTP method to the **proxy** purely from input shape:

- Has `body` **or** non-empty `formData` → `POST /api/rpc/{routeName}` (JSON body, or
  `multipart/form-data` when `formData` is present)
- Otherwise → `GET /api/rpc/{routeName}?input={encoded}` (browser-cacheable)

This is the method to the proxy only. The *actual* backend method (PUT/PATCH/DELETE/…) is
resolved by the proxy from `routeMap` — see below.

### File upload (`formData`)

```typescript
await api.uploadAvatar.call({
    params: { id: '123' },
    formData: { file: fileInput.files[0], description: 'Profile photo' },
});
```

`File` / `File[]` values go into a `FormData`; the other sections (`params`, `query`,
`headers`, `cookies`) are bundled into a `__metadata` JSON part. The proxy unpacks
`__metadata` and forwards a clean `multipart/form-data` body to the backend. `Content-Type`
is left unset so the boundary is generated automatically.

### Options via method chaining

Options are set fluently (each returns a cloned builder) and applied on `.call()`:

```typescript
const user = await api.getUser
    .headers({ 'X-Custom': 'value' })
    .cookies({ session: 'xxx' })
    .fetchOptions({ next: { revalidate: 60 } })
    .onRequest((url, init) => init)                       // client RequestInterceptor
    .onResponse((res, body) => ({ response: res, body })) // client ResponseInterceptor
    .call({ params: { id: '123' } });
```

### `ApiConfig`

```typescript
interface ApiConfig {
    baseUrl?: string;                              // default '/api/rpc'
    headers?: Record<string, string>;             // default headers on every request
    timeout?: number;                              // default env.SERVER_TIMEOUT (120000 ms)
    fetch?: typeof fetch;                          // custom fetch impl
    onRequest?: RequestInterceptor;                // global, (url, init) => init
    onResponse?: ResponseInterceptor;              // global, (response, body) => { response, body }
    errorRegistry?: ErrorRegistry | ErrorRegistryInput[]; // custom error deserialization
    debug?: boolean;                               // default false
}
```

`errorRegistry`: the core `errorRegistry` is **always** merged in automatically. Pass an
array to add your app/package error registries on top:

```typescript
import { errorRegistry } from '@spfn/core/errors';
const api = createApi<AppRouter>({ errorRegistry: [errorRegistry, authErrorRegistry] });
```

### `CallOptions` (per-call, also settable via chaining)

```typescript
interface CallOptions {
    timeout?: number;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;   // override only; cookies are auto-forwarded otherwise
    onRequest?: RequestInterceptor;
    onResponse?: ResponseInterceptor;
    fetchOptions?: RequestInit & { next?: { revalidate?: number | false; tags?: string[] } };
}
```

### Automatic cookie forwarding (SSR)

When `createApi` runs **on the server** (RSC / route handler) it auto-detects request
cookies via `next/headers` `cookies()` and forwards them as the `Cookie` header. In the
browser, cookies are sent by the browser automatically. You only need `.cookies({...})` /
`options.cookies` to **override**. Outside a request context (static generation, build) the
cookie read silently yields none.

### SSR base URL resolution

For absolute fetches on the server the client uses `env.SPFN_APP_URL`. If unset, it falls
back to reconstructing the origin from the incoming request's `host` /
`x-forwarded-proto` headers (via `next/headers`); failing that, it uses a relative URL.

---

## Proxy — `createRpcProxy`

```typescript
function createRpcProxy(config: RpcProxyConfig): {
    GET: (req, ctx) => Promise<NextResponse>;
    POST: (req, ctx) => Promise<NextResponse>;
};
```

Returns `{ GET, POST }` handlers for an App Router catch-all route. It:

1. Reads `routeName` from the async `params` (`context.params: Promise<{ routeName?: string }>` — Next.js 15).
2. Parses `input` from `?input=` (GET) or the JSON / `multipart/form-data` body (POST).
3. Resolves `routeMap[routeName]` → `{ method, path }`; **404** if missing.
4. Substitutes `:params` into `path`, appends the query string.
5. Forwards to `${apiUrl}${path}${query}` with the resolved backend method, running matching
   interceptors before/after.
6. Wraps the backend response in a `NextResponse` (special-casing `204`), forwards response
   headers, and appends any `Set-Cookie` pushed by interceptors.

### `RpcProxyConfig`

```typescript
interface RpcProxyConfig {
    routeMap: RouteMap;                         // REQUIRED — Record<routeName, { method, path }>
    apiUrl?: string;                            // default env.SPFN_API_URL || 'http://localhost:8790'
    timeout?: number;                           // default env.RPC_PROXY_TIMEOUT (120000 ms); AbortController
    debug?: boolean;                            // default env.NODE_ENV === 'development'
    headers?: Record<string, string>;           // added to every forwarded request
    interceptors?: InterceptorRule[];           // inline interceptors (array, NOT { request, response })
    autoDiscoverInterceptors?: boolean;          // default true — pull from registry
    disableAutoInterceptors?: string[];          // e.g. ['auth'] — exclude registered packages
    proxySecret?: string;                        // default env.SPFN_PROXY_SECRET — HMAC-sign forwarded requests (proxy-guard)
}

interface RouteMapEntry { method: HttpMethod; path: string; }
type RouteMap = Record<string, RouteMapEntry>;
```

### `routeMap` — the proxy's source of truth

`routeMap` comes from codegen (`@/generated/route-map`) and already holds the routes of every
package router the app router mounts with `.packages()` — `@spfn/auth`'s included, so
`{ ...routeMap, ...authRouteMap }` is a no-op and no longer needed. `eventRouteMap` is still
merged by hand: it is a hand-written constant, not a mounted router.

```typescript
// app/api/rpc/[routeName]/route.ts
import '@spfn/auth/nextjs/api';                 // side-effect: registers auth interceptors
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { eventRouteMap } from '@spfn/core/event';
import { routeMap } from '@/generated/route-map';

export const { GET, POST } = createRpcProxy({
    routeMap: { ...routeMap, ...eventRouteMap },
});
```

A `routeName` absent from `routeMap` returns **404** from the proxy (not from the backend).
After adding routes — or after upgrading a mounted package — re-run codegen and clear `.spfn`
cache if stale.

### Header forwarding & client IP

Request headers are forwarded to the backend by an **allowlist**, not copied wholesale. Only
`content-type`, `authorization`, `cookie`, `user-agent`, `accept`, `accept-language`, and
`origin` pass through; everything else on the inbound request is dropped.

`X-Forwarded-For` is **not** in that allowlist, so it is not forwarded verbatim. Instead the
proxy resolves the real client IP from the inbound `X-Forwarded-For` chain — hop-aware, taking
the rightmost `TRUSTED_PROXY_HOPS` (default `1`) entries as your own trusted infra — and
re-emits that single address under a dedicated header, `x-spfn-proxy-client-ip`. This avoids
passing a client-controllable header straight through to the backend.

The backend only **trusts** that header on requests it can prove came through this proxy. Set
the same **`SPFN_PROXY_SECRET`** on the proxy (or `proxySecret` in config) and on the backend:
the proxy then HMAC-signs each forwarded request and the backend's proxy-guard marks it
verified (`clientType ≠ 'untrusted'`), so `getClientIp(c)` returns the real visitor IP from
`x-spfn-proxy-client-ip`. See [@spfn/core/middleware](../middleware/README.md) proxy-guard +
`getClientIp`.

Without a shared secret the request is unsigned, the backend won't trust that header, and
`getClientIp` falls back to the raw `X-Forwarded-For` first hop — which the proxy didn't
forward, so the client IP collapses to the TCP peer or `'unknown'`. If your visitor IP is
missing in production, set `SPFN_PROXY_SECRET` on both sides (and match `TRUSTED_PROXY_HOPS`
to your LB/nginx depth) rather than widening the header allowlist — forwarding raw
`X-Forwarded-For` reintroduces a spoofable IP.

### Full config example

```typescript
export const { GET, POST } = createRpcProxy({
    routeMap: { ...routeMap, ...eventRouteMap },
    apiUrl: process.env.SPFN_API_URL,
    timeout: 60000,
    debug: true,
    headers: { 'X-API-Key': process.env.SPFN_API_KEY! },
    interceptors: [
        {
            pathPattern: '/_auth/*',
            method: 'POST',
            response: async (ctx, next) => {
                if (ctx.response.body?.token) {
                    ctx.setCookies.push({
                        name: 'session',
                        value: ctx.response.body.token,
                        options: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 86400 },
                    });
                }
                await next();
            },
        },
    ],
    autoDiscoverInterceptors: true,
    disableAutoInterceptors: ['analytics'],
});
```

---

## Interceptors (proxy-side)

Proxy interceptors run **inside the proxy route**, around the backend fetch. They use a
middleware `(ctx, next)` signature and are matched by path/method. Do not confuse them with
the client `onRequest`/`onResponse` hooks (those run in the calling code, on the proxy URL).

### `InterceptorRule`

```typescript
interface InterceptorRule {
    pathPattern: string | RegExp;     // '/_auth/*' | '/users/:id' | /regex/ | '*' (matches the BACKEND path)
    method?: string | string[];        // 'POST' | ['POST','PUT'] | omit = all
    request?: (ctx: RequestInterceptorContext, next: () => Promise<void>) => Promise<void>;
    response?: (ctx: ResponseInterceptorContext, next: () => Promise<void>) => Promise<void>;
}
```

Pattern matching: `'*'` matches all; a `RegExp` is tested directly; a string converts `*`→
`.*` and `:param`→`[^/]+`. The path matched is the **resolved backend path** (e.g.
`/users/123`), not `/api/rpc/...`.

### Contexts

```typescript
interface RequestInterceptorContext {
    path: string; method: string;
    headers: Record<string, string>;          // mutable — written back to forwarded headers
    body?: any;                                // mutable — re-stringified if changed
    query: Record<string, string | string[]>;
    cookies: Map<string, string>;             // request cookies
    request: NextRequest;
    metadata: Record<string, any>;            // shared with the response interceptor
}

interface ResponseInterceptorContext {
    path: string; method: string;
    request: { headers: Record<string, string>; body?: any };
    response: { ok: boolean; status: number; statusText: string; headers: Headers; body: any }; // body mutable
    cookies: Map<string, string>;             // read-only
    setCookies: SetCookie[];                  // push to emit Set-Cookie on the NextResponse
    metadata: Record<string, any>;
}
```

Interceptors chain in registration order; each must `await next()` to continue (skip it to
short-circuit). Mutating `ctx.headers` / `ctx.body` (request) and `ctx.response.body` /
`ctx.setCookies` (response) is how you affect the forwarded request and returned response.

### Package auto-registration

Packages register interceptors on import; the proxy auto-discovers them
(`autoDiscoverInterceptors: true`). The registry lives on `globalThis` to survive HMR and
de-dupes by package name.

```typescript
// inside a package, on import
import { registerInterceptors } from '@spfn/core/nextjs/server';

registerInterceptors('auth', [
    {
        pathPattern: '/_auth/*',
        request: async (ctx, next) => {
            const session = ctx.cookies.get('session');
            if (session) ctx.headers['Authorization'] = `Bearer ${session}`;
            await next();
        },
        response: async (ctx, next) => {
            if (ctx.path === '/_auth/login' && ctx.response.body?.token) {
                ctx.setCookies.push({
                    name: 'session',
                    value: ctx.response.body.token,
                    options: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 86400 },
                });
                delete ctx.response.body.token;
            }
            await next();
        },
    },
]);
```

Importing the package's side-effect entry (e.g. `import '@spfn/auth/nextjs/api'`) in the
proxy route is what triggers registration. Use `disableAutoInterceptors: ['auth']` to opt a
package out.

---

## Type helpers

```typescript
import type { RouterOutput, RouterInput, InferRouteInput, InferRouteOutput } from '@spfn/core/nextjs';
import type { AppRouter } from '@/server/router';

type ListData    = RouterOutput<AppRouter, 'listExamples'>;
type CreateInput = RouterInput<AppRouter, 'createExample'>;
type Item        = RouterOutput<AppRouter, 'listExamples'>['items'][number];
type BodyInput   = RouterInput<AppRouter, 'createExample'>['body'];
```

`RouterOutput`/`RouterInput` take the router type + a route-name key. `InferRouteInput`/
`InferRouteOutput` take a single `RouteDef`. All inference is compile-time only (zero runtime
cost).

The route-name key is the **flat** set of names in the router tree. A route declared inside a
nested `defineRouter` is named by its own key here, exactly as the server registers it — the
group key is not part of the name and does not appear:

```typescript
const appRouter = defineRouter({
    getRoot,
    examples: defineRouter({ listExamples, createExample }),
});

type ListData = RouterOutput<typeof appRouter, 'listExamples'>;   // not 'examples.listExamples'
```

A name two branches both declare is left out of that set rather than resolved to one of them,
so naming it is a compile error where it is named. Routes mounted with `.packages()` stay out
of the set on purpose — call them through the package's own client.

`Client<AppRouter>` — what `createApi` returns — is built from the same flat set, so a route
is named identically whether you call it (`api.listExamples`) or take its type
(`RouterOutput<AppRouter, 'listExamples'>`).

---

## Error handling

`ApiError` is thrown for non-2xx responses, network failures, and timeouts:

```typescript
class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,            // HTTP status; 0 for network; 408 for timeout
        public readonly url: string,
        public readonly response?: unknown,         // parsed error body
        public readonly errorType?: 'http' | 'network' | 'timeout',
    ) {}
}
```

```typescript
import { ApiError } from '@spfn/core/nextjs';

try {
    await api.getUser.call({ params: { id: '123' } });
} catch (error) {
    if (error instanceof ApiError) {
        if (error.errorType === 'timeout')      { /* 408 */ }
        else if (error.errorType === 'network') { /* status 0 */ }
        else                                    { /* error.status, error.response */ }
    }
}
```

**Custom errors**: if the backend body carries a `__type` discriminator and a matching entry
is registered in the client's `errorRegistry`, the client deserializes and throws the
**original typed error** instead of a generic `ApiError`. Otherwise it falls back to
`ApiError`.

---

## Next.js integration

### Server Components with caching

```typescript
// app/users/[id]/page.tsx
import { api } from '@/lib/api';

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const user = await api.getUser
        .fetchOptions({ next: { revalidate: 3600 } })
        .call({ params: { id } });
    return <div>{user.name}</div>;
}
```

### Tag-based revalidation

```typescript
const posts = await api.getPosts
    .fetchOptions({ next: { tags: ['posts'] } })
    .call({ query: { page: 1 } });

// later, in a Server Action:
import { revalidateTag } from 'next/cache';
revalidateTag('posts');
```

### Client Components / Server Actions

```typescript
'use client';
import { api } from '@/lib/api';
const created = await api.createUser.call({ body: { name, email } });
```

```typescript
// app/actions.ts
'use server';
import { api } from '@/lib/api';
export async function createUser(formData: FormData) {
    return api.createUser.call({
        body: { name: formData.get('name') as string, email: formData.get('email') as string },
    });
}
```

---

## Pitfalls & anti-patterns

- **Never import `@spfn/core/nextjs/server` in a Client Component.** It pulls in
  `next/headers` + `next/server`; bundling it client-side breaks the build. Client code uses
  `@spfn/core/nextjs` only (`createApi`, `ApiError`, types).
- **`interceptors` is an `InterceptorRule[]`, not `{ request, response }`.** Older docs
  showed `createRpcProxy({ router, interceptors: { request, response } })` — that config
  shape **does not exist**. The current API is `{ routeMap, interceptors: [{ pathPattern,
  method?, request?, response? }] }`. There is **no** `router` option either; the proxy is
  driven entirely by `routeMap`.
- **The proxy resolves the real HTTP method from `routeMap`, not from the client call.** The
  client only ever sends GET (no body) or POST (body/formData) to `/api/rpc/...`. A PUT /
  PATCH / DELETE route still works — the backend method comes from `routeMap[routeName]`.
- **A missing `routeName` in `routeMap` is a proxy 404, not a backend 404.** Re-run codegen
  after adding routes or upgrading a mounted package — the generated map carries the mounted
  packages' routes — merge `eventRouteMap` if you use SSE, and delete `.spfn` if the map
  looks stale.
- **Interceptor `pathPattern` matches the resolved backend path** (e.g. `/users/123`,
  `/_auth/login`) — *not* the `/api/rpc/{routeName}` URL the client hit.
- **Two same-named interceptor type pairs.** `RequestInterceptor`/`ResponseInterceptor` from
  `@spfn/core/nextjs` are `(url, init)` / `(response, body)` (client hooks);
  from `@spfn/core/nextjs/server` they are `(ctx, next) => Promise<void>` (proxy middleware).
  Import from the right entry point.
- **Don't pass auth via the client to set HttpOnly cookies.** HttpOnly session cookies are
  set on the proxy response by a response interceptor (`ctx.setCookies.push(...)`), and
  forwarded automatically on subsequent requests. Client code can't read them by design.
- **Cookies are auto-forwarded on the server** — only use `.cookies({...})` /
  `options.cookies` to override. Calling outside a request context (static generation) yields
  no cookies, silently.
- **`createApi` needs no codegen; the *proxy* does.** The client is metadata-free. The
  `routeMap` the proxy consumes is the generated artifact.
- **Raw `X-Forwarded-For` is not forwarded — don't widen the allowlist to "fix" client IP.**
  The proxy re-emits the resolved client IP as `x-spfn-proxy-client-ip`, trusted only on
  HMAC-signed requests. Missing visitor IP in production means `SPFN_PROXY_SECRET` isn't set on
  both sides (and/or `TRUSTED_PROXY_HOPS` is wrong), not that the header allowlist needs
  `x-forwarded-for` — adding it back makes the IP spoofable. See *Header forwarding & client IP*.
- **Each `.headers()/.cookies()/.fetchOptions()/.onRequest()/.onResponse()` returns a new
  builder.** Chain them in one expression; a dangling builder without `.call()` does nothing.
- **A client `onResponse` may throw, and the throw is the caller's.** It runs outside the
  transport error handling, so `redirect('/login')` on a 401 navigates and a domain error
  raised there is raised as itself — neither is relabelled an `ApiError` of type `'network'`.
  Only a failed fetch (`0` / `'network'`) and an aborted one (`408` / `'timeout'`) are.

---

## Types reference

```typescript
// client (@spfn/core/nextjs)
type RequestInterceptor  = (url: string, init: RequestInit) => Promise<RequestInit> | RequestInit;
type ResponseInterceptor = (response: Response, body: any)
    => Promise<{ response: Response; body: any }> | { response: Response; body: any };

interface CookieOptions { httpOnly?: boolean; secure?: boolean; sameSite?: 'strict'|'lax'|'none'; maxAge?: number; path?: string; domain?: string; }
interface SetCookie { name: string; value: string; options?: CookieOptions; }

// proxy (@spfn/core/nextjs/server)
type RequestInterceptor  = (ctx: RequestInterceptorContext,  next: () => Promise<void>) => Promise<void>;
type ResponseInterceptor = (ctx: ResponseInterceptorContext, next: () => Promise<void>) => Promise<void>;
interface RouteMapEntry { method: HttpMethod; path: string; }
type RouteMap = Record<string, RouteMapEntry>;
```

## Related

- [@spfn/core/route](../route/README.md) — server-side route + router definitions (source of `AppRouter`)
- [@spfn/core/codegen](../codegen/README.md) — generates the `routeMap` the proxy consumes
- [@spfn/core/errors](../errors/README.md) — `ErrorRegistry`, custom error deserialization
- [@spfn/core/config](../config/README.md) — `SPFN_API_URL`, `SPFN_APP_URL`, `RPC_PROXY_TIMEOUT`, `SERVER_TIMEOUT`
- [@spfn/auth](../../../auth/README.md) — example package: route map + auto-registered interceptors
