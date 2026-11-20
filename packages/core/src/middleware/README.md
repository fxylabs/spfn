# @spfn/core/middleware — Built-in HTTP middleware (error handling + request logging + proxy-guard + rate limiting)

Production Hono middleware factories and a masking helper: `ErrorHandler` (serializes
thrown errors into HTTP responses), `RequestLogger` (structured request/response logging
with request IDs, slow-request detection, and sensitive-data masking), `createProxyGuard`
(verifies a trusted-proxy HMAC signature + origin allowlist and tags `clientType`), and
`rateLimit` (Redis-backed fixed-window limiter for brute-force / DoS protection).

> **These are the exports of this module.** `defineMiddleware` (custom named
> middleware), `.use()` / `.skip()` (route-level wiring), and `Transactional` (DB
> transaction middleware) are **not** here — they live in `@spfn/core/route` and
> `@spfn/core/db`. See [Related](#related).

## Import paths

```typescript
import {
    ErrorHandler,
    RequestLogger,
    maskSensitiveData,
    createProxyGuard,
    createCacheNonceStore,
    rateLimit,
    getClientIp,
    loggedPath,
} from '@spfn/core/middleware';

import type {
    ErrorHandlerOptions,
    OnErrorContext,
    RequestLoggerOptions,
    RequestLoggerConfig, // deprecated alias of RequestLoggerOptions
    ProxyGuardConfig,
    ProxyGuardMode,
    ClientType,
    NonceStore,
    RateLimitOptions,
} from '@spfn/core/middleware';
```

There is **no** `@spfn/core` root barrel — always import from `@spfn/core/middleware`.
`import { ErrorHandler } from '@spfn/core'` does not resolve.

---

## Public API (complete)

From `@spfn/core/middleware`:

- `ErrorHandler(options?: ErrorHandlerOptions)` → `(err, c) => Response | Promise<Response>`
  — register with `app.onError(...)`, **not** `app.use(...)`.
- `RequestLogger(options?: RequestLoggerOptions)` → Hono middleware `(c, next) => Promise<void>`
  — register with `app.use(...)`.
- `maskSensitiveData(obj, sensitiveFields, seen?)` → deep-masked copy of `obj`.
- `createProxyGuard(config?: ProxyGuardConfig)` → Hono middleware. Verifies the proxy→backend
  HMAC signature (rotating key set, keyed by `keyId`) over `method+path+query+body` and the
  client address (`x-spfn-proxy-client-ip`, signature version 2), plus an optional origin
  allowlist, then sets `c.get('clientType')` (`'web'` | `'untrusted'`) and, under a version-2
  signature, `c.get('proxyClientIp')`. A version-1 signature (no
  `x-spfn-proxy-signature-version` header, an older proxy) is still verified through 0.4.x, but
  its address is ignored; 0.5.0 refuses it. Modes:
  `off` (default) / `tag` / `strict` — every gate is evaluated in BOTH modes, only enforcement
  differs (strict rejects 403/413, tag tags `untrusted` and continues). `maxBodyBytes` caps the
  hashed body (stream-measured). Usually enabled via `defineServerConfig().proxyGuard({...})`,
  not `app.use` directly.
- `createCacheNonceStore(cache, prefix?)` → `NonceStore` for hard replay rejection (Redis
  `SET … PX NX`). Pass to `proxyGuard.nonceStore` (auto-wired from a cache when `nonce: true`).
- `rateLimit(options: RateLimitOptions)` → Hono middleware. Redis-backed fixed-window limiter,
  registered under the named `'rateLimit'` slot so routes can `.skip(['rateLimit'])`. Attach
  with `.use([rateLimit({...})])`. See [rateLimit](#ratelimit).
- `getClientIp(c)` → the client address: the address the proxy signed, on a request
  proxy-guard verified (`c.get('proxyClientIp')`); else, when trusted proxies are declared (`SERVER_TRUSTED_PROXY_HOPS` /
  `defineServerConfig().trustedProxyHops(n)`), the `X-Forwarded-For` entry n hops from the
  right; else the TCP peer address; else `'unknown'`. See [Client address](#client-address).
- `setTrustedProxyHops(n | undefined)` / `parseTrustedProxyHops(value)` → the declaration
  `createServer` publishes from server config, and the rule that validates it.
- `loggedPath(c)` → the request path as a log line may name it: `c.req.path`, or
  `<prefix>/[redacted]` when it falls under a prefix declared with
  `defineServerConfig().logging({ redactPaths })`. Every core line that names the request path
  reads it here; use it in your own lines too. See [Paths that must not be logged](#paths-that-must-not-be-logged).
- `setRedactPaths(paths | undefined)` / `parseRedactPaths(value)` → the declaration
  `createServer` publishes from `logging.redactPaths`, and the rule that validates it.

Types: `ErrorHandlerOptions`, `OnErrorContext`, `RequestLoggerOptions`, `RequestLoggerConfig`,
`ProxyGuardConfig`, `ProxyGuardMode`, `ClientType`, `NonceStore`, `RateLimitOptions`.

See the root `PROXY-BACKEND-AUTH-SPEC.md` for the threat model, key rotation, and `.env`
placement (`SPFN_PROXY_SECRET` in `.env.local`; grace `SPFN_PROXY_SECRET_PREVIOUS` in `.env.server`).

> **`RequestLoggerConfig` is deprecated** — it is a type alias of `RequestLoggerOptions`.
> Use `RequestLoggerOptions` in new code.

> **Most SPFN apps never call these directly.** `createServer` / `defineServerConfig`
> auto-register both — see [Auto-registration](#auto-registration-the-spfn-default-path)
> below. Manual `app.use` / `app.onError` is the raw-Hono path.

---

## Auto-registration (the SPFN default path)

When you start a server via `@spfn/core/server`, **`RequestLogger` and `ErrorHandler` are
applied for you** (along with CORS). You do not wire them by hand.

```typescript
import { defineServerConfig } from '@spfn/core/server';

export default defineServerConfig()
    .routes(appRouter)
    .build();
// → RequestLogger() (no options), CORS, then ErrorHandler() are auto-applied.
```

Toggle / configure them through `config.middleware`:

```typescript
export default defineServerConfig()
    .middleware({
        logger: true,         // RequestLogger (default: true) — false to disable, or its options
        cors: true,           // CORS (default: true)
        errorHandler: true,   // ErrorHandler (default: true) — set false to disable
        onError: (err, ctx) =>  // forwarded into ErrorHandler({ onError })
        {
            // non-blocking side-effect (Slack, PagerDuty, ...)
            log(ctx.statusCode, ctx.method, ctx.path, err.message);
        },
    })
    .routes(appRouter)
    .build();
```

Notes (from `create-server.ts`):

- The auto-applied `RequestLogger` takes its options from `middleware.logger` when that is an
  object — `.middleware({ logger: { excludePaths: ['/metrics'] } })` — and the defaults below
  otherwise (excludes `/_core/health`, `/health`, `/ping`, `/favicon.ico`). It stays where it
  is, ahead of CORS and proxy-guard; a `RequestLogger` of your own in `config.use` would run
  after the guard.
- `config.middleware.onError` is the **only** `ErrorHandlerOption` exposed through the
  builder; `includeStack` / `enableLogging` fall back to their defaults under auto-config.
- Order is fixed: `RequestLogger` → CORS → routes → `ErrorHandler` (via `app.onError`).

---

## Quick Start (raw Hono)

Use this only when wiring a bare Hono app yourself (not via `defineServerConfig`).

```typescript
import { Hono } from 'hono';
import { ErrorHandler, RequestLogger } from '@spfn/core/middleware';

const app = new Hono();

app.use('*', RequestLogger());     // middleware — runs per request
app.onError(ErrorHandler());       // error hook — NOT app.use()

export default app;
```

---

## ErrorHandler

Converts a thrown error into a JSON HTTP response. Register it with **`app.onError()`**
(it is Hono's error hook, not a `use()` middleware).

### Behavior

- **`SerializableError`** (from `@spfn/core/errors`) → serialized via its `toJSON()`, using
  the error's own `statusCode` as the HTTP status. Custom fields (`resource`, `fields`, …)
  are preserved. Detection is duck-typed (`toJSON` + numeric `statusCode`) so it survives
  module duplication under tsx/dev.
- **Standard `Error`** → falls back to `{ __type: 'Error', message }`, status from a
  `statusCode` property on the error if present, else `500`.
- **`cause` chain** → the root cause message is extracted and added as `cause`.
- **Database error, outside production** → a standard error that is, or was caused by, a
  database error (a drizzle `DrizzleQueryError`, a driver `PostgresError`, a `RepositoryError`
  over one) is answered with `{ __type: 'Error', message: 'Database error', database }` when
  `includeStack` is `true` — `database` is its `describeError` description (SQLSTATE,
  constraint, table, SQL with `$n` placeholders, `paramCount`) — and **no** `cause` or `stack`,
  which carry the bound values. The production body is unchanged.
- **Production information disclosure** → when `includeStack` is `false` (the production
  default), the client message is genericized for anything whose text may come from the DB
  driver: standard (uncaught) `Error`s become `"Internal Server Error"` with no `cause`, and
  any error exposing `internal === true` (the `DatabaseError` family — `QueryError`,
  `ConnectionError`, `TransactionError`, … carrying raw SQL / table / column / parameter
  text) becomes `"Internal server error"` with no `details`. Full detail is still logged
  server-side. Errors with a safe, constructed message (`EntityNotFoundError`,
  `DuplicateEntryError`, and all non-DB `SerializableError`s) are returned unchanged.
- **Logging** (when `enableLogging`): `warn` for 4xx, `error` for 5xx, via the
  `@spfn/core:error-handler` logger. The line carries the error's description, never its
  message or cause as text: with `includeStack` as the error (frames included), without it as
  an `error` field with no frames.
- **`onError` callback** → fired non-blocking (`Promise.resolve(...).catch(...)`); never
  delays or fails the response.

### Options (`ErrorHandlerOptions`)

| Option | Type | Default | Effect |
|--------|------|---------|--------|
| `includeStack` | `boolean` | `env.NODE_ENV !== 'production'` | Add `stack` to the response body |
| `enableLogging` | `boolean` | `true` | Log errors (warn 4xx / error 5xx) |
| `onError` | `(err, ctx: OnErrorContext) => void \| Promise<void>` | — | Non-blocking side-effect callback |

```typescript
app.onError(ErrorHandler({
    includeStack: env.NODE_ENV !== 'production',
    enableLogging: true,
    onError: (err, ctx) => notify(ctx.statusCode, ctx.path, err),
}));
```

### Response format

`SerializableError` (e.g. `NotFoundError`) — body is its `toJSON()` output; HTTP status is
the error's `statusCode`:

```json
// production
{ "__type": "NotFoundError", "message": "User not found", "resource": "User",
  "error": { "code": "NotFoundError", "message": "User not found", "requestId": "9f2c…" } }

// development (includeStack) adds:
{ "__type": "NotFoundError", "message": "User not found", "resource": "User",
  "error": { "code": "NotFoundError", "message": "User not found", "requestId": "9f2c…" },
  "stack": "Error: User not found\n    at ..." }
```

Standard error fallback:

```json
{ "__type": "Error", "message": "Internal Server Error",
  "error": { "code": "Error", "message": "Internal Server Error", "requestId": "9f2c…" } }
// + "cause": "..."  when the error has a cause
// + "stack": "..."  only when includeStack is true
```

A database error when `includeStack` is true (any non-production `NODE_ENV`, staging included):

```json
{ "__type": "Error", "message": "Database error",
  "database": { "kind": "database", "name": "DrizzleQueryError", "code": "23505",
                "constraint": "users_email_key", "table": "users",
                "message": "duplicate key value violates unique constraint \"users_email_key\"",
                "sql": "insert into \"users\" (\"email\", \"password_hash\") values ($1, $2)",
                "paramCount": 2, "stack": "    at ..." },
  "error": { "code": "Error", "message": "Database error", "requestId": "9f2c…" } }
```

> The serialized field is **`__type`**, and the status code is carried by the **HTTP
> status**, not a body field. (Older docs showing `{ "error": "...", "statusCode": 400 }`
> are stale.)

#### The `error` envelope

Every error response also carries `error: { code, message, requestId }`. Two consumers read
one body: a TypeScript client restores the error class from `__type` through its error
registry, while a client generated for another language has no such registry and classifies
by `code` alone. `code` repeats `__type`; `message` repeats the body's message, masking and
all; `requestId` is `RequestLogger`'s id when one is set, and a fresh one otherwise.

`__type`, `message` and `error` are reserved — an error class declaring a field with one of
those names throws outside production (see `errors/README.md`).

Set `errorEnvelope: false` to leave the body exactly as it was before the envelope existed.
Only do that to keep bodies byte-identical to an older release; any route a generated client
calls needs the envelope.

### `OnErrorContext`

```typescript
interface OnErrorContext {
    statusCode: number;
    path: string;         // loggedPath(c): redacted under a declared prefix
    method: string;
    requestId?: string;   // present when RequestLogger ran first
    timestamp: string;    // ISO 8601
    userId?: string;      // from c.get('auth')?.userId, when auth middleware set it
    request: {
        headers: Record<string, string>;  // sensitive headers masked to '***'
        query: Record<string, string>;
    };
}
```

Masked request headers: `authorization`, `cookie`, `x-api-key`, `x-auth-token`
(case-insensitive). `requestId` and `userId` are only populated when the corresponding
upstream middleware (RequestLogger / auth) has run.

---

## RequestLogger

Per-request logging middleware. Register with **`app.use()`**.

### Behavior

- Generates a request ID (`req_<timestamp>_<6-byte hex>`) and stores it on the context:
  `c.set('requestId', id)` → read via `c.get('requestId')`.
- Logs `Request received` (method, path, ip, userAgent) and `Request completed`
  (status, duration). The `ip` is `getClientIp(c)` — the same address rate limiting counts
  (see [Client address](#client-address)).
- Log level by status: `info` (<400), `warn` (4xx), `error` (5xx). Logger child:
  `@spfn/core:api`.
- **Slow requests** (`duration >= slowRequestThreshold`) get `slow: true`.
- **For 4xx/5xx**: clones the response to attach the error `response` body, and for
  `POST`/`PUT`/`PATCH` attaches the masked request body (`request`).
- If the downstream throws, logs `Request failed` at `error` level **and re-throws**
  (so `app.onError` / `ErrorHandler` still runs). It does not swallow errors.

### Options (`RequestLoggerOptions`)

| Option | Type | Default |
|--------|------|---------|
| `excludePaths` | `string[]` | `['/_core/health', '/health', '/ping', '/favicon.ico']` |
| `sensitiveFields` | `string[]` | `['password', 'token', 'apiKey', 'secret', 'authorization']` |
| `slowRequestThreshold` | `number` (ms) | `1000` |

`excludePaths` matches **exact or prefix** — `/health` also excludes `/health/db` — against the
decoded path the router serves, so `/%68ealth` is excluded too. Excluded paths skip the request
logger entirely (and get **no** request ID). It is a noise filter: the other lines that name a
request path (proxy-guard, error handler, rate limit, transactions) still write theirs. To keep a
path out of every line, see [Paths that must not be logged](#paths-that-must-not-be-logged).

`path` in its lines is `loggedPath(c)`: the decoded path, or `<prefix>/[redacted]` under a
declared prefix.

```typescript
app.use('*', RequestLogger({
    excludePaths: ['/health', '/metrics', '/_next'],
    sensitiveFields: ['password', 'creditCard', 'ssn'],
    slowRequestThreshold: 500,
}));
```

### Reading the request ID

```typescript
// in a route handler
const requestId = c.get('requestId'); // string | undefined
```

### Log output examples

```json
// Request received
{ "level": "info", "module": "api", "msg": "Request received",
  "requestId": "req_1759541628730_qsm7esvo7", "method": "POST", "path": "/users",
  "ip": "127.0.0.1", "userAgent": "..." }

// completed (success)
{ "level": "info", "module": "api", "msg": "Request completed",
  "requestId": "req_...", "method": "POST", "path": "/users", "status": 201, "duration": 45 }

// completed (4xx — includes response body + masked request body)
{ "level": "warn", "module": "api", "msg": "Request completed",
  "status": 400, "duration": 2,
  "response": { "__type": "ValidationError", "message": "Invalid request body" },
  "request": { "status": 123, "password": "***MASKED***" } }

// slow
{ "level": "info", "msg": "Request completed", "status": 200, "duration": 1250, "slow": true }

// downstream threw (then re-thrown to ErrorHandler)
{ "level": "error", "module": "api", "msg": "Request failed",
  "method": "POST", "path": "/users", "duration": 23, "error": { ... } }
```

---

## Paths that must not be logged

A capability route — `/api/import/:token`, a share link, a one-time download — carries its secret
in the path. Declare its prefix once in server config:

```typescript
defineServerConfig().logging({ redactPaths: ['/api/import'] })
```

Every line this module writes that names the request path then writes `/api/import/[redacted]`,
at every level: `RequestLogger`, proxy-guard (its tag-mode debug and strict-mode warn), the
`ErrorHandler` line and `OnErrorContext.path`, `rateLimit`'s cache lines, and the transaction
context `Transactional()` hands the runner. Matching is on a segment boundary, against the decoded
path; undeclared paths are written as before. The full rules, and what is not covered, are in the
server README's [Paths that must not be logged](../server/README.md#paths-that-must-not-be-logged).

Name the path in your own lines the same way:

```typescript
import { loggedPath } from '@spfn/core/middleware';

importLogger.info('Import redeemed', { path: loggedPath(c) });
```

On a bare Hono app that does not go through `createServer`, publish the declaration yourself,
before the first request: `setRedactPaths(['/api/import'])`.

---

## maskSensitiveData

Deep-masks fields whose name (case-insensitive) **contains** any of `sensitiveFields`,
returning a new structure. Used internally by `RequestLogger`; exported for reuse.

```typescript
import { maskSensitiveData } from '@spfn/core/middleware';

maskSensitiveData(
    { username: 'john', password: 'secret', apiKey: 'sk_live_x' },
    ['password', 'apiKey'],
);
// → { username: 'john', password: '***MASKED***', apiKey: '***MASKED***' }
```

- **Partial + case-insensitive**: `['password']` masks `userPassword`, `PASSWORD`, etc.
- **Recursive**: descends into nested objects and arrays.
- **Immutable**: shallow-clones at each level; the input is untouched.
- **Circular-safe**: repeated references become `'[Circular]'` (via an internal `WeakSet`).
- Non-objects (`null`, primitives) are returned as-is.

Replacement token is the literal string `'***MASKED***'`.

---

## rateLimit

Redis-backed **fixed-window** rate limiter. Three ways to apply it: attach per-route with
`.use([rateLimit({...})])`; enable a [global default](#global-default-limiter) for every route;
or tag a route with a [named policy](#named-policies--ratelimitpolicyname-fallback) the
consuming app tunes centrally. The global default and policy tags use the named `'rateLimit'`
middleware, so routes opt out with `.skip(['rateLimit'])`.

```typescript
import { rateLimit, getClientIp } from '@spfn/core/middleware';

// 10 requests / minute per client IP (the default dimension)
route.post('/_auth/login')
    .use([rateLimit({ limit: 10, windowMs: 60_000 })])
    .handler(/* ... */);

// limit on more than one dimension — the strictest wins
route.post('/_auth/codes')
    .use([rateLimit({
        limit: 5,
        windowMs: 60_000,
        by: (c) => [getClientIp(c)],
    })])
    .handler(/* ... */);
```

### Options (`RateLimitOptions`)

| Field | Type | Default | Notes |
|---|---|---|---|
| `limit` | `number` | — | Max requests per window, applied to **each** dimension. |
| `windowMs` | `number` | — | Window length in milliseconds. |
| `scope` | `string` | `` `${method} ${routePath}` `` | Counter-key namespace; defaults to per-route. |
| `by` | `(c) => (Dimension \| null \| undefined)[]` | `[getClientIp(c)]` | Identity dimensions; each non-empty value is counted separately, strictest wins. A `Dimension` is a `string` (uses `limit`) or `{ key, limit? }` to give that dimension its own limit. |

Per-dimension limits let one limiter be loose on IP and tight on account/target — so a
shared NAT isn't throttled as one user while a single account stays protected:

```typescript
rateLimit({
    limit: 5,                 // default for dimensions without their own limit
    windowMs: 60_000,
    by: (c) => [
        { key: `ip:${getClientIp(c)}`, limit: 100 }, // loose per-IP floor
        accountKey(c),                               // tight per-account (uses limit: 5)
    ],
});
```

`@spfn/auth` ships `byIpAndAccount()` / `byIpAndTarget()` builders for exactly this on its
login, register, and verification-code routes (per-account / per-target tight, per-IP loose),
so distributed brute force and SMS-bombing are limited by the thing being attacked, not only
by source IP.
| `failClosed` | `boolean` | `false` | Reject with 429 when the cache is unavailable instead of allowing through. |
| `message` | `string` | generic | 429 response message. |

### Behavior

- **Atomic**: counts via a single Lua `INCR` + `PEXPIRE`, so the expiry is never lost in
  a race between two requests.
- **Fail-open by default**: when no cache is configured (or it is disabled), requests pass
  and a warning is logged — matching the proxy-guard nonce store's graceful degradation, so
  local dev without Redis still works. Set `failClosed: true` to reject instead.
- **On exceed**: throws `TooManyRequestsError` (429) and sets a `Retry-After` header derived
  from the key's remaining TTL.
- **Storage**: keys are `ratelimit:{scope}:{dimension}` in the shared cache.
- **One counter per scope, not per limiter**: limiters on one route that share a `scope` count
  a request once **each** against the same key. A router's `rateLimit({ limit: 3, … })` and an
  equal one on its route refuse the 2nd request, not the 4th — as the global default and a
  route's `rateLimit(...)` without a `scope` already did. To replace the inherited limit on a
  route, `.skip(['rateLimit'])` it and `.use([rateLimit(...)])` the route's own; to layer two
  limits, give one its own `scope`, or tag the route with a
  [`rateLimitPolicy`](#named-policies--ratelimitpolicyname-fallback), whose scope is its name.

> **IP trust**: the IP dimension is `getClientIp(c)`, which reads `X-Forwarded-For` only as far
> as you declared proxies in front of the server — see [Client address](#client-address). An
> app behind a load balancer must declare it, or every request counts as the balancer's address.
> For security-sensitive limits, still pair the IP dimension with an account/target dimension.

### Client address

**BREAKING** (au9-N3): the backend no longer trusts any proxy by default.

`getClientIp(c)` is the one definition of "the client's address" — per-IP rate limits, the
request log and `@spfn/auth` (device provenance, access logs) all read it. In order:

1. A request proxy-guard verified as the Next.js proxy's: the address the proxy resolved and
   signed (`x-spfn-proxy-client-ip`, covered by a version-2 signature — #363). Only when
   proxy-guard runs — its mode is `'tag'` or `'strict'`; with the default `'off'` nothing is
   verified and this step never applies (see *Browser traffic through the Next.js proxy*
   below). A `clientType` set by anything else (`'mobile'` from client proof) does not make the
   header believed, and neither does a version-1 signature, which does not cover it.
2. When the operator declared trusted proxies: the `X-Forwarded-For` entry that many hops
   **from the right** — the one the outermost trusted proxy appended. Entries to its left are
   the caller's own and are skipped, so a forged left-most value changes nothing. A chain with
   fewer entries than the declared hops did not come through the declared proxies and names no
   client: the request falls through to the TCP peer.
3. The TCP peer address (Node adapter), else `'unknown'`.

A declaration trusts whoever reaches the backend to have come through the declared proxies. A
caller that reaches it directly, bypassing the load balancer, writes its own `X-Forwarded-For`
entries and so chooses its address for every per-IP limit. Keep the backend unreachable but
through the balancer, or run proxy-guard in `'strict'` mode, which refuses any request the
Next.js proxy did not sign.

With no declaration neither `X-Forwarded-For` nor `X-Real-IP` is read: a direct caller that
sent a new `X-Forwarded-For` value per request used to be a new caller per request to every
per-IP limit. The first request that carries the header while nothing is declared logs one
warning per process.

Declare the proxies with **`SERVER_TRUSTED_PROXY_HOPS`** (env, default `0`) or
`defineServerConfig().trustedProxyHops(n)` (wins over the env). The value is a hop count —
proxy addresses and CIDR ranges are not supported. Anything but a whole number of 0 or more
refuses the boot: the env through the boot-time env check, the builder by failing the config
load, a plain config object in `validateServerConfig`.

```typescript
// One load balancer in front of the API server
export default defineServerConfig()
    .trustedProxyHops(1)
    .build();
```

**Migration:** an app whose backend sits behind a load balancer or reverse proxy that
appends `X-Forwarded-For` sets `SERVER_TRUSTED_PROXY_HOPS` to that count. Without it every
request counts as the balancer's address, so one per-IP limit is shared by all visitors.
`TRUSTED_PROXY_HOPS` is a different setting: it is read by the Next.js proxy for the hops in
front of *it*, and requests that proxy signs do not depend on the backend's declaration.

**Browser traffic through the Next.js proxy.** A request the proxy signed carries its client's
address separately (`x-spfn-proxy-client-ip`), but the backend reads it only when proxy-guard
verified the signature — proxy-guard mode `'tag'` or `'strict'`. The default mode is `'off'`:
nothing is verified, and every browser request reaches the backend from the Next.js server's
own address. In a default app, then, a per-IP limit is **per Next.js server**, shared by every
visitor behind it. For per-client limits on browser traffic:

- turn proxy-guard on — `defineServerConfig().proxyGuard({ mode: 'tag' })` (or `'strict'`)
  with the same `SPFN_PROXY_SECRET` on the proxy and the backend — so the signed client
  address is read. That key is also what lets a server component's or server action's call
  carry the browser's address rather than the Next.js server's (see the Next.js README,
  *A server-side call carries the browser's address*); or
- when your Next.js server's request to the backend carries an `X-Forwarded-For` naming the
  client (a forwarder of your own — the spfn Next.js proxy does not forward that header), declare
  the hops with `SERVER_TRUSTED_PROXY_HOPS` / `trustedProxyHops(n)`.

The default is unchanged.

### Global default limiter

Turn on a default limiter for **every** route from one place — no per-route `.use()`. It is
registered as the named `'rateLimit'` middleware, so a route opts out with `.skip(['rateLimit'])`.
Disabled by default (`mode: 'off'`).

```typescript
export default defineServerConfig()
    .rateLimit({
        mode: 'on',
        default: { limit: 100, windowMs: 60_000 },
    })
    .routes(appRouter)
    .build();
```

Or via env: `RATE_LIMIT_MODE=on`, `RATE_LIMIT_DEFAULT_LIMIT`, `RATE_LIMIT_DEFAULT_WINDOW_MS`,
`RATE_LIMIT_FAIL_CLOSED`. Health, SSE and WebSocket endpoints register outside the
named-middleware pipeline, so they are always exempt.

Counters live in the shared cache when `CACHE_URL` points at one, and in the process
otherwise — see [Limitations & operational notes](#limitations--operational-notes) for what
per-process counting costs.

### Named policies — `rateLimitPolicy(name, fallback)`

Lets a **package** tag a sensitive route while the **consuming app** tunes the numbers
centrally. The package ships the tag with a safe fallback; the app overrides it by name.

```typescript
// in a package (e.g. @spfn/auth)
route.post('/_auth/login')
    .use([rateLimitPolicy('auth-login', { limit: 5, windowMs: 60_000 })])
    .handler(/* ... */);

// in the consuming app — tune every policy in one place
export default defineServerConfig()
    .rateLimit({
        policies: {
            'auth-login': { limit: 10, windowMs: 60_000 },
        },
    })
    .routes(appRouter)
    .build();
```

- **Resolution**: configured policy (by name) wins, shallow-merged over the fallback; with no
  config the fallback applies, so the route is protected out of the box.
- **Layered**: the tag registers under a distinct name (`rateLimit:<name>`) and does **not**
  skip the global default, so a tagged route gets both — the global per-IP floor (when
  enabled) *and* this policy's own bucket; whichever is stricter trips first. Opt out of the
  floor on a route with `.skip(['rateLimit'])`.
- **Shared bucket**: a policy's counter scope defaults to its name, so every route sharing a
  policy shares one bucket (e.g. all OAuth start routes share `oauth-start`). It also keeps
  the key from colliding with the global default's per-route scope. Pass an explicit `scope`
  to override.
- Policies are registered at server boot whether or not the global default is enabled.

### Limitations & operational notes

Read these before relying on rate limiting as a security control:

- **Default identity is the client IP.** A limiter with no `by` keys only on `getClientIp(c)`,
  so a distributed attacker (many source IPs) isn't stopped per-account and a shared NAT/CGNAT
  can be throttled as one user. For account/target protection (credential stuffing,
  OTP/SMS-bombing) add a `by` dimension returning a stable account/target key alongside the IP
  — ideally with a per-dimension limit (loose IP, tight account). The bundled `@spfn/auth`
  login/register/code routes already do this via `byIpAndAccount()` / `byIpAndTarget()`.
- **`getClientIp` reads forwarded headers only as declared.** Behind a verified proxy
  (proxy-guard) it uses the attested client IP; otherwise the `X-Forwarded-For` entry
  `SERVER_TRUSTED_PROXY_HOPS` hops from the right, and with nothing declared the TCP peer
  address (Node adapter), and only the literal `'unknown'` when even that is unavailable
  (non-Node runtime). A declared hop count is only as good as the network: a caller that can
  reach the server around the declared proxies can still state the header.
- **Counters fall back to memory, not to nothing.** With no cache configured — or with the
  cache down, or a command failing mid-request — the limiter counts in the process
  (`MemoryRateLimitStore`) instead of having nowhere to count. Limits still apply, but
  **per process**: behind N instances the effective limit is N × the configured one, since
  each keeps its own windows. Point `CACHE_URL` at Redis for the configured limit to be the
  actual limit.
- **The memory store is bounded** at 10,000 live windows. Expired windows are dropped first;
  if every window is still live the oldest is evicted, losing its count. `evictionCount`
  going up means this process is past what an in-memory limiter should hold — that
  deployment wants a real cache.
- **`RATE_LIMIT_FAIL_CLOSED=true` refuses instead of counting locally.** For a surface where a
  per-process count is not an acceptable substitute for a shared one; a 429 is preferred to a
  looser limit. It applies to **both** the global default and named policy tags (a tag may opt
  out with `failClosed: false`). Note this rejects every request while the cache is away, so it
  turns a cache outage into an auth outage — which is the point, but it is a deployment's call.
- **Counter scopes differ by layer.** The global default is keyed per-route
  (`${method} ${routePath}`); a named policy is keyed by its **name**, so routes sharing a
  policy share one bucket. Pass an explicit `scope` to change either.
- **The SSE token endpoint is not exempt.** Only the SSE *stream*, WebSocket, and health
  endpoints (registered outside the named-middleware pipeline) bypass the global default;
  `POST /events/token` runs `config.middlewares`, so it receives the limiter too.

---

## Pitfalls & anti-patterns

- **`ErrorHandler` goes on `app.onError()`, never `app.use()`.** It returns an
  `(err, c) => Response` error hook, not a `(c, next)` middleware. Putting it in `use()`
  (or `config.middlewares` / `config.use`) will not catch errors.
- **Don't double-register under `defineServerConfig`.** The server auto-applies both. Only
  use the raw `app.use(RequestLogger())` / `app.onError(ErrorHandler())` calls on a bare
  Hono app. To change RequestLogger options under SPFN, pass them as `middleware.logger`.
- **`excludePaths` does not keep a path out of the log.** It silences the request logger's
  lines only. A token in a path needs `logging.redactPaths` (see
  [Paths that must not be logged](#paths-that-must-not-be-logged)).
- **Don't log `c.req.path` or `c.req.url` yourself.** Use `loggedPath(c)`, which applies the
  declared prefixes; the URL also carries the query.
- **`config.middleware.onError` is the only ErrorHandler option the builder forwards.**
  `includeStack` / `enableLogging` are not configurable through `defineServerConfig` — they
  use defaults. Need them tuned? Build the Hono app manually.
- **RequestLogger must run before ErrorHandler** for `requestId` to appear in
  `OnErrorContext`. The auto-config order (logger → … → onError) already guarantees this;
  preserve it if wiring manually (`app.use(RequestLogger())` then `app.onError(...)`).
- **Excluded paths get no request ID.** `excludePaths` short-circuits before
  `c.set('requestId')`, so handlers on `/health` etc. read `undefined`.
- **These are not "named middleware."** They have no `.skip()` name and cannot be skipped
  per-route via the route DSL. Route-level skip applies only to `NamedMiddleware` created
  with `defineMiddleware` (`@spfn/core/route`). To exclude paths from logging, use
  `excludePaths`, not `.skip()`.
- **`sensitiveFields` matches by substring.** A field named `tokenize` is masked because it
  contains `token`. Choose field names with that in mind.
- **Don't import from `@spfn/core`.** No root barrel exists; use `@spfn/core/middleware`.
- **`RequestLoggerConfig` is deprecated** — alias of `RequestLoggerOptions`.

---

## Complete example (raw Hono)

```typescript
import { Hono } from 'hono';
import { ErrorHandler, RequestLogger } from '@spfn/core/middleware';
import { NotFoundError } from '@spfn/core/errors';

const app = new Hono();

// 1. RequestLogger first — assigns requestId, times every request
app.use('*', RequestLogger({
    excludePaths: ['/health'],
    slowRequestThreshold: 500,
}));

app.get('/users/:id', async (c) =>
{
    const requestId = c.get('requestId');
    const user = await findUser(c.req.param('id'));

    if (!user)
    {
        throw new NotFoundError({ message: 'User not found', resource: 'User' });
    }

    return c.json({ requestId, user });
});

// 2. ErrorHandler last — onError hook catches everything above
app.onError(ErrorHandler({
    includeStack: process.env.NODE_ENV !== 'production',
    onError: (err, ctx) => notify(ctx),
}));

export default app;
```

Under SPFN, the equivalent is just `defineServerConfig().routes(appRouter).build()` — both
middleware are added automatically.

---

## Types reference

```typescript
interface ErrorHandlerOptions {
    includeStack?: boolean;   // default: env.NODE_ENV !== 'production'
    enableLogging?: boolean;  // default: true
    onError?: (err: Error, context: OnErrorContext) => Promise<void> | void;
}

interface OnErrorContext {
    statusCode: number;
    path: string;
    method: string;
    requestId?: string;
    timestamp: string;
    userId?: string;
    request: { headers: Record<string, string>; query: Record<string, string> };
}

interface RequestLoggerOptions {
    excludePaths?: string[];        // default: ['/_core/health', '/health', '/ping', '/favicon.ico']; decoded path
    sensitiveFields?: string[];     // default: ['password','token','apiKey','secret','authorization']
    slowRequestThreshold?: number;  // default: 1000 (ms)
}

type RequestLoggerConfig = RequestLoggerOptions; // @deprecated

function maskSensitiveData(obj: any, sensitiveFields: string[], seen?: WeakSet<object>): any;

function loggedPath(c: Context): string;               // c.req.path, or '<prefix>/[redacted]'
function setRedactPaths(paths: string[] | undefined): void;
function parseRedactPaths(value: unknown): string[];   // throws on an entry that is not a literal prefix
```

## Related

- [@spfn/core/route](../route/README.md) — `defineMiddleware` / `defineMiddlewareFactory`
  (custom named middleware), route-level `.use()` / `.skip()` wiring and execution order.
- [@spfn/core/db](../db/README.md) — `Transactional()` route middleware
  (auto commit/rollback).
- [@spfn/core/server](../server/README.md) — `defineServerConfig` / `config.middleware`,
  which auto-registers `RequestLogger` + `ErrorHandler`.
- [@spfn/core/errors](../errors/README.md) — `SerializableError` and the built-in error
  classes that `ErrorHandler` serializes.
- [@spfn/core/logger](../logger/README.md) — the logger both middleware write to.
</content>
</invoke>
