# @spfn/core/server — HTTP server entry point (config builder + lifecycle)

The unified entry point for an SPFN backend process: build a config with
`defineServerConfig()`, then boot with `startServer()`. Handles middleware auto-wiring,
infrastructure init (DB/Redis), routes/jobs/events/websockets/workflows integration, and
AWS-drain-style graceful shutdown.

## Import paths

There is **one** entry point:

```typescript
import {
    startServer,
    createServer,
    defineServerConfig,
    getShutdownManager,
    loadEnv,
    CORE_TIME_ROUTE,
    CORE_TIME_PATH,
    ServerTimeResponseSchema,
} from '@spfn/core/server';

import type {
    ServerConfig,
    ServerInstance,
    AppFactory,
    ShutdownHookOptions,
    ServerClock,
    ServerTimeResponse,
} from '@spfn/core/server';
```

Routes/middleware come from a **different** module — don't look for them here:

```typescript
import { defineRouter, route, defineMiddleware } from '@spfn/core/route';
```

---

## Public API (complete)

Everything exported from `@spfn/core/server`:

- **Boot**: `startServer(config?)` → `Promise<ServerInstance>` — loads env + config file,
  inits infrastructure, starts the HTTP server, registers shutdown handlers.
- **App only**: `createServer(config?)` → `Promise<Hono>` — builds the configured Hono app
  without listening (for tests / custom `serve()`).
- **Config builder**: `defineServerConfig()` → `ServerConfigBuilder` (fluent, `.build()`
  returns `ServerConfig`).
- **Shutdown**: `getShutdownManager()` → `ShutdownManager` singleton.
- **Env**: `loadEnv` (re-export of `@spfn/core/env/loader`). `startServer()` already calls
  it internally.
- **Server time**: `CORE_TIME_ROUTE`, `CORE_TIME_PATH`, `CORE_TIME_OPERATION_ID`,
  `ServerTimeResponseSchema`, `createCoreTimeRoute()` and the `ServerClock` /
  `ServerTimeResponse` types — the built-in unproven clock-synchronization contract.
- **Deprecated**: `loadEnvFiles()` — alias for `loadEnv()`; use `loadEnv` instead.
- **Types**: `ServerConfig`, `ServerInstance`, `AppFactory`, `ShutdownHookOptions`.

> **Not exported from `@spfn/core/server`:** `validateServerConfig`, `printBanner`,
> `ShutdownManager` (the class), `WorkflowRouterLike`. They exist internally but are not in
> the public barrel — do not import them from `@spfn/core/server`. Use
> `getShutdownManager()` to obtain a `ShutdownManager` instance.

> The config-builder fluent methods (`.events()`, `.jobs()`, `.websockets()`,
> `.workflows()`, `.cors()`, `.middleware()`, `.use()`, `.infrastructure()`, …) are methods
> on the object returned by `defineServerConfig()` — they are **not** standalone exports.

---

## Quick Start

```typescript
// src/server/server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { defineRouter, route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';

const appRouter = defineRouter({
    getUser: route.get('/users/:id')
        .input({ params: Type.Object({ id: Type.String() }) })
        .handler(async (c) =>
        {
            const { params } = await c.data();
            return { id: params.id, name: 'John' };
        }),
});

export default defineServerConfig()
    .port(4000)
    .routes(appRouter)
    .build();

// Re-export the router type for the typed client
export type AppRouter = typeof appRouter;
```

```typescript
// src/server/index.ts (process entry point)
import { startServer } from '@spfn/core/server';

await startServer();
```

`startServer()` with no argument auto-discovers `server.config.ts` (see file-loading order
below), so the entry point usually stays this small. Pass a config object to
`startServer(config)` only to override at runtime (highest priority).

---

## Config builder (`defineServerConfig`)

Fluent builder; every method returns `this`; `.build()` returns a plain `ServerConfig`.
There is **no validation in the builder** — validation runs inside `startServer()`.

