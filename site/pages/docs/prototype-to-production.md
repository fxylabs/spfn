---
title: Prototype to Production
navTitle: Prototype to Production
order: 1
description: Scaffold the full SPFN foundation, build it with an AI coding agent, deploy it, and operate the product with spfn ops instead of an admin dashboard.
---

## The whole loop

Superfunction is designed for one continuous path:

```text
idea → full scaffold → vertical slices → production build → deploy → spfn ops
```

The point is that the first version and the production version are the same application.
You scaffold something deployable and authenticated on day one and keep changing it,
rather than building a prototype and rebuilding it once it stops holding.

The framework does not decide what your product is. It gives humans and agents a
consistent place to put each part, plus the infrastructure and guardrails needed to
keep going after the prototype works.

## What the loop is actually paying for

Two things stand between a working prototype and a product, and neither is your product.

**Gate 1 — accounts.** Sessions and their expiry, a callback flow per social provider,
verification, roles on every route, deletion and recovery. Getting it subtly wrong is a
security incident rather than a bug.

**Gate 2 — operations.** The day after you deploy, someone has to refund an order, look up
a user, publish a change, retry a failed job. Built the usual way that is a second
application, with its own auth and screens, growing for as long as the product does.

Building with an agent puts an explicit price on both — every prompt, every regeneration,
every fix that follows, measured in tokens. Steps 1 and 2 below clear the first gate;
steps 5 and 6 clear the second without a dashboard.

## 1. Scaffold the production foundation

Use full mode for a product you want to take beyond the first demo:

```bash
pnpm dlx spfn@beta create my-app --mode full
cd my-app
```

Full mode installs and wires the baseline as one application:

- `@spfn/core` for the server, database, routes, codegen, and typed client,
- `@spfn/auth` for sessions, social login, and authorization,
- `@spfn/i18n` for application-owned translation catalogs, and
- the ops surface — `src/server/routes/ops.ts`, served under `/_ops` and run with
  `spfn ops` from the terminal.

The ops surface adds no dependency: the router comes from `@spfn/core/ops` and the tokens
from `@spfn/auth`. `@spfn/mcp` is not part of full mode; step 6 shows when to add it.

Use `--mode bare` when you deliberately want only the core architecture. The
interactive prompt recommends full mode. Automated runs should pass the mode
explicitly; mode omission with `--yes` remains bare for backward compatibility.

For an existing Next.js app, use the corresponding init flow:

```bash
pnpm dlx spfn@beta init --mode full
```

## 2. Connect infrastructure and identity

Bring up the local services and start both sides of the app:

```bash
docker compose up -d
pnpm spfn:dev
```

The generated env examples separate browser-visible configuration from server-only
secrets. Add values only for the providers you use:

| Concern | What to connect |
| --- | --- |
| Data | PostgreSQL connection; Redis when the selected functions need it |
| Sessions | Auth session and token-encryption secrets |
| Social login | The client ID, client secret, and callback URL for each enabled provider |
| Storage and cloud | Credentials for the storage or infrastructure driver you select |
| Deployment | Public application and API origins used by redirects and server calls |

Keep real values out of source control. After deployment, update each OAuth provider's
allowed callback URL to the production application origin.

## 3. Give the agent a repeatable architecture

Ask the agent to build features as vertical slices and point it to
[The SPFN Pattern](./pattern.md):

```text
src/server/
  entities/order.ts
  repositories/order.ts
  routes/orders.ts
  router.ts
```

The entity owns the data shape, the repository owns persistence, the route owns the
validated API contract, and the router registers the slice. Generated files are output,
not editing targets. This is more valuable to an agent than a long prompt describing a
new architecture for every feature.

After changing routes or entities, close the loop with the project commands:

```bash
pnpm codegen                # spfn codegen run — regenerates the route map
pnpm spfn db generate       # when the schema changed
pnpm spfn build
pnpm test
```

Type safety is one guardrail in this loop, alongside runtime schemas, generated
migrations, explicit module boundaries, and repeatable verification.

## 4. Deploy one product, not a disconnected demo

Two targets. Both ship from the same repository and are versioned together — that is the
invariant, not the platform.

**Vercel — serverless, one origin, no container**

```bash
spfn add vercel
```

That scaffolds `src/app/api/backend/[[...route]]/route.ts` (a `hono/vercel` adapter) and
`vercel.json`. The SPFN app mounts under `/api/backend`, so the Next.js frontend and the
backend share a single Vercel origin — point `SPFN_API_URL` at
`https://<deployment>/api/backend`. It runs on the Node runtime, not edge, because SPFN
needs `pg` and native `bcrypt`. With the Vercel Supabase integration, the adapter maps the
injected `POSTGRES_URL` onto `DATABASE_URL` for you.

