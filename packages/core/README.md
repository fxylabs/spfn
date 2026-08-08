# @spfn/core

> **The backend runtime for taking an AI-built app from prototype to production**

`@spfn/core` is the package every SPFN app is built on. It decides the shape of a
feature — an entity, a repository, a route, a router registration — so that neither you
nor your coding agent has to invent one per feature. Everything else in SPFN
(`@spfn/auth`, `@spfn/mcp`, `@spfn/storage`, …) plugs into it.

Fixing the shape is an answer to [architecture drift](https://superfunction.xyz/architecture-drift)
— a codebase acquiring several structures because each feature was arranged freshly. The
usual answers detect it after the fact; this one leaves nothing to decide. It removes
drift that comes from structural choice, and nothing else: two services can still
implement the same rule differently inside a correct shape.

📖 **[superfunction.xyz](https://superfunction.xyz)** — docs and the full-stack tutorial ·
[repository README](https://github.com/fxylabs/spfn) for the whole framework.

> **Status — Beta (`0.x`).** The public API is stabilizing but may still change between
> minor releases before `1.0`. Pin your version and install from the `@beta` tag.

---

## What is @spfn/core?

A TypeScript backend runtime with four parts, used together:

- **A route DSL** — `route.get(path).input({...}).handler(...)`, validated at runtime by
  TypeBox and typed at compile time from the same schema.
- **A data layer** — PostgreSQL through Drizzle ORM, with `BaseRepository`, schema
  helpers, and transactions that propagate automatically.
- **A server** — a Hono app you start as a long-lived process, or mount as serverless
  functions on Vercel.
- **A Next.js bridge** — an RPC proxy and a typed client, so a route's input and output
  types are the same object on both sides of the network.

What it is not: a frontend framework, an ORM, or a place to keep your business rules.
Next.js owns the frontend, Drizzle owns the SQL, and your services own the rules.

---

## How do I install it?

```bash
pnpm add @spfn/core@beta drizzle-orm@1.0.0-rc.4 postgres pg
# optional peer: next ^16.2.11   (only for the Next.js bridge)
```

Node `>=20.0.0`. ESM only.

> **Declare Drizzle and the Postgres drivers in your own app, not just in SPFN.**
> `@spfn/core` takes `drizzle-orm` as a peer dependency, and Drizzle changes how it
> resolves types depending on which driver packages are present. If your app does not
> pin the same ORM and drivers, pnpm can install a second copy of Drizzle — and then
> `BaseRepository` generics collapse to `unknown` and your RPC responses lose their
> types. `spfn create` adds these for you; add them by hand only when wiring SPFN into
> an app that already exists.

Optional dependencies, installed only if you use the feature: `ioredis` (cache) and
`ws` (WebSocket events). `pg-boss` ships as a direct dependency for background jobs.

---

## What does one feature look like?

Four files, always the same four, always in the same places:

```
src/server/
  entities/order.ts        # the data shape (Drizzle table)
  repositories/order.ts    # persistence (extends BaseRepository)
  routes/orders.ts         # the validated API contract
  router.ts                # registration
```

The point is not that this arrangement is uniquely correct. The point is that it is
decided. An agent asked for "add orders" twice produces the same code twice, because
there is nothing left to choose.

---

## How does a route's type reach the browser?

Through TypeScript inference, not generated client code. One artifact is generated —
the route map the RPC proxy needs — and nothing else.

```
 ① route DSL            ② defineRouter           ③ defineServerConfig → startServer
 route.get('/users/:id')   defineRouter({ getUser,    defineServerConfig()
   .input({ params })        createUser })               .routes(appRouter).build()
   .handler(c => …)        export type AppRouter        startServer()  →  Hono on :8790
        │                       = typeof appRouter            ▲
        │ TypeBox = runtime validation + compile-time types   │ registerRoutes mounts routes
        ▼                                                     │
 ④ codegen (@spfn/core:route-map)  ──►  routeMap = { getUser: { method:'GET', path:'/users/:id' }, … }
        │
        ▼
 ⑤ Next.js RPC proxy                         ⑥ typed client
 app/api/rpc/[routeName]/route.ts            lib/api.ts
 createRpcProxy({ routeMap })                createApi<AppRouter>()   (no codegen for the client)
   GET/POST /api/rpc/{routeName}               api.getUser.call({ params:{ id } })
   resolves real method+path from routeMap       └─ fully typed input + output
   forwards to backend, runs interceptors
```

1. **Define a route** with `route.<method>(path).input({...}).handler(c => …)` from
   `@spfn/core/route`. The TypeBox schemas in `.input()` do double duty: they validate
   the request at runtime and give the handler (`await c.data()`) and the client their
   compile-time types. The handler's **return type is inferred** — you never write a
   response type.
2. **Compose routes** with `defineRouter({ … })` and export
   `type AppRouter = typeof appRouter`. That type is the single source of truth for the
   client.
3. **Boot the server** with `defineServerConfig().routes(appRouter).build()` and
   `startServer()` from `@spfn/core/server`. It wires `ErrorHandler` and
   `RequestLogger`, initializes the database and cache, mounts the routes, and starts
   jobs and events. A request goes: Hono match → global middleware → route middleware
   (`.use([...])`, e.g. `Transactional()`) → input validation → handler → response.
4. **Generate the route map** with `pnpm codegen`. It emits
   `routeName → { method, path }` — the only thing the proxy needs to find the real
   backend endpoint.
5. **Mount the RPC proxy** in Next.js as the `app/api/rpc/[routeName]/route.ts`
   catch-all. The browser only ever sends `GET` (no body) or `POST` (body or formData)
   to `/api/rpc/{routeName}`; the proxy looks up `routeMap[routeName]`, substitutes
   `:params`, and forwards with the real method. Package route maps (`authRouteMap`,
   `eventRouteMap`) merge into the same map.
6. **Call it** through `createApi<AppRouter>()`. The client is a `Proxy` over the
   `AppRouter` type — typed in and out, with no runtime cost for the types. Errors
   arrive as `ApiError`, or as the original error class when that class is registered in
   the client's `errorRegistry`.

---

## Show me the whole thing in code

```typescript
// server/router.ts — ① + ②
import { defineRouter, route } from '@spfn/core/route';
import { Transactional } from '@spfn/core/db';
import { Type } from '@sinclair/typebox';

export const appRouter = defineRouter({
    getUser: route.get('/users/:id')
        .input({ params: Type.Object({ id: Type.String() }) })
        .handler(async (c) =>
        {
            const { params } = await c.data();   // params.id: string
            return { id: params.id, name: 'John' };   // return type inferred
        }),

    createUser: route.post('/users')
        .input({ body: Type.Object({ name: Type.String() }) })
        .use([Transactional()])                  // commit on return, rollback on throw
        .handler(async (c) =>
        {
            const { body } = await c.data();
            return { id: '2', name: body.name };
        }),
});

export type AppRouter = typeof appRouter;
```

```typescript
// server/index.ts — ③
import { defineServerConfig, startServer } from '@spfn/core/server';
import { appRouter } from './router';

export default defineServerConfig().port(8790).routes(appRouter).build();
await startServer();   // Hono on :8790
```

```typescript
// app/api/rpc/[routeName]/route.ts — ⑤  (server-only)
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { routeMap } from '@/generated/route-map';   // ④ codegen output

export const { GET, POST } = createRpcProxy({ routeMap });
```

```typescript
// lib/api.ts — ⑥  (client-safe; no codegen)
import { createApi } from '@spfn/core/nextjs';
import type { AppRouter } from '@/server/router';

export const api = createApi<AppRouter>();

// anywhere — server component, client component, or server action:
const user = await api.getUser.call({ params: { id: '123' } });    // typed { id, name }
const made = await api.createUser.call({ body: { name: 'A' } });
```

---

## Which import path do I use for what?

There is **no root barrel**: `import … from '@spfn/core'` does not resolve. Every symbol
comes from a subpath, and the table below is the complete public surface — one row per
entry in `package.json` `exports`. Each module has its own README with the API detail.

| Import path | Purpose | Doc |
|-------------|---------|-----|
| `@spfn/core/route` | The route DSL (`route.get(...).input(...).handler(...)`) plus `defineRouter`, `registerRoutes`, `defineMiddleware`. The core of the core. | [src/route](./src/route/README.md) |
| `@spfn/core/route/types` | Shared route types (`HttpMethod`, router type primitives). | [src/route](./src/route/README.md) |
| `@spfn/core/server` | Server entry: `defineServerConfig()` → `startServer()`, plus `createServerlessApp()` for Vercel. Middleware wiring, infra init, graceful shutdown. | [src/server](./src/server/README.md) |
| `@spfn/core/nextjs` | Client-safe: `createApi<AppRouter>()`, `ApiError`, client types. Never touches `next/headers`. | [src/nextjs](./src/nextjs/README.md) |
| `@spfn/core/nextjs/server` | Server-only: `createRpcProxy({ routeMap })`, `registerInterceptors`. Uses `next/headers`. | [src/nextjs](./src/nextjs/README.md) |
| `@spfn/core/db` | PostgreSQL through Drizzle: CRUD helpers, `BaseRepository`, schema helpers, transactions, Postgres error mapping. One entry point for all of it. | [src/db](./src/db/README.md) |
| `@spfn/core/db` → manager | Connection lifecycle, pool, primary/replica, health check, reconnect (`initDatabase`, `getDatabase`). Re-exported from `@spfn/core/db`. | [src/db/manager](./src/db/manager/README.md) |
| `@spfn/core/db` → migrations | Which migrations each installed function package ships, and which the database has applied (`collectMigrationStatus`, `discoverFunctionMigrations`). What `spfn db status`, the boot gate and health all read. Re-exported from `@spfn/core/db`. | [src/db/migrations](./src/db/migrations/index.ts) |
| `@spfn/core/db` → schema | Drizzle column helpers (`id`, `uuid`, `timestamps`, `foreignKey`, `enumText`, `typedJsonb`, `softDelete`, …). Re-exported from `@spfn/core/db`. | [src/db/schema](./src/db/schema/README.md) |
| `@spfn/core/db` → transaction | `Transactional()` middleware and `runInTransaction`; the transaction reaches every repository through AsyncLocalStorage. Re-exported from `@spfn/core/db`. | [src/db/transaction](./src/db/transaction/README.md) |
| `@spfn/core/middleware` | Built-in Hono middleware: `ErrorHandler`, `RequestLogger` and its masking helper. | [src/middleware](./src/middleware/README.md) |
| `@spfn/core/errors` | Serializable HTTP and database error classes, plus `ErrorRegistry` so an error survives the trip to the client as its own class. | [src/errors](./src/errors/README.md) |
| `@spfn/core/security` | `safeFetch` — a drop-in `fetch` hardened against SSRF, including DNS rebinding, by pinning the connection to a validated IP. | [src/security](./src/security/README.md) |
| `@spfn/core/authz` | Ownership guards. `requireOwner(resource, userId)` makes "load it, then check it belongs to the requester" one call, so a handler cannot forget it. | [src/authz/index.ts](./src/authz/index.ts) |
| `@spfn/core/env` | Schema-based environment validation, isomorphic. | [src/env](./src/env/README.md) |
| `@spfn/core/env/loader` | The **server-only** `.env` file loader (uses `node:fs`). | [src/env](./src/env/README.md) |
| `@spfn/core/config` | `@spfn/core`'s own validated env config (`env`, `envSchema`, `registry`), built on `@spfn/core/env`. | [src/config](./src/config/README.md) |
| `@spfn/core/logger` | Structured singleton `logger` with child loggers and level masking. No dependencies. | [src/logger](./src/logger/README.md) |
| `@spfn/core/cache` | Valkey/Redis singleton over ioredis (`getCache`, `getCacheRead`). Degrades to disabled rather than throwing. | [src/cache](./src/cache/README.md) |
| `@spfn/core/job` | Background jobs on pg-boss: a fluent `job()` builder, cron, run-once, event-driven, `defineJobRouter`. | [src/job](./src/job/README.md) |
| `@spfn/core/event` | Decoupled pub/sub (`defineEvent`, `defineEventRouter`, `eventRouteMap`). | [src/event](./src/event/README.md) |
| `@spfn/core/event/sse` | Server-side SSE handler and token manager. Server only. | [src/event](./src/event/README.md) |
| `@spfn/core/event/sse/client` | Browser SSE client (`EventSource`). | [src/event](./src/event/README.md) |
| `@spfn/core/event/ws` | Server-side WebSocket handler. Server only; needs the optional `ws` dependency. | [src/event](./src/event/README.md) |
| `@spfn/core/event/ws/client` | Browser WebSocket client. | [src/event](./src/event/README.md) |
| `@spfn/core/codegen` | The codegen orchestrator and the built-in generators: `@spfn/core:route-map` for the proxy's route map, `@spfn/core:contract` for the client contract. | [src/codegen](./src/codegen/README.md) |
| `@spfn/core/contract` | Route contracts for clients that ship separately: collect, snapshot, and the build gate that refuses a breaking change. | [src/contract](./src/contract/README.md) |

`db/manager`, `db/schema` and `db/transaction` are **not** package subpaths of their own.
They are internal modules re-exported by `@spfn/core/db` — import their symbols from
there.

---

## Do I have to run codegen?

Only for the RPC proxy, and only after you change routes.

| Change | What to run |
|---|---|
| Added, renamed or removed a route | `pnpm codegen`, then commit the regenerated route map |
| Changed a route's input or output types | Nothing — the client infers from `AppRouter` |
| Changed an entity | `pnpm db:generate` for the migration |

A route name that is missing from the merged route map produces a **404 from the proxy**,
not from your backend. That is almost always a codegen you did not re-run.

Generated files are output. Never hand-edit them.

---

## Why does the server refuse to start after a package upgrade?

Because the database is behind the code. A function package ships its own migrations, so
bumping `@spfn/auth` can add columns your database has never heard of. Before this check
existed, that server booted, passed its health check, and then failed every request
touching a new column with an opaque 500 — the error surfaced at the worst possible
moment, to whoever called first.

`startServer()` now compares what each installed function package ships (and
`src/server/drizzle`, where present) against what the database records as applied, and
stops:

```
Refusing to start: 1 pending migration(s) in @spfn/auth
  @spfn/auth: 1 pending migration(s) (12/13 applied)
      - 20260805143152_client_identity
  Run: pnpm spfn db migrate
```

The check happens after the database connects and before anything is served, on the pool
the server already opened — no second connection, and no new failure mode. Three cases
never reach a refusal:

| Situation | What happens |
|---|---|
| The app initializes no database, or no package ships migrations | Skipped; boot proceeds as before |
| The database is configured but unreachable | `initDatabase()` already failed — the gate never runs, so an outage never reads as drift |
| The status query itself fails | Logged as "could not verify", boot proceeds |

To start anyway — a harness that migrates after boot, a rollout that must proceed —
set `SPFN_ALLOW_PENDING_MIGRATIONS=true`, pass `spfn dev --allow-pending-migrations`, or
declare it in config:

```typescript
export default defineServerConfig()
    .migrations({ allowPending: true })
    .build();
```

All three log the pending list as a warning rather than silently continuing.

**A readiness probe sees the same thing.** When detailed health is on, `GET /health`
carries a `migrations` object beside `services`:

```json
{
  "status": "ok",
  "timestamp": "2026-08-06T09:00:00.000Z",
  "services": { "database": { "status": "connected" }, "redis": { "status": "connected" } },
  "migrations": {
    "status": "up_to_date",
    "pending": 0,
    "checkedAt": "2026-08-06T09:00:00.000Z",
    "targets": [{ "name": "@spfn/auth", "total": 13, "applied": 13, "pending": 0, "pendingTags": [] }]
  }
}
```

`status` is `unknown` when there was nothing to check or the check failed — never
conflated with `up_to_date`. The snapshot is recomputed at most once every 30 seconds, so
a probe polling every few seconds costs no extra round-trips. The overall health `status`
is deliberately left alone: reporting drift must not, by itself, pull a running
deployment out of rotation. A probe that wants that asserts `migrations.pending === 0`.

The serverless path (`createServerlessApp`) has no boot to gate — run
`spfn db migrate` as a deploy step there, as you already do for seeding.

---

## Can I deploy this to Vercel?

Yes, and it is a first-class target rather than a workaround. From your app:

```bash
spfn add vercel
```

That scaffolds `src/app/api/backend/[[...route]]/route.ts` (a `hono/vercel` adapter) and
`vercel.json`. The SPFN app mounts under `/api/backend`, so the Next.js frontend and the
backend share one Vercel origin — point `SPFN_API_URL` at
`https://<your-domain>/api/backend`. It runs on the Node runtime, not edge, because SPFN
needs `pg` and native `bcrypt`.

The adapter is a thin wrapper around `createServerlessApp` from `@spfn/core/server`:

```typescript
import { handle } from 'hono/vercel';
import { createServerlessApp } from '@spfn/core/server';
import serverConfig from '@/server/server.config';

const handler = async (req: Request) => handle(await createServerlessApp(serverConfig))(req);
export const GET = handler;
export const POST = handler;
```

It differs from `startServer()` in four ways, all forced by the platform:

| | Always-on (`startServer`) | Serverless (`createServerlessApp`) |
|---|---|---|
| Database init | welded to `serve()` | in the handler, once per warm container |
| Periodic DB health check | on | off — a timer only leaks across frozen invocations |
| Background job worker | runs in-process | **not started** — enqueuing works, nothing drains the queue |
| Seed and RBAC provisioning | per boot | a deploy-time step (`provisionInfrastructure`) |

The job worker is the one that bites. If your config declares jobs, the serverless path
logs a warning at startup: drain the queue from a scheduled endpoint (Vercel Cron calling
a route that processes a batch), or run jobs on an always-on target.

Background jobs, WebSocket events and the periodic health check all need the always-on
path: `spfn build && spfn start`, or the generated Docker files.

---

## How do I point Claude Code or another AI coding agent at this?

Put the contract in a file and let the agent read it, instead of describing the
architecture again in every prompt.

The SPFN repository states it in `CONTRIBUTING.md`: what the repo is, the commands, the
vertical-slice pattern, and the rules that are not negotiable — never hand-edit generated
files, migrations come from the schema. One file answers to people and agents alike, so
there is no second copy to drift apart from the first.

Each module README under `src/` is written for the same reader. When an agent is working
on database code, `src/db/README.md` is the page to give it.

---

## How do I operate the app from the terminal?

Develop operations the way you develop features — as routes — and let the `spfn ops` CLI
discover and invoke them. No admin dashboard, and no extra vocabulary: an ops command is a
vertical slice whose path lives under `/_ops/`.

```typescript
// src/server/ops.ts
import { Type } from '@sinclair/typebox';
import { createOpsRouter, opsRoute } from '@spfn/core/ops';
import { opsTokenAuth, requireOpsScope } from '@spfn/auth/server';

export const opsRouter = createOpsRouter({
    listSignups: opsRoute.get('/signups')                    // GET /_ops/signups
        .use([requireOpsScope('waitlist:read')])
        .input({ query: Type.Object({ limit: Type.Optional(Type.Number()) }) })
        .handler(async (c) => signupsRepository.list((await c.data()).query.limit)),
}, { auth: opsTokenAuth });

// src/server/router.ts — mounted like any package router, invisible to client types
export const appRouter = defineRouter({ ... }).packages([opsRouter]);
```

`opsRoute` is `route` with the `/_ops` namespace applied, so a definition carries only the
path this app owns — what that path looks like, how it nests, which segments are
parameters are the app's decisions. It exists from `@spfn/core` **0.3.0-beta.2**.
`createOpsRouter` injects the auth middleware into every route (there is no
unauthenticated variant) and serves `GET /_ops/_manifest` — the self-description the CLI
reads, with each command's TypeBox schemas as JSON Schema.

The manifest is registered ahead of the ops routes, so none of them can take its URL even
when one is a pattern like `/_ops/:name`. That ordering does not reach outside the ops
router: routes an app declares in its own router are registered before any package router,
so a pattern there that covers `/_ops/_manifest` — a `/*` catch-all, say — shadows the
manifest, exactly as it shadows every other package route.

Routes may be grouped in nested `defineRouter`s, and a group's own `.use()` middlewares
apply to its routes — always after the injected auth, so a group-wide guard reads a
request that has already been authenticated. A group-level middleware must be a named one;
wrap a factory to give it a name:

```typescript
const requireAdmin = defineMiddleware('opsAdminScope', requireOpsScope('admin:read'));

export const opsRouter = createOpsRouter({
    admin: defineRouter({ getStats, reindex }).use([requireAdmin]),
}, { auth: opsTokenAuth });
```

Note that a group's `.use()` middleware carries its `skips` into every route in the group,
suppressing that server-level middleware there.

Three things are refused when the surface is defined, rather than discovered in
production: a route built with `route` instead of `opsRoute` (it would carry no
namespace), two routes sharing a command name (the manifest flattens nested groups into
one list, so the CLI could not tell them apart), and a group mounting `.packages()` (those
routes register with neither the namespace nor the auth injection). The command name
`getOpsManifest` and the path `/_ops/_manifest` are reserved.

```bash
spfn ops list --app https://api.example.com          # discover commands
spfn ops call listSignups --query limit=50            # invoke one
spfn ops call listSignups --describe                  # print its usage (--json for raw schemas)
```

Authentication is an ops token from [`@spfn/auth`](../auth/README.md#ops-tokens-spfn-ops):
scoped, revocable, hash-stored, issued with `spfn ops token issue` against the running app
— the CLI signs in as an administrator, so issuance needs no database access. On macOS the
CLI keeps the token in the keychain (`spfn ops token store`), and resolution order is
`--token` → `SPFN_OPS_TOKEN` → keychain.

---

## How is this different from NestJS or tRPC?

**NestJS** gives you a structured backend and leaves the structure to you: modules and
providers you design, validation and ORM of your choosing, DTOs you keep in sync with the
frontend by hand. It is the better fit when you need that freedom, or when your frontend
is not Next.js. `@spfn/core` fixes the shape instead — one vertical slice per feature,
TypeBox, Drizzle, and route types that reach the browser without a DTO layer. Its
ecosystem is small and young where NestJS's is large and mature.

**tRPC** solves a narrower problem, typed calls between client and server, and leaves
structure, persistence and auth to you. `@spfn/core` includes the typed-call layer as one
part of a whole backend.

---

## Pitfalls

- **There is no root barrel.** `import … from '@spfn/core'` does not resolve. Import from
  a subpath. The module table above is the complete surface.
- **Use `@spfn/core/nextjs` for the client, not `@spfn/core/client`.** `package.json`
  still lists a `./client` export, but the build does not emit it — the entry is disabled
  and there is no `src/client`. `createApi`, `ApiError` and every client type ship from
  `@spfn/core/nextjs`. Treat `@spfn/core/client` as non-functional.
- **The client/server boundary is load-bearing.** `@spfn/core/nextjs/server` pulls in
  `next/headers` and `next/server`; importing it from a Client Component breaks the
  build. `@spfn/core/env/loader`, `@spfn/core/event/sse` and `@spfn/core/event/ws` are
  server-only too. Client code uses the `*/client` and isomorphic entry points.
- **`db/manager`, `db/schema` and `db/transaction` are not subpaths.** Importing
  `@spfn/core/db/transaction` fails to resolve. Import those symbols from `@spfn/core/db`.
- **The client needs no codegen; the proxy does.** A missing route name is a proxy 404.
- **Contracts are for clients TypeScript cannot reach.** `.contract()` and the build gate
  exist for a mobile app or an external consumer, compiled and shipped separately. A web
  client takes its types from `AppRouter` in the same build, so a removed response field
  already breaks the compile. Do not put `.contract()` on a route only the web app calls.
- **The proxy decides the real HTTP method.** The browser only sends GET or POST to
  `/api/rpc/...`; a PUT, PATCH or DELETE route still works because the method comes from
  the route map.
- **A package upgrade is not done until `spfn db migrate` has run.** The server refuses to
  start while a function package has migrations the database has not applied. That is the
  gate working, not a bug — see
  [Why does the server refuse to start after a package upgrade?](#why-does-the-server-refuse-to-start-after-a-package-upgrade)
- **Cache, events and jobs degrade quietly.** `@spfn/core/cache` runs disabled — its
  getters return `undefined` — when there is no cache config or no `ioredis`, and
  WebSocket events need the optional `ws` dependency. Do not write code expecting them to
  throw.

---

## FAQ

**Can I use @spfn/core without Next.js?**
Yes. `next` is an optional peer dependency and the Next.js bridge is two modules
(`@spfn/core/nextjs`, `@spfn/core/nextjs/server`). The server runs on Hono by itself. You
give up the typed client and the RPC proxy, which are the Next.js-side pieces.

**Can I use Prisma instead of Drizzle?**
No. `drizzle-orm` is a required peer dependency (`>=1.0.0-rc.4 <2`) and the repository
layer is built on it.

**Do I need Redis?**
Only for features that use it. `ioredis` is an optional dependency, and without cache
configuration the cache module reports itself disabled instead of failing. The same holds
for `ws` and WebSocket events.

**Does @spfn/core require PostgreSQL specifically?**
Yes, 14 or later. The data layer is Drizzle on Postgres, with `postgres.js` as the
default driver; the provider is injectable, which is how PGlite works in tests.

**Why can't I import from `@spfn/core` directly?**
There is no `.` entry in `exports` — by design. Subpaths keep server-only code out of
client bundles, which a single barrel file cannot do.

**Which Node version?**
`>=20.0.0`. The package is ESM only.

**Where do my business rules go?**
In services and repositories, not in route handlers. A handler validates, calls, and
returns. `@spfn/core/authz` covers the one rule that is easy to forget: `requireOwner`
returns the resource only if it belongs to the requester, and answers "not found" either
way so the endpoint never reveals that someone else's record exists.

---

## Related packages

Other SPFN packages build on `@spfn/core`:

- [`@spfn/auth`](../auth/README.md) — sessions, social login and RBAC. Exports
  `authRouteMap` and registers proxy interceptors automatically; merge its route map into
  `createRpcProxy`.
- [`@spfn/mcp`](../mcp/README.md) — exposes your operations as MCP tools, so an agent can
  run them instead of you building an admin dashboard.
- `@spfn/i18n`, `@spfn/storage`, `@spfn/notification`, `@spfn/cms`, `@spfn/monitor`,
  `@spfn/migrate`, `@spfn/workflow` — see each package's README under
  [`packages/`](../).

---

## License

MIT © FXY Inc.
