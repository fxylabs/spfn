# 01 · Minimal API

The smallest possible SPFN app — **one route, one typed client call, no database**.
Start here to understand the core request path before adding persistence (see
[02 · Database CRUD](../02-database-crud)).

## What it shows

| File | Concept |
| --- | --- |
| `src/server/routes/greeting.ts` | A route: `route.get(path).input({...}).handler(...)` with TypeBox validation |
| `src/server/router.ts` | `defineRouter({...})` — composes routes; its type is the client contract |
| `src/server/server.config.ts` | `.infrastructure({ database: false })` — a server with no database must say so, or boot fails asking for `DATABASE_URL` |
| `src/app/api/rpc/[routeName]/route.ts` | `createRpcProxy({ routeMap })` — forwards browser calls to the API server |
| `src/lib/api-client.ts` | `createApi<AppRouter>()` — one fully typed client |
| `src/app/page.tsx` | A Server Component that actually calls `api.getGreeting.call(...)` |

```
page.tsx ──api.getGreeting.call()──▶ /api/rpc/[routeName] ──▶ SPFN API server ──▶ greeting route
```

No entities, no repositories, no Postgres — just the typed edge from UI to handler.

## Run it

> Prerequisites: Node ≥ 20, pnpm. No database needed.

From the repo root, `pnpm install`. Then in this directory:

```bash
pnpm codegen     # generates src/generated/route-map.ts
pnpm spfn:dev    # runs the API server (:8790) + Next.js (:3790) together
```

No `.env` file is needed: the API server listens on `8790` (`src/server/server.config.ts`)
and the `/api/rpc` proxy falls back to `http://localhost:8790` when `SPFN_API_URL` is
unset. Set `SPFN_API_URL` in a `.env.local` only if you move the API server.

Open `http://localhost:3790` and you'll see the live JSON returned by the `greeting`
route. Try the API directly too: `curl 'http://localhost:8790/greeting?name=You'`.

`GET /health` answers as well, and it is not one of the app's routes — the server
serves it itself. That is why the app defines only `greeting`: a route registered on
`/health` would be shadowed by the built-in endpoint.

## Next step

Add a database and the Entity → Repository pattern in
[02 · Database CRUD](../02-database-crud).