One caveat: the in-process job worker does not run on serverless. Enqueuing still works,
but nothing drains the queue — schedule a route that processes a batch (Vercel Cron), or
run jobs on an always-on target. Seed and RBAC provisioning move to a deploy-time step
instead of running per cold start.

**Always-on — a long-lived process**

A production SPFN app on this path has three durable dependencies:

1. the Next.js process,
2. the SPFN server process, and
3. PostgreSQL, plus Redis when your selected functions require it.

Run `pnpm spfn build` before deployment. Configure the platform to start the generated
production application with `pnpm spfn start`, provide the same validated env contract used
locally, and expose the application and API origins over HTTPS. Background jobs, WebSocket
events, and the periodic database health check all need this path.

Either way, apply generated database migrations as a deliberate release step rather than
writing production SQL by hand.

## 5. Turn domain operations into ops commands

Do not expose tables as generic CRUD. Expose the operations an operator is actually
allowed to perform, using the same repositories and services as the product:

```text
listCustomers
refundOrder
publishContent
retryWorkflow
```

An ops command is a route like any other, written with `opsRoute` so it lives under
`/_ops`. The full scaffold starts you with `src/server/routes/ops.ts`, which holds two
read commands and the router `src/server/router.ts` mounts:

```ts
import { createOpsRouter, opsRoute } from '@spfn/core/ops';
import { opsTokenAuth, requireOpsScope } from '@spfn/auth/server';

const countExamples = opsRoute.get('/examples/count')     // GET /_ops/examples/count
    .use([requireOpsScope('example:read')])
    .handler(async () => ({ count: await exampleRepo.countAll() }));

export const opsRouter = createOpsRouter({ countExamples }, { auth: opsTokenAuth });
```

`createOpsRouter` puts the auth middleware on every command, so there is no
unauthenticated variant, and serves `GET /_ops/_manifest`, the self-description the CLI
reads. Give each command a narrow input schema and its own scope. Declare what it does
with `.effect('read' | 'write' | 'destructive')` and `.summary('…')`: `spfn ops` shows
both, and refuses a destructive command unless the operator passes `--yes`. Read the
[`@spfn/core` ops section](./packages/core.md#how-do-i-operate-the-app-from-the-terminal) before adding commands.

## 6. Operate the deployed app

Issuing the first token signs in as an administrator, so seed one before you start:
set `SPFN_AUTH_ADMIN_ACCOUNTS` in `.env.server` locally, and in the deployment
platform's server-side secrets in production. Then, from the app's root directory:

```bash
export SPFN_OPS_APP=https://api.example.com                 # or pass --app to each command
spfn ops token issue --name laptop --scopes 'example:read' --to-keychain
spfn ops list                                               # what can this app do?
spfn ops call listRecentExamples --describe                 # what does it take?
spfn ops call listRecentExamples --query limit=20
```

The app URL must be HTTPS; plain HTTP is accepted only against a loopback host. Only the
token's SHA-256 hash is stored. `--to-keychain` (macOS only) delivers the secret without
printing it; elsewhere, leave it out, and the secret is printed once to set as
`SPFN_OPS_TOKEN`. Revoke a token with `spfn ops token revoke <id>` like any production credential.
Application users keep signing in through the separately configured OAuth providers.

`spfn ops` reads the commands from the running app, so nothing is generated or configured
on the operator's machine, and a coding agent in the same terminal can run the same
commands. When operators work outside a terminal, add [`@spfn/mcp`](./packages/mcp.md)
and write the same operations as MCP tools, calling the same repositories and services the
ops routes call. `@spfn/auth` can act as the OAuth 2.1
authorization server those clients expect, so Claude Code and Codex connect to `/mcp`
as the signed-in user; [Connecting MCP clients](../../../docs/guides/mcp-clients.md)
walks through it.

The result is an operating surface tailored to your product. An operator or an agent can
look up users, publish content, or retry a workflow without a separate administrator
dashboard. Build a dashboard later when a recurring human workflow benefits from one, not
as a prerequisite for operating the first production version.

## Production checklist

- The full scaffold runs locally with only the selected provider keys added.
- Every feature follows the entity → repository → route → router pattern.
- Codegen output and schema-generated migrations are current.
- Build, tests, and lint pass from a clean checkout.
- OAuth callbacks and public origins use production HTTPS URLs.
- Ops tokens carry only the scopes each operator needs, and have a revocation path.
- Ops commands are task-specific, scoped, and declare their effect.
- Destructive commands are declared `destructive`, so `spfn ops` asks for `--yes`.
- Logs and command results never expose secrets or sensitive internals.

Next, use the [full-stack auth tutorial](./tutorial.md) to understand the generated auth
boundary or browse [Packages](./packages.md) to add storage, notifications,
monitoring, CMS, and workflows without changing the architecture.
