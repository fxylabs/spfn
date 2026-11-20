# {{projectName}}

A full-stack app built with [SPFN](https://github.com/spfn/spfn) — a consistent
architecture for taking an AI-built prototype to production. Scaffold mode: `{{mode}}`.

## Getting started

```bash
# 1. Start PostgreSQL + Redis
docker compose up -d

# 2. The env files are generated for you:
#    .env.local  — values loaded by Next.js, including auth session crypto (gitignored)
#    .env.server — server secrets: DB, cache (gitignored, never loaded by Next.js)
#    Review them and adjust as needed.

# 3. Start the dev server (Next.js :3790 + SPFN API :8790)
{{pmRun}} spfn:dev
```

Then open:

- Next.js — http://localhost:3790
- API health — http://localhost:8790/_core/health

## Project structure

```
src/
  app/                 Next.js App Router
  server/              SPFN backend (entities, repositories, routes, router)
  generated/           codegen output (route map) — do not edit by hand
.env.local             Next.js runtime env (gitignored)
.env.server            server secrets (gitignored)
.env.local.example     committed reference — the Next.js keys, placeholder values
.env.server.example    committed reference — the backend keys, placeholder values
.spfnrc.ts             codegen configuration
spfn.config.js         deployment config
```

A feature is a vertical slice: `Entity` (Drizzle table) → `Repository` →
`Route` (TypeBox validation) → `Router` → `{{pmRun}} codegen` → typed client.

## Common commands

```bash
{{pmRun}} spfn:dev          # dev: Next.js + SPFN API (add --watch to restart on changes)
{{pmRun}} spfn:build        # production build
{{pmRun}} spfn:start        # run the production build
{{pmExec}} spfn db generate     # create a migration from schema changes
{{pmExec}} spfn db migrate      # apply pending migrations
{{pmExec}} spfn env check       # check .env files against the schema
{{pmExec}} spfn secret set DB_URL   # store a secret (keychain locally, SOPS for deploys)
```

## Environment & secrets

The env reference is split by consumer: `.env.local.example` lists what the Next.js
process reads (`SPFN_API_URL`, `NEXT_PUBLIC_*`, the auth session secret), and
`.env.server.example` lists what only the backend reads (`DATABASE_URL`, `CACHE_URL`,
OAuth secrets). Which file a key belongs in follows who consumes it, not whether it
is secret.

`.env.server` holds backend-only secrets and is gitignored — Next.js never loads it.
For a managed workflow use `spfn secret`: local values go to the OS keychain (only a
`secret:keychain:` reference lands in `.env.server`), and deployed secrets are stored
in encrypted SOPS files. See the [SPFN CLI docs](https://github.com/spfn/spfn).

<!-- {{#auth}} -->
## Authentication

This project includes `@spfn/auth`. Configure providers and session settings in your
generated env files, then run `{{pmExec}} spfn db push`: it applies the auth migrations,
then creates the app's tables. The lifecycle, router, Next.js interceptor, `/login` starter
UI, OAuth callback, and route map are already wired.

## Internationalization

Edit `src/i18n/catalogs.ts` to add application-owned messages. Server components
and handlers can import `getT` or `getClientMessages` from `@/i18n/server`.

## Operations from the terminal

Operating this app needs no admin dashboard. Ops routes live in
`src/server/routes/ops.ts`, are written like any other route, and the `spfn ops`
CLI discovers them from the running server:

```bash
# 1. Seed an administrator: uncomment SPFN_AUTH_ADMIN_ACCOUNTS in .env.server,
#    then restart the server so the account is created.

# 2. Issue a token for this machine (stored in the OS keychain on macOS)
{{pmExec}} spfn ops token issue --name laptop --scopes 'example:read'

# 3. Run the app's own operations
{{pmExec}} spfn ops list --app http://localhost:8790
{{pmExec}} spfn ops call countExamples --app http://localhost:8790
{{pmExec}} spfn ops call listRecentExamples --describe   # usage from the route's schema
```

Tokens are scoped and revocable (`spfn ops token list` / `revoke`). Add your own
commands by exporting more `opsRoute` handlers and passing them to
`createOpsRouter` — no CLI change is needed, the manifest carries them.
<!-- {{/auth}} -->

## Deployment

```bash
# Build + run locally
{{pmRun}} spfn:build && {{pmRun}} spfn:start

# Or with Docker
docker compose -f docker-compose.production.yml up --build -d
```

Never commit real secrets. `.env.server` is gitignored; inject secrets in your
CI/CD pipeline or via `spfn secret` + your GitOps decryption step.
