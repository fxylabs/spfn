# Superfunction (SPFN)

> **Take your AI-built app from prototype to production**

📖 **[superfunction.xyz](https://superfunction.xyz)** — docs, package guides, and a full-stack tutorial.

`spfn create --mode full` wires the baseline into one application — **core** (server,
database, routes, codegen, typed client), **auth** (sessions, social login,
authorization), **i18n** (translation catalogs), and **mcp** (authenticated agent access
to your operations). Everything else is installed only when you reach for it.

## What is SPFN?

SPFN (Superfunction) is a TypeScript full-stack framework for products built with AI
coding agents. A Next.js app handles the frontend; an SPFN backend — built on Hono,
PostgreSQL and Drizzle ORM — handles the server side, either as its own long-lived
process or as serverless functions on the same origin. Requests are validated with
TypeBox and reach the browser through a typed client, so a route's input and output
types are the same object on both sides.

What makes it different from a stack you assemble yourself is that the shape is fixed.
Every feature is one vertical slice with the same four parts in the same four places:
an entity, a repository, a route, and a router registration. Nothing is left for a
human or an agent to invent per feature. On top of that, the parts every product needs
— authentication, storage, notifications, CMS, i18n, background jobs, and an MCP server
for operating the app — ship as `@spfn/*` packages rather than being rebuilt each time.

The point is that the first version and the production version are the same application.
You scaffold something deployable and authenticated on day one, then keep changing it —
rather than building a prototype and rebuilding it once it stops holding.

> **Status — Beta (`0.x`).** SPFN is in active development and runs in production for its
> authors. The public API is stabilizing, but **may still change between minor releases
> before `1.0`** — pin your versions and skim the [CHANGELOG](./CHANGELOG.md) before
> upgrading. Install from the `@beta` tag, e.g. `npm i @spfn/core@beta`.

---

## Why does my AI coding agent write the same feature differently every time?

Because nothing tells it where things go. Ask for "add orders" twice and you get two
different shapes: business logic in a route handler one time, in a service the next;
queries inline here, in a helper there. Each answer is reasonable on its own. Together
they become a codebase nobody — human or agent — can hold in their head.

The name for this is **architecture drift**: the gap that opens between the structure a
codebase was supposed to have and the structure it actually has. Agents accelerate it
for three ordinary reasons — they answer your prompt rather than reading your whole
codebase, they copy whatever shape they happen to read, and they produce faster than
anyone reviews. [The long version is here](https://superfunction.xyz/architecture-drift),
including the usual answers to it and why they are all detection after the fact.

This is the wall most AI-built apps hit. The prototype works. The tenth feature is
where it stops being changeable.

SPFN answers it by removing the choice. One feature is one vertical slice:

```
src/server/
  entities/order.ts        # the data shape
  repositories/order.ts    # persistence
  routes/orders.ts         # the validated API contract
  router.ts                # registration
```

The agent is not asked to design an architecture. It is asked to fill in a known one.
Type safety is one guardrail here, alongside runtime schemas, generated migrations,
explicit module boundaries, and a build that fails when the contract breaks.

---

## Do I need SPFN, or is Next.js enough?

**Next.js alone is enough** if nobody signs in and nobody has to operate it — a marketing
site, a public tool, a dashboard over data that is already public.

Everything else meets two gates, in this order.

**Gate 1 — accounts.** Nothing ships until people can sign in. Sessions and their expiry.
A callback flow per social provider, and the redirect URLs that break on deploy. Email or
phone verification. Roles and permissions on every route. Account deletion and recovery.
Device and key management.

**Gate 2 — operations.** The day after you deploy, someone has to refund an order, look up
a user, publish a change, retry a failed job. That is a second application: an admin
dashboard with its own auth, its own screens, and its own maintenance — and it keeps
growing for as long as the product does.

Neither gate is your product. Both have a known correct shape. Getting the first one
subtly wrong is a security incident rather than a bug.

**So the question is where your tokens go.** Building with an agent puts an explicit price
on both gates — every prompt, every regeneration, every fix that follows. SPFN's answer is
that they should cost you close to nothing:
[`@spfn/auth`](./packages/auth) clears the first, and [`@spfn/mcp`](./packages/mcp) clears
the second by exposing your operations as tools the agent you already use can run, instead
of a dashboard you have to build. What is left is the part only you can write.

---

## How is SPFN different from NestJS?

Both give you a structured TypeScript backend. They differ in how much they decide for
you and in what they assume about the frontend.

| | SPFN | NestJS |
|---|---|---|
| Frontend | Assumes Next.js; ships a typed client and RPC proxy | Frontend-agnostic |
| Structure | One fixed vertical slice per feature | Modules and providers you design |
| Validation | TypeBox, built in | Your choice, commonly class-validator |
| Database | Drizzle ORM, fixed | Your choice — TypeORM, Prisma, Drizzle |
| Client types | Route types flow to the browser directly | You define DTOs and keep them in sync |
| Auth, storage, CMS, MCP | Installable `@spfn/*` packages | Assembled from the ecosystem |
| Ecosystem size | Small and young | Large and mature |

NestJS is the better fit when you need freedom in how the backend is organized, or when
the frontend is not Next.js. SPFN is the better fit when you want one decided shape that
a coding agent can follow without being told again each time.

tRPC solves a narrower problem — typed calls between a client and server — and leaves
structure, persistence, and auth to you.

---

## How do I start a new SPFN project?

```bash
# Create a new project — full mode wires core, auth, i18n and MCP together
npx spfn@beta create my-app --mode full
cd my-app

# Start PostgreSQL and Redis
docker compose up -d

# Start both sides
npm run spfn:dev
```

Backend: http://localhost:8790 · Frontend: http://localhost:3790

Use `--mode bare` for the core architecture only. For an existing Next.js app, use
`npx spfn@beta init --mode full`.

---

## How do I define a type-safe API route?

```typescript
// src/server/routes/users.ts
import { route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';

export const listUsers = route.get('/users')
    .input({
        query: Type.Object({
            limit: Type.Optional(Type.Number()),
        }),
    })
    .handler(async (c) => {
        const { query } = await c.data();
        return { users: [], limit: query.limit ?? 10 };
    });

export const getUser = route.get('/users/:id')
    .input({
        params: Type.Object({
            id: Type.String(),
        }),
    })
    .handler(async (c) => {
        const { params } = await c.data();
        return { id: params.id, name: 'John' };
    });

export const createUser = route.post('/users')
    .input({
        body: Type.Object({
            name: Type.String(),
            email: Type.String(),
        }),
    })
    .handler(async (c) => {
        const { body } = await c.data();
        return { id: '1', ...body };
    });
```

Register them in the router — this is the API contract:

```typescript
// src/server/router.ts
import { defineRouter } from '@spfn/core/route';
import { listUsers, getUser, createUser } from './routes/users';

export const appRouter = defineRouter({
    listUsers,
    getUser,
    createUser,
});

export type AppRouter = typeof appRouter;
```

---

## How does the typed client know my route types?

Through the `AppRouter` type, not through generated client code. The client is created
once and infers everything from that type:

```typescript
// src/lib/api-client.ts
import { createApi } from '@spfn/core/nextjs';
import type { AppRouter } from '@/server/router';

export const api = createApi<AppRouter>();
```

Calls are fully typed, with no manual types anywhere:

```tsx
// app/page.tsx
import { api } from '@/lib/api-client';

export default async function Page() {
    const { users } = await api.listUsers.call({ query: { limit: 10 } });
    const user = await api.getUser.call({ params: { id: '123' } });

    return <div>{users.length} users</div>;
}
```

One piece does need codegen: the RPC proxy that forwards browser calls to the SPFN
server resolves routes from a generated map. Run `pnpm codegen` after changing routes
and commit the output.

```typescript
// src/app/api/rpc/[routeName]/route.ts
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { routeMap } from '@/generated/route-map';   // generated by `pnpm codegen`

export const { GET, POST } = createRpcProxy({ routeMap });
```

---

## Where does each file go?

```
src/
├── server/
│   ├── router.ts           # defineRouter — the API contract
│   ├── server.config.ts    # server configuration
│   ├── routes/             # route.get/post/... definitions
│   ├── entities/           # Drizzle database schemas
│   └── repositories/       # data access layer
├── generated/
│   └── route-map.ts        # produced by `pnpm codegen` — never hand-edit
├── lib/
│   └── api-client.ts       # createApi<AppRouter>() — typed client
└── app/
    ├── api/rpc/[routeName]/route.ts   # RPC proxy → SPFN server
    └── page.tsx            # Next.js pages
```

Generated files are output, not editing targets.

---

## How do I point Claude Code, Cursor, or Copilot at this project?

Point it at [CONTRIBUTING.md](./CONTRIBUTING.md). That file is the contract an AI coding
agent is expected to follow here: what the repo is, the commands, the vertical-slice
pattern, and the hard rules (never hand-edit generated files, migrations come from the
schema).

One file answers to people and agents alike, so there is no second copy of the rules to
drift out of sync. Each package's own `README.md` carries the authoritative detail for
that package — an agent changing `@spfn/auth` reads `packages/auth/README.md` as well.

Pointing an agent at a file like this is worth more than a long prompt describing a new
architecture for every feature.

---

## How do I add authentication?

```bash
npm i @spfn/auth@beta
```

```typescript
// src/server/router.ts
import { defineRouter } from '@spfn/core/route';
import { authRouter, authenticate } from '@spfn/auth/server';

export const appRouter = defineRouter({
    // your routes...
})
.packages([authRouter])
.use([authenticate]);
```

That brings sessions, social login, and RBAC. See
[`packages/auth/README.md`](./packages/auth/README.md) for the four wiring points and the
environment variables each provider needs.

---

## Can I operate the app without building an admin dashboard?

Yes — that is what [`@spfn/mcp`](./packages/mcp/README.md) is for. Instead of building
screens for every operational task, expose the operations an operator is allowed to
perform as MCP tools over authenticated HTTP, and drive them from an agent:

```
customers.list
orders.refund
content.publish
workflow.retry
```

Each tool uses the same repositories and services as the product, with its own input
schema and authorization rule. Do not expose tables as generic CRUD — expose operations.

---

## Which packages exist, and what does each do?

In the default setup:

| Package | Stage | Description |
|---------|-------|-------------|
| [@spfn/core](./packages/core) | Beta | Routing, database, transactions, typed client |
| [@spfn/auth](./packages/auth) | Beta | Sessions, social login, RBAC |
| [@spfn/i18n](./packages/i18n) | Beta | Server and React internationalization runtime |
| [@spfn/mcp](./packages/mcp) | Beta | MCP route adapter built on the official SDK |
| [spfn](./packages/cli) | Beta | CLI and dev tools |

Install when you need them:

| Package | Stage | Description |
|---------|-------|-------------|
| [@spfn/storage](./packages/storage) | Beta | Object storage (S3 / GCS / local) |
| [@spfn/notification](./packages/notification) | Beta | Email, SMS, Slack, push |
| [@spfn/cms](./packages/cms) | Beta | Content management |
| [@spfn/monitor](./packages/monitor) | Beta | Error tracking and monitoring dashboard |
| [@spfn/migrate](./packages/migrate) | Beta | Code-based data migrations with a run-once ledger |
| [@spfn/pages](./packages/pages) | Beta | Serve a markdown site from a GitHub repo |
| [@spfn/pages-next](./packages/pages-next) | Beta | Next.js integration for @spfn/pages |
| [@spfn/workflow](./packages/workflow) | Alpha | Pipeline orchestration |

Every package has a deep-dive README in [`packages/`](./packages). Exact versions live on
npm — install from the `@beta` tag.

---

## How do I deploy this?

Two targets. Both ship from the same repository, versioned together.

**Vercel — serverless, one origin, no container**

```bash
spfn add vercel
```

That scaffolds `src/app/api/backend/[[...route]]/route.ts` (a `hono/vercel` adapter) and
`vercel.json`. The SPFN app mounts under `/api/backend`, so the Next.js frontend and the
backend live on a single Vercel origin — point `SPFN_API_URL` at
`https://<deployment>/api/backend`. It runs on the Node runtime, not edge, because SPFN
needs `pg` and native `bcrypt`. If you use the Vercel Supabase integration, the adapter
maps the injected `POSTGRES_URL` onto `DATABASE_URL` for you.

One caveat: the in-process job worker does not run on serverless. Enqueuing still works,
but nothing drains the queue — schedule a route that processes a batch (Vercel Cron), or
run jobs on an always-on target. Seed and RBAC provisioning move to a deploy-time step
instead of running per cold start.

**Always-on — a long-lived process**

```bash
spfn build && spfn start          # or the generated Docker files
docker compose -f docker-compose.production.yml up --build -d
```

Background jobs, WebSocket events, and the periodic database health-check all need this
path. See [the deployment guide](./docs/guides/deployment.md).

---

## What do I need installed?

- Node.js >= 20.0.0 — `@spfn/core` runs on `@hono/node-server` 2, which requires it
- Next.js >= 16.2.11 — only if you use the Next.js integration
- PostgreSQL 14+
- Redis — only when the features you enable need it

Next.js 15 is not supported. Its fixes for [CVE-2025-66478](https://nextjs.org/blog/CVE-2025-66478)
and the Server Components denial of service landed separately on each minor line
(15.0.5, 15.1.9, 15.2.6, …), so no single range can express "patched" — the packages
require `^16.2.11` instead.

PostgreSQL 13 is the oldest release the code actually runs on: `gen_random_uuid()` is a
column default and moved into the server in 13. The floor is 14 because 13 stopped
receiving fixes in November 2025.

---

## FAQ

**I built a Next.js app with an AI agent. Can I add SPFN to it?**
Yes. Run `npx spfn@beta init --mode full` in the existing project. It adds the server
directory, the RPC proxy route, Docker files, and the codegen config, and updates your
`package.json`.

**My agent keeps inventing new folder structures. Does this actually fix that?**
It removes the decision. There is one place for entities, repositories, routes and the
router, and `CONTRIBUTING.md` states it. An agent that reads the file has nothing left to
invent. It does not stop an agent from writing bad logic inside a slice — that is the
line between the drift this removes and the drift it does not, set out in
[architecture drift](https://superfunction.xyz/architecture-drift).

**Can I use SPFN without Next.js?**
Yes. `next` is an optional peer dependency of `@spfn/core`, and the Next.js integration
is one module (`@spfn/core/nextjs`). The server runs on Hono on its own. You give up the
typed client and RPC proxy, which are the Next.js-side pieces.

**Can I use Prisma instead of Drizzle?**
No. `drizzle-orm` is a required peer dependency, and the repository layer is built on it.

**Can I deploy to Vercel?**
Yes — run `spfn add vercel`. See [How do I deploy this?](#how-do-i-deploy-this) for what
it scaffolds and the one caveat about background jobs.

**Do I have to use Docker?**
No. Vercel is a first-class target and needs no Docker. Docker is the always-on path, and
`docker compose up -d` is the convenient way to get PostgreSQL and Redis locally —
pointing at your own PostgreSQL works too. PostgreSQL itself is not optional.

**Do I need to run codegen after every change?**
Only after changing routes, and after schema changes run `pnpm db:generate`. The typed
client needs no codegen — it infers from `AppRouter`.

**I have never built a backend. Is SPFN too much?**
It is built for the opposite case. `spfn create --mode full` hands you a working,
authenticated, deployable app before you write a line — you are not assembling sessions,
OAuth, migrations and a data layer yourself, and you are not choosing an architecture.
The shape is fixed and written down in `CONTRIBUTING.md`, so your coding agent fills it
in instead of asking you to design it.

What SPFN removes is the architecture and the solved problems. What it does not remove is
the infrastructure: you still need a PostgreSQL database, and a setup step with real
environment variables in it. Knowing TypeScript helps, but the agent writes most of it.

**What database does SPFN require?**
PostgreSQL 14 or later. Redis is optional and only needed by some features.

---

## Documentation

- [superfunction.xyz](https://superfunction.xyz) — the documentation site
- [Architecture drift](https://superfunction.xyz/architecture-drift) — the problem this framework is shaped around, and where fixing the shape stops helping
- [Prototype to Production](https://superfunction.xyz/docs/prototype-to-production) — the whole loop, scaffold to MCP operations
- [Full-stack tutorial](https://superfunction.xyz/docs/tutorial) — from `spfn create` to auth-guarded pages
- [Examples](./examples/README.md) — a step-by-step ladder, start at `01-minimal-api`
- [CONTRIBUTING.md](./CONTRIBUTING.md) — setup, the SPFN pattern, the hard rules, and the contract for AI coding agents

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the
development workflow, the PR checklist, and the rules an AI coding agent is expected to
follow. By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

Found a security issue? Please report it privately — see [SECURITY.md](./SECURITY.md).

---

## License

MIT © FXY Inc.
