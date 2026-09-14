---
title: Get Started
description: Take your AI-built Next.js app from prototype to production — scaffold a working, authenticated full stack in one command.
---

## Why this exists

Ask an AI coding agent for the same feature twice and you get two shapes. Business logic
in the route handler one time, in a service the next. Queries inline here, in a helper
there. Each answer is reasonable on its own. Together they become a codebase nobody —
human or agent — can hold in their head.

That is the wall most AI-built apps hit. The prototype works. The tenth feature is where
it stops being changeable.

SPFN answers it by removing the choice. One feature is one vertical slice, in four known
places, and `AGENTS.md` states where. The agent is not asked to design an architecture;
it is asked to fill in a known one.

## Do you need it yet?

Next.js alone is enough if nobody signs in and nobody has to operate the app. Everything
else crosses two gates, in this order.

**Gate 1 — accounts.** Nothing ships until people can sign in. Sessions and their expiry,
a callback flow per social provider, verification, roles on every route, deletion and
recovery. Getting this subtly wrong is a security incident rather than a bug.

**Gate 2 — operations.** The day after you deploy, someone has to refund an order, look
up a user, publish a change, retry a failed job. That is a second application with its
own auth, screens, and maintenance — and it grows for as long as the product does.

Neither gate is your product, and both have a known correct shape. Building with an agent
puts an explicit price on them, measured in tokens. `@spfn/auth` clears the first;
`@spfn/mcp` clears the second by exposing your operations as tools the agent already
uses, instead of a dashboard you have to build.

## Create a project

```bash
pnpm dlx spfn@beta create my-app --mode full
cd my-app
docker compose up -d            # PostgreSQL + Redis
pnpm spfn:dev                   # Next.js :3790 + SPFN API :8790
```

Full mode wires `@spfn/core`, `@spfn/auth`, `@spfn/i18n`, and `@spfn/mcp` into one
application. Connect the provider keys your product needs, then give your agent the
product brief. Env files are generated for you — server-only secrets go in `.env.server`.

Want only the framework kernel? Use `--mode bare`. The interactive prompt recommends full
mode; scripts and agents should always pass `--mode full` or `--mode bare` explicitly.
Already have a Next.js app? `pnpm dlx spfn@beta init --mode full` adds the same foundation
to it.

Requirements: Node.js 20+, PostgreSQL 14+, and — if you use the Next.js integration —
Next.js 16.3.3 or later. Redis only when the functions you enable need it.

Next.js 15 is not supported. Its fixes for the React Server Components vulnerability
(CVE-2025-66478) shipped separately on each minor line — 15.0.5, 15.1.9, 15.2.6 and so on
— so no single version range can say "patched", and 15.2.0 would satisfy "15.1.9 or
later" while still carrying the vulnerability.

## Never built a backend?

This is built for that case. `spfn create --mode full` hands you a working, authenticated,
deployable app before you write a line. You are not assembling sessions, OAuth, migrations
and a data layer, and you are not choosing an architecture.

What SPFN removes is the architecture and the solved problems. What it does not remove is
the infrastructure: you still need a PostgreSQL database and a setup step with real
environment variables in it.

## The pattern

A feature is one vertical slice, each layer in its own file:

```text
src/server/
  entities/order.ts        # the data shape — a Drizzle table
  repositories/order.ts    # persistence — extends BaseRepository
  routes/orders.ts         # the validated API contract — route.get/post/…
  router.ts                # registration — defineRouter
```

Change routes, run `pnpm codegen`, and the typed client sees the new shape. Runtime
validation, generated migrations, generated route maps, and end-to-end types then act as
production guardrails around fast iteration. Type safety is one of them, not the point.

## Deploy

Two targets, both shipping from the same repository, versioned together.

```bash
spfn add vercel          # serverless — Next.js and the backend on one origin
spfn build && spfn start # always-on — a long-lived process
```

Vercel is a first-class target and needs no Docker. Background jobs, WebSocket events, and
the periodic database health check need the always-on path.

## Go deeper

- [Prototype to Production](./docs/prototype-to-production.md) — the whole loop: scaffold
  the foundation, build in vertical slices, deploy, and operate through MCP
- [Tutorial: Full-Stack Auth](./docs/tutorial.md) — the auth wiring in depth: seeded
  admin, login form, social login, and layout guards, running locally
- [The SPFN pattern](./docs/pattern.md) — slice anatomy, codegen, the typed client loop
- [Packages](./docs/packages.md) — the `@spfn/*` family, documented on this site
- [Runnable examples](https://github.com/fxylabs/spfn/tree/main/examples) — from a
  minimal API to auth, end to end