| Method | Sets | Notes |
|--------|------|-------|
| `.port(number)` | `port` | Default `4000` (env `PORT`) |
| `.host(string)` | `host` | Default `localhost` (env `HOST`) |
| `.routes(router)` | `routes` | Also auto-merges the router's `.use()` + `.packages()` global middlewares into `middlewares` |
| `.middlewares([named])` | `middlewares` | `NamedMiddleware[]` from `defineMiddleware()` (route-level `.skip()` targets these) |
| `.use([handlers])` | `use` | Raw `MiddlewareHandler[]`, applied `app.use('*', …)` |
| `.middleware({...})` | `middleware` | Toggle built-ins: `{ logger?, cors?, errorHandler?, onError? }`; `logger` also takes `RequestLoggerOptions` |
| `.logging({...})` | `logging` | `{ redactPaths? }` — path prefixes no log line names in full; see [Paths that must not be logged](#paths-that-must-not-be-logged) |
| `.cors(opts \| false)` | `cors` | hono/cors options, or `false` to disable |
| `.jobs(router, cfg?)` | `jobs` / `jobsConfig` | pg-boss job router (`@spfn/core/job`); `cfg` is `Omit<BossOptions, 'connectionString'>` |
| `.events(router, cfg?)` | `events` / `eventsConfig` | SSE router (`@spfn/core/event`); `cfg.path` default `/events/stream`, `cfg.auth` for token-gated streams; cross-pod fan-out auto-wires when a cache is set (`cfg.multiInstance`/`cfg.channelPrefix`) |
| `.websockets(router, cfg?)` | `websockets` / `websocketsConfig` | WS router; `cfg.path` default `/ws`, `cfg.auth` for token auth; same `multiInstance`/`channelPrefix` cross-pod knobs as `.events()` |
| `.workflows(router, cfg?)` | `workflows` / `workflowsConfig` | `@spfn/workflow` router; inits engine after DB |
| `.database({...})` | `database` | External Drizzle `provider`, or postgres.js pool / healthCheck / monitoring overrides |
| `.timeout({...})` | `timeout` | `{ request?, keepAlive?, headers? }` (ms) |
| `.shutdown({...})` | `shutdown` | `{ timeout? }` (ms) |
| `.healthCheck({...})` | `healthCheck` | `{ enabled?, path?, detailed? }` |
| `.serverTime({...})` | `serverTime` | Inject `{ clock: { now() } }` for deterministic tests; production defaults to `Date.now()` |
| `.infrastructure({...})` | `infrastructure` | `{ database?, redis? }` — `false` disables auto-init |
| `.migrations({...})` | `migrations` | `{ allowPending? }` — `true` boots with pending migrations (warn instead of refuse); never with a bookkeeping mismatch |
| `.debug(boolean)` | `debug` | Default `NODE_ENV === 'development'` |
| `.lifecycle({...})` | merged | **Mergeable** — see below |
| `.build()` | — | Returns the final `ServerConfig` |

> There is **no** `.fetchTimeout()` builder method and **no** `.beforeStart()` /
> `.afterStart()` / `.beforeShutdown()` standalone builder methods. Fetch timeouts are set
> via the `fetchTimeout` field on a `ServerConfig` object (or env vars); lifecycle hooks go
> through `.lifecycle({ ... })`.

### `.routes()` keeps the router's own middleware

Middleware a router registered with `.use()` travels with that router: `.routes(appRouter)`
records the router, and route registration applies its middleware to that router's routes
(package routers included). You usually do **not** also call `.middlewares()`:

```typescript
const appRouter = defineRouter({ getUser, createUser })
    .packages([authRouter])           // package routers keep their own .use() middleware
    .use([authMiddleware]);           // applied to this router's routes

export default defineServerConfig()
    .routes(appRouter)                // authMiddleware active on every route above
    .build();
```

A named middleware runs **at most once per route**, no matter how many registrations name
it — registering the same one at both levels (`.middlewares([authMiddleware])` *and*
`.use([authMiddleware])`) is not an error and does not run it twice. Middleware holding
one-shot state, such as a nonce replay ledger, depends on that: a second run would reject
the very request the first run accepted.

### `.lifecycle()` is mergeable (not last-wins)

Multiple `.lifecycle()` calls accumulate; for each hook name, the collected hooks run
**sequentially in registration order**. This is the one builder method that does not
overwrite on repeat.

```typescript
defineServerConfig()
    .lifecycle({ afterInfrastructure: async () => { await runMigrations(); } })
    .lifecycle({ afterInfrastructure: async () => { await seed(); } }) // runs AFTER migrations
    .build();
```

Hook signatures (`ServerConfig['lifecycle']`):

| Hook | Signature | When |
|------|-----------|------|
| `beforeInfrastructure` | `(config) => Promise<void>` | before DB/Redis init |
| `afterInfrastructure` | `() => Promise<void>` | after DB/Redis (and before jobs/workflows) |
| `beforeRoutes` | `(app: Hono) => void \| Promise<void>` | inside `createServer`, before routes |
| `afterRoutes` | `(app: Hono) => void \| Promise<void>` | inside `createServer`, after routes/SSE |
| `afterStart` | `(instance: ServerInstance) => Promise<void>` | server listening; throwing is logged, not fatal |
| `beforeShutdown` | `() => Promise<void>` | shutdown Phase 4 (DB, Redis and job sends still open; bounded by the shutdown budget) |

---

## `startServer` vs `createServer`

`startServer(config?)` is the full boot path and returns a `ServerInstance`:

```typescript
const instance = await startServer({ port: 3000 });
instance.server;  // Node http.Server (ReturnType<typeof serve>)
instance.app;     // Hono app
instance.config;  // resolved ServerConfig
await instance.close(); // graceful shutdown (same path as SIGTERM)
```

Its startup sequence:

1. `loadEnv()` (env files → `process.env`)
2. Load + merge config file (see order below) with the runtime `config` argument — a
   file that exists and fails to load, or exports no plain object, rejects here, before
   anything listens
3. `validateServerConfig()` — throws on bad port/timeout/shutdown/healthCheck.path
4. `lifecycle.beforeInfrastructure` → init DB (unless disabled) → init Redis (unless
   disabled) → `lifecycle.afterInfrastructure` → init pg-boss + register jobs (if `.jobs()`)
   → init workflow engine (if `.workflows()`)
5. **Migration boot gate** — refuses to go further when a function package (or
   `src/server/drizzle`) has migrations the database has not applied (see below)
6. `createServer(config)` builds the Hono app (middleware pipeline below)
7. **Tenancy boot check** — with tenancy tables, refuses a production boot whose database
   role escapes their row-level security policy (see "Tenancy" in the db README). It runs
   after step 6, which imports a custom `app.ts` and the tables its routes use
8. `serve()` starts listening; WebSocket handler attached if `.websockets()`
9. Apply HTTP server timeouts + global `fetch()` (undici) timeouts
10. Print banner, register process handlers (`SIGTERM`, `SIGINT`, `uncaughtException`,
   `unhandledRejection`)
11. `lifecycle.afterStart(instance)`

`createServer(config?)` only does step 6 — it returns a configured `Hono` app **without
listening** and without infrastructure/shutdown. Use it for integration tests
(`app.request('/health')`) or when you call `@hono/node-server`'s `serve()` yourself.

### File-config loading order

`startServer()` and `spfn provision` load the file with one function,
`loadServerConfigFile(cwd)` (exported from `@spfn/core/server`). It scans these paths
(first found wins); `startServer()` merges the file **under** the runtime `config` argument:

```
.spfn/server/server.config.mjs   (built, highest priority)
.spfn/server/server.config.js    (built under "type": "module")
.spfn/server/server.config
src/server/server.config
src/server/server.config.ts      (source .ts, lowest)
```

`port`/`host` resolve as `runtime ?? file ?? env (PORT/HOST) ?? defaults (4000/localhost)`.

**A config file that exists and fails to load stops the boot.** If the first file found
fails to import — a syntax error, an import that does not resolve, or top-level code that
throws (`configureAuth()` refusing a policy value, for instance) — `startServer()` rejects
with `Refusing to start: <path> exists but failed to load: <the import error>` (also its
`cause`) and nothing listens. It does not fall back to a lower-priority file. Only an absent
file means "no configuration, use defaults".

**The default export must be a plain object** — what `defineServerConfig()…build()` returns,
or an object literal. A file with only named exports, `export default 42`, a builder without
`.build()`, or a promise refuses the same way, naming the file and what it exported. A
promise is not awaited: nothing ever documented an async config, and awaiting one would turn
a forgotten `await` elsewhere into a silent default. `spfn.config.js` (`loadAppConfig`)
follows the same rule: absent means defaults; present and failing to load, or exporting no
plain object, refuses. A CommonJS file compiled from TypeScript (`exports.default = { … }`)
counts as its `default`: the one interop wrapper Node's `import()` puts around it is removed
first.

When the file that failed is the unbuilt `src/server/server.config.ts` and node refused it
for being unbuilt — TypeScript it cannot run, or an import it cannot resolve, decided by the
error's `code` — the refusal adds the `spfn build` hint. An import that is simply missing
under tsx carries the same code as an unresolved alias, so the hint names both readings. Any
other failure (top-level code that throws, under `spfn dev` or anywhere) prints the cause
alone.

> **BREAKING:** the failure used to be logged and skipped, and the server came up on
> defaults — no middlewares, no routes, no lifecycle. An app that booted that way, knowingly
> or not, now refuses to start until its config loads. A production process holding only the
> unbuilt `src/server/server.config.ts` is one of them: run `spfn build`.

### Level 3: full control with `app.ts`

If `src/server/app.ts` (or `app.js`) exists, `createServer` imports its default export (an
`AppFactory = () => Promise<Hono> | Hono`) and uses **that** app instead of the
auto-configured pipeline. Config `routes` are still registered onto your app, but the
automatic middleware/health-check/SSE wiring is **skipped** — you own it.

```typescript
// src/server/app.ts
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import type { AppFactory } from '@spfn/core/server';

export default (async () =>
{
    const app = new Hono();
    app.use('*', compress());
    return app;
}) satisfies AppFactory;
```

---

## Auto-configured middleware pipeline

When there is no `app.ts`, `createServer` builds the app in this **fixed order**:

```
1. errorHandlerEnabled flag        (if middleware.errorHandler !== false)
2. RequestLogger(options)          (if middleware.logger !== false; an object is its options)
3. cors(config.cors)               (if middleware.cors !== false && cors !== false)
4. proxyGuard                      (if proxyGuard.mode !== 'off')
5. built-in server time            (GET /_core/time — unproven and session-free)
6. config.use[*]                   (raw custom middleware, in array order)
7. built-in health                 (GET /_core/health — unclaimable, always here;
                                    plus config.healthCheck.path when set)
8. lifecycle.beforeRoutes(app)
9. registerRoutes(app, routes, middlewares)
10. /health signpost               (GET /health → 410 naming /_core/health, for one
                                    release, and only if no app route declared GET on it)
11. SSE endpoint                   (if .events(): GET /events/stream [+ POST token])
12. lifecycle.afterRoutes(app)
13. app.onError(ErrorHandler(...)) (if middleware.errorHandler !== false)
```

- Each built-in is opt-out via `.middleware({ logger: false, cors: false, errorHandler: false })`.
- `.middleware({ logger: { excludePaths: ['/metrics'] } })` configures the request logger in
  place, still ahead of CORS and proxy-guard.
- **`proxyGuard`** is opt-in (`mode: 'off'` by default). When enabled via `.proxyGuard({...})`
  it verifies the trusted-proxy HMAC signature (`method+path+query+body`) + origin allowlist and
  tags `c.get('clientType')`. `tag` and `strict` evaluate every gate; only enforcement differs.
  Server time, health, SSE stream, and WS paths plus genuine CORS preflights are skipped
  automatically so bootstrap calls/probes/EventSource/preflight are never blocked. See
  `@spfn/core/middleware` and the root
  `PROXY-BACKEND-AUTH-SPEC.md`.
- `.middleware({ onError })` forwards an error callback into `ErrorHandler` (e.g. Slack
  notifier) — it runs async and does not block the response.
- Named `middlewares` (from `.middlewares()` / `.routes()`) are applied **per route** inside
  `registerRoutes`, respecting each route's `.skip([...])` / `.skip('*')`. Validation
  middleware is never skipped.

---

## Paths that must not be logged

A capability route carries its secret in the path: `/api/import/:token`, a share link, a
one-time download. Declare its prefix once:

```typescript
export default defineServerConfig()
    .logging({ redactPaths: ['/api/import'] })
    .routes(appRouter)
    .build();
```

Every core log line that names the request path then writes `/api/import/[redacted]`, at
every level: the request logger, proxy-guard, the error handler and its `onError` context,
rate limiting, and the transaction context of `Transactional()`.

- **Matching.** A prefix covers itself and what lies below it on a segment boundary:
  `/api/import` covers `/api/import` and `/api/import/abc`, not `/api/importer`. It is matched
  against the decoded path the router serves, so `/api/%69mport/abc` is covered too.
- **Refused entries.** An entry that does not start with `/`, ends with `/`, or contains `?`,
  `#`, `:` or `*` refuses the boot: the builder fails the config load, a plain config fails
  `validateServerConfig`, and `createServer` throws. A route pattern such as
  `/api/import/:token` would never equal a path, so it would redact nothing.
- **Undeclared paths** are written as they always were.
- **Your own lines.** Name the path with `loggedPath(c)` from `@spfn/core/middleware`; it
  applies the same declaration. `createServer` publishes the declaration before it builds
  anything, so a hand-written `app.ts` that wires its own `RequestLogger` and `ErrorHandler`
  gets it too. A bare Hono app without `createServer` calls `setRedactPaths([...])` itself.
- **`excludePaths` is a different thing.** It only silences the request logger's lines for a
  path (noise such as `/metrics`). The guard, the error handler and the rest still write their
  lines, with the path, unless the path is declared here.

What it does not cover:

- A proxy, load balancer or CDN in front of the server logs the path on its own.
- The Next.js RPC proxy runs in another process and cannot read this declaration, so none of its
  lines carries a param value: its debug lines `→ RPC request` (`targetPath`) and
  `Found N matching interceptors for <method> <path>` name the route's pattern
  (`/api/import/:token`) and `routeName`, not the path the params fill in.
- `@spfn/auth`'s log lines (its `API access` line and its warnings) read the path themselves
  until it moves to `loggedPath`.
- Prefer a request body over a path segment for a token where you can: a body reaches no
  access log.

---

## Infrastructure, jobs, events, websockets, workflows

**DB/Redis** initialize during step 4 unless turned off. The env vars are **not** sniffed
first, and the two behave differently when their env var is missing:

| | env var absent |
|---|---|
| Database | **boot fails** — `No database configuration found` |
| Redis | boots in disabled mode, logged, no cache |

So a server that uses no database must say so. Leaving `DATABASE_URL` unset is not how you
declare it:

```typescript
defineServerConfig()
    .infrastructure({ database: false })   // a server with no database declares it
    .build();
```

The asymmetry is deliberate. A missing cache costs speed; a missing database means every
request that touches data fails, and failing at boot beats failing on the first query.
A component turned off here reports `disabled` to the health endpoint and never degrades it.

To use an externally owned PostgreSQL Drizzle driver such as PGlite, pass a provider. This
replaces environment-based postgres.js initialization; graceful shutdown invokes `close`
once. The driver remains an application dependency, not an `@spfn/core` runtime dependency.

```typescript
const client = await PGlite.create('file://./data/app');
const db = drizzle(client, { schema });

defineServerConfig()
    .database({
        provider: {
            kind: 'pglite',
            write: db,
            close: () => client.close(),
        },
    })
    .build();
```

**Jobs** (`.jobs(jobRouter)`) require a database — `startServer` throws
`'Jobs require database connection.'` if `DATABASE_URL` is unset. pg-boss is started and
jobs registered after `afterInfrastructure`.

**Events** (`.events(eventRouter)`) register an SSE stream at `/events/stream` (override via
`{ path }`). With `{ auth: { enabled: true } }`, a `POST /events/token` endpoint is also
registered, guarded by your app's named middleware — both `.middlewares([...])` and the
router's `.use([...])`; if a cache (Redis/Valkey) is available it's
used as the token store automatically (multi-instance safe), else in-memory.

**WebSockets** (`.websockets(wsRouter)`) attach a WS handler at `/ws` (override via
`{ path }`); `{ auth: { enabled: true } }` adds a token endpoint the same way as SSE. The
token path replaces the WS path's **last segment** with `token`, so the default `/ws`
yields **`POST /token`** — not `/ws/token`. A custom `{ path: '/api/ws' }` yields
`POST /api/token`.

**Workflows** (`.workflows(workflowRouter)`) require database enabled — throws otherwise —
and call the router's `_init(getDatabase(), workflowsConfig)` after infrastructure.

---

## Graceful shutdown & `ShutdownManager`

`SIGTERM`/`SIGINT` (and `instance.close()`) start a shutdown with one deadline:
`shutdown.timeout` (env `SHUTDOWN_TIMEOUT`, default 280000ms) from the moment it starts. On a
signal the forced exit (`process.exit(1)`) fires at that same deadline.

```
beginShutdown()                    health → 503, trackOperation() now rejects
Phase 1  HTTP server.close()       stop new connections (≤5s), finish in-flight requests
Phase 1.5 WS cleanup               (if websockets; ≤5s)
Phase 2  stopFetching(wait)        (if jobs) every worker on getBoss() stops fetching, and the
                                   fetches in flight are waited for (≤5s, within the half of
                                   the work share HTTP leaves); running handlers continue,
                                   send() keeps working. The wait may take up to 5s the drain
                                   would otherwise get, never the drain's guaranteed half; when
                                   the closes used their whole half it is 0ms, Phase 2 reports
                                   the fetch in flight, and a job it takes starts on the
                                   stopping instance — the warning is the record
Phase 3  ShutdownManager.drain()   wait for tracked operations and after-commit callbacks
Phase 3.5 ShutdownManager.runHooks() onShutdown hooks, in order   ┐ one hooks' budget
Phase 4  lifecycle.beforeShutdown()                               ┘
Phase 5  stopBoss(wait)            (if jobs) wait for running job handlers — and, within the
                                   same wait, for a fetch Phase 2 left in flight and the
                                   handlers its jobs start — fail the jobs of those still
                                   running, then stop pg-boss; sending stops here (≤31s)
Phase 6  closeDatabase, closeEventTransport, closeCache  (≤5s, ≤2s, ≤5s)
         process.exit(0)
```

**The job queue is two things.** Fetching stops in Phase 2: every worker stops polling, and
Phase 2 waits for the fetches already in flight to settle — a fetch that started before the
shutdown takes its jobs then, and they run here. Once Phase 2 has logged `Stopped job fetch`
the stopping instance takes no job, so a job that is due during the drain, or enqueued from
Phase 3 on, stays `created` for another instance (or for this app's next start). That covers
every worker started on the instance `getBoss()` returns — by `registerJobs()` or by the app's
own `getBoss().work(queue, handler)` (per-tenant or dynamic queues): core runs those workers
itself, on pg-boss's `fetch`/`complete`/`fail`, so it knows each fetch in flight. A `PgBoss`
the app constructs itself runs pg-boss's own workers, which a shutdown does not stop. From Phase 2 until the instance is
stopped, `getBoss().work(...)` **rejects** with an error saying the instance stopped fetching for
a shutdown — it starts no worker. Sending stays open until Phase 5: a tracked operation, an
after-commit callback, an `onShutdown` hook or `beforeShutdown` that enqueues as it finishes
puts its job in the queue. pg-boss's own timekeeping also runs until Phase 5 — a cron tick only
inserts the job row, which a running instance fetches; the stopping instance never runs it.
The wait for fetches in flight shares the first half of the work share with the HTTP and
WebSocket closes and is capped at 5s; it reserves nothing, so it cannot cut into the drain's
guaranteed half — but what the closes leave of their half, which the drain would otherwise get,
it may take, up to 5s (at the default timeout the drain is at least 195000ms, not 200000ms). A
fetch is one statement, so it normally settles at once; if one is still in flight when the wait
ends — a hung pool — Phase 2 logs `Job fetch not stopped: N fetch(es) still in flight …` (a
warning) instead of `Stopped job fetch`, because a job such a fetch takes still starts on this
instance; Phase 5 waits for it again with the handlers. Job handlers that were running may still be running
while `onShutdown` hooks and `beforeShutdown` run — do not close something a handler uses there.

**What the drain waits for.** Every operation passed to `trackOperation()` before the shutdown
began, and every **after-commit callback** (`onAfterCommit`) core starts — including one whose
transaction commits during the drain, or that another callback's transaction starts. A
callback counts until the promise it returns settles, so return the work rather than detaching
it if the shutdown must not cut it. The drain is done the first time it finds nothing in flight
(it checks every 500ms); work started after that is not waited for by it. The common case is a
**job handler** that commits while Phase 5 waits for it: its after-commit callbacks are not
waited for, and an enqueue among them fails once pg-boss closes (sending stops in Phase 5). A
job handler that enqueues should do it inside its transaction or before it returns, awaited —
not in `onAfterCommit` — so the handler's wait covers it.

**One budget rule** (`shutdown-budget.ts`). `shutdown.timeout` T is shared by proportion:

- **waiting for accepted work** — the HTTP close, the wait for job fetches in flight, then the
  drain — is entitled to **at least half**;
- the **hooks** — `onShutdown` hooks and `beforeShutdown`, one budget — to **a fifth**;
- the enabled **infrastructure closes** share the remaining **three tenths in proportion to their
  caps**, each never above its cap: `reserve_i = min(cap_i, 0.3 · T · cap_i / Σ caps of enabled)`.
  The caps: the job queue 2000ms (the stop's 1000ms minimum handler wait, kept from pg-boss +
  1000ms to fail what is left and close its pool), the database 5000ms, the event transport 2000ms, Redis 5000ms — each
  only when the server runs it; disabled infrastructure reserves nothing.

What the reserves do not need goes to the work: once `0.3 · T ≥ Σ caps` each close holds exactly
its cap and the drain gets `T − hooks − Σ caps`. Inside the work share, the HTTP close, the
WebSocket close and Phase 2's wait for job fetches in flight keep their own 5s caps and together
take at most half of it; the other half is the drain's, so a slow HTTP close or a hung fetch
cannot starve the drain. The fetch wait reserves nothing: it gets what the closes before it left
of that half. A reserve is time an earlier phase
cannot spend; time a phase does not use flows forward to the phases after it. So a phase starting
now gets

```
max(min(its own cap, time left − the reserves of the later phases that are enabled),
    min(its own reserve, time left))
```

There is one deadline, shared with the forced-exit timer; a phase is skipped (gets 0) only when
the deadline itself has passed. The hooks' budget is set when the drain ends: each `onShutdown`
hook gets the lesser of its `timeout` and what is left of it, then `beforeShutdown` gets the rest.
So a drain that never ends still leaves the hooks a fifth of the timeout, and when every phase
stays inside its budget the database closes before the forced exit with its reserve.

The budgets when every phase takes its whole budget, all infrastructure on (printed from
`createShutdownBudget`; ms):

| `shutdown.timeout` | HTTP + WS close + fetch wait (at most) | drain (at least) | hooks | jobs | database | event transport | Redis |
|---|---|---|---|---|---|---|---|
| 10000 | 2501 | 2501 | 2000 | 428 | 1071 | 428 | 1071 |
| 30000 | 7501 | 7501 | 6000 | 1285 | 3214 | 1285 | 3214 |
| 280000 (default) | 15000 | 195000 | 56000 | 2000 | 5000 | 2000 | 5000 |

An HTTP close that ends at once leaves its part to the fetch wait (up to 5s) and what that does
not use to the drain (at 10000: a drain of about 5000ms). So a hung fetch takes up to 5s from the
drain — the "drain (at least)" column already counts it (at the default, 195000 rather than
200000) — but never the drain's guaranteed half of the work share. When the HTTP and WebSocket
closes take their whole half, the fetch wait gets 0ms: Phase 2 reports a fetch still in flight as
such, and a job that fetch takes starts on the stopping instance — the warning is the record.

**Do not set `shutdown.timeout` below about 47s with every piece of infrastructure on** (below
about 17s with only the database): under `Σ caps / 0.3` the closes get less than their caps — the
database pool is given less than 5s to end, and the job queue gets less than its 2000ms
minimum, so when the drain and hooks use their shares, core fails running handlers' jobs without
waiting for them. And set it to at least twice the longest request or after-commit
callback that must finish: the work share is only guaranteed half.

**A job handler still running in Phase 5.** The outcome depends on the jobs' budget:

- **2000ms or more** (the normal case): core waits up to the budget minus 1000ms (at most 30s)
  for running handlers — and for a fetch Phase 2 reported still in flight. A handler that
  finishes in that time completes its job as usual.
- **Less than 2000ms** — a short `shutdown.timeout` (below about 47s with all infrastructure on)
  whose earlier phases took their whole budgets: the stop keeps pg-boss's 1000ms minimum wait,
  so it does not wait; it fails at once.

Either way, a handler still running when the wait ends has its job failed by core — pg-boss's own
stop fails only jobs its own workers hold, and core runs the workers — before pg-boss's pool
closes and before the database closes (output `"pg-boss shut down while active"`, as pg-boss
writes it):

- with attempts left (`retry_count < retryLimit`) the job goes to `retry` and runs again on a
  live instance after its retry delay — it is not lost, but the handler may have done part (or
  all) of its work already;
- on its last attempt it ends `failed` and is not run again.

The server logs it from what it observed: `N job handler(s) were still running when pg-boss
stopped; their jobs were failed …`, with each job's id and queue. The stop is abandoned only
when the jobs' budget is 0 (the deadline has passed) or the fail and pg-boss's pool close outlast the
1000ms held for them; on a signal `process.exit` follows, and the job stays `active` until its
expiry (`expireInSeconds`) before it is retried.

**Two runs of one job can overlap at a shutdown.** The cut handler is not stopped — pg-boss has no
way to abort it — and its code keeps running in the dying process: on a signal until
`process.exit`, which comes after Phase 6 (the database stays open up to 5s longer); after
`instance.close()` for as long as the process lives. Meanwhile its job is already `retry`, and a
live instance can fetch it as soon as the retry delay has passed — while the old handler still
writes. So:

- make every job handler **idempotent**, and know that check-then-act is not enough: both runs can
  check "not done yet" before either acts. Make the effect itself conditional — a unique
  constraint, an `INSERT … ON CONFLICT DO NOTHING`, an `UPDATE … WHERE state = 'pending'` whose row
  count says who won, or an external API's idempotency key;
- what an app can rely on: one fetch hands a job to one worker; the cut run's late completion is
  ignored (its job already moved on); the retry starts only after the retry delay, never before
  the stopping instance failed the job; the old run gets no signal that it was cut;
- keep `retryLimit` above 0 for a job that must not be lost to a deploy.

`uncaughtException` / `unhandledRejection` are **logged, not fatal** — the server keeps
running.

Obtain the singleton with `getShutdownManager()`:

```typescript
import { getShutdownManager } from '@spfn/core/server';

const shutdown = getShutdownManager();

// Register an independent cleanup hook (runs in Phase 3.5, ordered; sends still open)
shutdown.onShutdown('ai-client', async () => { await aiClient.close(); },
    { timeout: 5000, order: 10 });

// Track a long op so drain waits for it (rejects if already shutting down)
const result = await shutdown.trackOperation('ai-generate', aiService.generate(prompt));

// Reject new work early in a handler
if (shutdown.isShuttingDown())
{
    return c.json({ error: 'shutting down' }, 503);
}
```

| Method | Description |
|--------|-------------|
| `onShutdown(name, handler, opts?)` | Register cleanup hook. `opts.timeout` default 10000ms, cut to what the hooks' budget leaves; `opts.order` default 100 (lower runs first). Hook failure/timeout does not block later hooks. |
| `trackOperation(name, promise)` | Await + track an op; drain waits for it. **Throws** if shutdown already started. |
| `isShuttingDown()` | `true` once `beginShutdown()` ran (state ≠ `running`). |
| `getActiveOperationCount()` | Number of in-flight tracked operations, after-commit callbacks included. |

State machine: `running → draining → closed`. `beginShutdown()` / `execute()` are driven by
the server's shutdown sequence — application code uses the four methods above.

**The state belongs to one server run.** A completed `close()` (or signal shutdown) ends its
run: the next `getShutdownManager()` returns a fresh manager, and a later `startServer()` in the
same process starts `running`, tracks its own after-commit callbacks and answers health 200.
`startServer()` also replaces a manager whose shutdown began but never completed. Hooks do not
carry over from a run that shut down — register them again for the next run. What carries over
is a manager whose shutdown has not begun: hooks registered before `startServer()` belong to the
run it starts. After driving a shutdown by hand (`drain()` / `execute()`, e.g. in a test), call
`endShutdownRun(getShutdownManager())` from `@spfn/core/server`.

---

## Health check

`GET /_core/health`, always — that path belongs to `@spfn/core`, is registered before app
routes and cannot be claimed by one, which is what makes it the right target for a probe.
`GET /health` answers too (path configurable), unless the app declares a `GET` on it, in
which case the app's route wins and the built-in stays at `/_core/health`. `enabled: false`
turns off both. During shutdown it returns 503 `{ status: 'shutting_down' }` immediately
(k8s readiness signal).

- **Basic** (`detailed: false`, the production default): `{ status, timestamp }`, 200.
- **Detailed** (`detailed: true`, the dev default): adds
  `services.{database,redis}.status` — `connected` / `error` / `not_initialized` /
  `disabled` / `unknown`. Any DB `error`/`not_initialized` or Redis `error` ⇒
  `status: 'degraded'` and HTTP **503**. Also adds `migrations` (below).

A component turned off with `.infrastructure({ database: false })` reports `disabled`
and never degrades health — otherwise a server that legitimately has no database would
answer 503 forever and no readiness probe would ever let it into rotation.

The endpoint answers at `/_core/health`. `path` adds a second address for a probe path
you cannot change — it does not move the canonical one.

```typescript
defineServerConfig()
    .healthCheck({ path: '/api/health', detailed: true })
    .build();
```

> Both addresses are registered **before** app routes, so an app route on the configured
> path never runs. The server logs a warning naming the route when it sees one. Drop the
> `path` option, or move the route to a path your app owns.

### `migrations` in the detailed payload

```json
"migrations": {
  "status": "up_to_date",
  "pending": 0,
  "checkedAt": "2026-08-06T09:00:00.000Z",
  "targets": [
    { "name": "@spfn/auth", "total": 13, "applied": 13, "pending": 0, "pendingTags": [] }
  ]
}
```

- `status` — `up_to_date` / `pending` / `unknown`. `unknown` means there was nothing to
  check (no database, no migrations) or the check failed; `reason` says which. It is never
  conflated with `up_to_date`.
- The snapshot is recomputed at most once every **30 seconds**, so a readiness probe
  polling every few seconds adds no database round-trips.
- Migration state does **not** change the overall `status`. Reporting drift must not, by
  itself, pull a running deployment out of rotation — a probe that wants that asserts
  `migrations.pending === 0`.

---

## Migration boot gate

A function package ships its own migrations, so upgrading `@spfn/auth` can add columns the
database has never heard of. Such a server boots, passes its health check, and then fails
every request touching a new column with an opaque 500.

Step 5 of the startup sequence stops that: it compares what each installed function
package ships (and `src/server/drizzle`, where present) against what the database records
as applied, logs the ones still waiting, and throws `PendingMigrationsError`.

The check runs on the pool `initDatabase()` just opened — no second connection. Three
situations never produce a refusal:

| Situation | What happens |
|---|---|
| No database initialized, or no migrations shipped | Skipped |
| Database configured but unreachable | `initDatabase()` already threw; the gate never runs |
| The status query itself fails | Logged as "could not verify"; boot proceeds |

One status error does refuse: the project's bookkeeping table does not match
`src/server/drizzle` the way `spfn db migrate` matches it (a table written before
drizzle-orm 1.0 with a row no folder matches, or the drizzle-kit ≤0.31 `meta/_journal.json`
layout). Migrate refuses that database, so the server would never be brought up to date; the
gate logs `bookkeeping does not match local migrations` and throws `PendingMigrationsError`
naming the project target. The opt-outs below do **not** apply to it: they mean "start although
migrations are still to be applied", and here nothing applied later repairs the bookkeeping —
the refusal says so. Fix the bookkeeping as the message says (`spfn db status` prints the same
text), then start. Detailed health reports it as `status: "unknown"` with that reason.

Opt out — a harness that migrates after boot, a rollout that must proceed — with any of:

```typescript
defineServerConfig().migrations({ allowPending: true }).build();   // config (wins)
```
```bash
SPFN_ALLOW_PENDING_MIGRATIONS=true    # env — for containers, which take no CLI flag
spfn dev --allow-pending-migrations   # CLI flag
```

All three log the pending list as a warning rather than continuing silently. None of them
starts a server whose project bookkeeping does not match (above).
`createServerlessApp()` has no boot to gate — run `spfn db migrate` as a deploy step there.

---

## Server time

`GET /_core/time` returns the server's current Unix epoch in milliseconds:

```json
{ "serverTimeMillis": 1750000000123 }
```

The endpoint is always enabled in the auto-configured pipeline. It is registered before
`config.use`, `lifecycle.beforeRoutes` and application routes, and proxy-guard skips it,
so a client can call it without a proof or session. The response contract is closed,
declares `serverTimeMillis` as an integer, and carries `Cache-Control: no-store`.

Production clients trust this value only over HTTPS with certificate validation. It is an
unsigned server fact, not an authentication policy: core does not define skew margins,
replay windows, retries, latency compensation or client-side offset storage.

The default clock is `Date.now()`. A deterministic server test can inject one:

```typescript
const config = defineServerConfig()
    .serverTime({ clock: { now: () => 1750000000123 } })
    .build();
```

Contract exporters should import `CORE_TIME_ROUTE` rather than restating its operation
identity, path, admission profile or response schema.

---

## Timeouts (HTTP + outbound fetch)

HTTP server timeouts (`.timeout({...})` or env), applied to the Node server after listen:

| Field | Env | Default | Purpose |
|-------|-----|---------|---------|
| `request` | `SERVER_TIMEOUT` | 120000 | whole request/response cycle |
| `keepAlive` | `SERVER_KEEPALIVE_TIMEOUT` | 65000 | idle connection reuse (keep > LB timeout) |
| `headers` | `SERVER_HEADERS_TIMEOUT` | 60000 | header receipt (Slowloris guard; must be ≤ `request`) |

Outbound `fetch()` (undici global dispatcher) — set via the `fetchTimeout` field on a
`ServerConfig` object or env (no builder method):

| Field | Env | Default |
|-------|-----|---------|
| `connect` | `FETCH_CONNECT_TIMEOUT` | 10000 |
| `headers` | `FETCH_HEADERS_TIMEOUT` | 300000 |
| `body` | `FETCH_BODY_TIMEOUT` | 300000 |

---

## Pitfalls & anti-patterns

- **Builder methods are not exports.** `events`, `jobs`, `websockets`, `cors`, etc. are
  methods on `defineServerConfig()`, not importable functions. Routes/middleware come from
  `@spfn/core/route`, not `@spfn/core/server`.
- **Middleware pipeline order is fixed and opt-out only.** You cannot reorder built-ins;
  you can only disable them via `.middleware({ logger:false, cors:false, errorHandler:false })`.
  CORS / logger run **before** custom `.use()` middleware; `ErrorHandler` is registered via
  `app.onError` **last**.
- **`.routes()` already merges router middlewares.** Calling `.middlewares()` *and*
  registering the same middleware via the router's `.use()` double-applies it. Prefer one.
- **`.lifecycle()` merges, every other method overwrites.** A second `.port()` wins; a
  second `.lifecycle()` *adds* hooks (run in order). Don't expect last-wins for lifecycle.
- **`afterStart` errors are swallowed.** They are logged but never thrown — the server is
  already listening. Don't rely on `afterStart` to abort startup; use
  `beforeInfrastructure` for fail-fast preconditions.
- **`createServer()` does not init infrastructure or shutdown.** `getDatabase()` /
  `getCache()` are not ready unless you initialized them yourself. For a real process use
  `startServer()`; reserve `createServer()` for tests / custom `serve()`.
- **Jobs/workflows require the database.** `.jobs()` throws without `DATABASE_URL`;
  `.workflows()` throws if `.infrastructure({ database: false })`.
- **Default port is 4000, not 8790.** The 8790 default is the CLI dev wrapper's concern;
  `PORT` env / `.port()` always win. Older docs showing 8790 as the programmatic default are
  stale.
- **No `app.ts` ⇒ auto pipeline; `app.ts` present ⇒ you own everything.** With `app.ts`,
  built-in middleware, health check, and SSE wiring are **not** added — only config `routes`
  are registered onto your app.
- **`headers` timeout must be ≤ `request`.** `validateServerConfig` throws
  `headers timeout (...) cannot exceed request timeout (...)`. Negative/non-finite
  port/timeout/shutdown values also throw at `startServer()` time.
- **Don't import `validateServerConfig` / `printBanner` / `ShutdownManager` from
  `@spfn/core/server`** — not in the public barrel. Use `getShutdownManager()`.
- **Strict proxy-guard cannot serve an unsigned capability route.** A share link or a token
  URL is opened directly by a browser, so it carries no proxy signature, and strict mode
  answers it 403. `proxyGuard.skipPaths` matches whole paths only (`/api/import/abc` is not
  covered by `/api/import`), so it cannot exempt a route whose path holds the token. Keep such
  routes on a server in `tag` mode, or call them through the RPC proxy.
- **`loadEnvFiles` is deprecated** (warns once). `startServer()` calls `loadEnv()` for you;
  only call `loadEnv` manually outside `startServer` (e.g. a script).

---

## Complete example

```typescript
// src/server/server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { defineRouter, route, defineMiddleware } from '@spfn/core/route';
import { getDatabase } from '@spfn/core/db';
import { getShutdownManager } from '@spfn/core/server';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { Type } from '@sinclair/typebox';

const auth = defineMiddleware('auth', async (c, next) =>
{
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    await next();
});

const appRouter = defineRouter({
    getUser: route.get('/users/:id')
        .input({ params: Type.Object({ id: Type.String() }) })
        .handler(async (c) =>
        {
            const { params } = await c.data();
            return { id: params.id };
        }),
    health: route.get('/ping').skip(['auth']).handler(async () => ({ ok: true })),
})
.use([auth]);

// Independent module cleanup — registered once, runs in shutdown Phase 3
getShutdownManager().onShutdown('message-queue', async () =>
{
    await closeMessageQueue();
}, { order: 10 });

export default defineServerConfig()
    .port(4000)
    .host('0.0.0.0')
    .routes(appRouter)                         // merges `auth` from .use()
    .middleware({ logger: true, cors: true })
    .cors({ origin: ['https://app.example.com'], credentials: true })
    .timeout({ request: 60000 })
    .healthCheck({ path: '/api/health', detailed: true })
    .shutdown({ timeout: 280000 })
    .lifecycle({
        afterInfrastructure: async () =>
        {
            await migrate(getDatabase(), { migrationsFolder: './drizzle' });
        },
    })
    .build();

export type AppRouter = typeof appRouter;
```

```typescript
// src/server/index.ts
import { startServer } from '@spfn/core/server';

const instance = await startServer();
// instance.server / instance.app / instance.config / instance.close()
```

```typescript
// integration test — no listen, no infra
import { createServer } from '@spfn/core/server';
import config from './server.config';

const app = await createServer(config);
const res = await app.request('/api/health');
```

---

## Types reference

```typescript
function startServer(config?: ServerConfig): Promise<ServerInstance>;
function createServer(config?: ServerConfig): Promise<Hono>;
function defineServerConfig(): ServerConfigBuilder;
function getShutdownManager(): ShutdownManager;

type AppFactory = () => Promise<Hono> | Hono;

interface ServerInstance
{
    server: ReturnType<typeof import('@hono/node-server').serve>;
    app: Hono;
    config: ServerConfig;
    close: () => Promise<void>;
}

interface ShutdownHookOptions
{
    timeout?: number;  // default 10000
    order?: number;    // default 100 (lower runs first)
}
// ServerConfig: see config-builder table above — port, host, cors, middleware, use,
// middlewares, routes, jobs/jobsConfig, events/eventsConfig, websockets/websocketsConfig,
// workflows/workflowsConfig, debug, database, timeout, fetchTimeout, shutdown, healthCheck,
// serverTime, infrastructure, lifecycle.
```

## Related

- [@spfn/core/route](../route/README.md) — `defineRouter`, `route`, `defineMiddleware`, `.skip()`
- [@spfn/core/env](../env/README.md) — `loadEnv`, schema/registry (`PORT`, `HOST`, timeout vars)
- [@spfn/core/job](../job/README.md) — `job`, `defineJobRouter` (pg-boss)
- [@spfn/core/event](../event/README.md) — `defineEvent`, `defineEventRouter` (SSE), WS router
- [@spfn/core/middleware](../middleware/README.md) — `RequestLogger`, `ErrorHandler`, CORS
