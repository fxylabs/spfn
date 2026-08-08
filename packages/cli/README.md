# spfn — the SPFN CLI (backend layer for Next.js)

`spfn` takes a Next.js idea from prototype to production with a consistent full-stack
architecture. It can scaffold either a core-only backend or a production baseline with
authentication, internationalization, and an agent-facing MCP endpoint, then runs the
dev/build/start lifecycle, database tooling, RPC codegen, and environment validation.

Consistent is the point rather than a nicety: what it scaffolds is one fixed shape per
feature, so a coding agent has no architecture left to invent and the codebase does not
acquire several. That problem has a name —
[architecture drift](https://superfunction.xyz/architecture-drift).

> Beta: install with the `@beta` tag (`spfn@beta`). The binary is `spfn`.

## Install

No global install needed — run through your package manager's dlx/npx:

```bash
npx spfn@beta <command>
pnpm dlx spfn@beta <command>
```

Or add it as a project dependency (`spfn init`/`spfn create` do this for you), then
call it via `pnpm spfn <command>` / `npm run spfn:<script>`.

Requirements: Node.js 20+ in both modes, Next.js 16.2.11+ (App Router, `src/` dir),
PostgreSQL 14+ (Redis optional). Next.js 15
is not supported — see [the root README](../../README.md#what-do-i-need-installed).

## Usage

```bash
# Prototype-to-Production baseline: core + auth + i18n + MCP
npx spfn@beta create my-app --mode full
cd my-app
docker compose up -d            # Postgres + Redis
# .env.local & .env.server are generated — keep both gitignored
pnpm spfn db migrate            # Apply auth migrations
pnpm spfn:dev                   # Next.js :3790 + SPFN API :8790

# Core-only full-stack skeleton
npx spfn@beta create my-api --mode bare

# Add SPFN to an existing Next.js project
npx spfn@beta init --mode full
```

The package manager is auto-detected (pnpm > yarn > bun > npm) from lockfiles; override
with `--pm`. In a pnpm workspace, `create` installs from the workspace root.

---

## Commands

Registered top-level commands: `create`, `init`, `add`, `dev`, `build`, `start`,
`provision`, `codegen`, `contract`, `key`, `setup`, `db`, `env`, `ops`, `secret`.

### `spfn create <name>`

Runs `create-next-app` with SPFN-recommended flags (TypeScript, App Router, `src/`,
Tailwind, import alias `@/*`, no ESLint), sets up SVGR icons, then runs `init`.

Choose `full` for the recommended Prototype-to-Production baseline or `bare` for the
historical core-only skeleton. Without `--mode`, interactive runs show a mode selector
with `full` recommended. For backward compatibility, non-interactive `--yes` runs without
an explicit mode continue to generate `bare`; automation that wants full should always
pass `--mode full`.

| Option | Description |
|--------|-------------|
| `--pm <manager>` | Force package manager: `npm` \| `pnpm` \| `yarn` \| `bun` |
| `--shadcn` | Also run `shadcn init` |
| `--mode <mode>` | `bare` (core only) \| `full` (core, auth, i18n, MCP) |
| `--skip-install` | Skip dependency install |
| `--skip-git` | Skip `git init` |
| `-y, --yes` | Skip prompts, use defaults |

### `spfn init`

Adds SPFN to an existing Next.js project: copies the selected server templates, wires the RPC
proxy route, Docker files, deploy + codegen config, updates `package.json` scripts/deps,
and installs. Full mode also adds the `/_auth/:path*` → SPFN API rewrite to
`next.config` (OAuth callbacks return to the app origin; merged manually if a `rewrites()`
already exists). See [Scaffold structure](#scaffold-structure) for what lands on disk.

| Option | Description |
|--------|-------------|
| `--mode <mode>` | `bare` (core only) \| `full` (core, auth, i18n, MCP) |
| `-y, --yes` | Skip prompts, use defaults |

Generated projects pin `drizzle-orm` and `drizzle-kit` to `1.0.0-rc.4`, matching
`@spfn/core` and the rest of the published SPFN database packages.

### `spfn add <package>`

Installs an SPFN ecosystem package and applies its pre-built migrations. The package
name must be scoped (contain `/`).

```bash
pnpm spfn add @spfn/cms
pnpm spfn add @mycompany/spfn-analytics
```

How it works: if not already present it installs the package, then reads the package's
`spfn` field in its `package.json` (`migrations`, `setupMessage`) and applies any
function migrations to `DATABASE_URL`. If `DATABASE_URL` is unset, migration is skipped
with a hint to run `spfn db push` later. Works with published and workspace packages.

### `spfn add vercel`

`vercel` is not a package — it is a built-in target, and the one argument to `add` that is
not a scoped package name. It scaffolds the three files a Next.js + SPFN app needs to run
its backend as Vercel Functions:

| File | What it is |
|------|------------|
| `src/app/api/backend/[[...route]]/route.ts` | `hono/vercel` adapter, mounts the SPFN app under `/api/backend` |
| `vercel.json` | build config (`pnpm spfn:build`) |
| `.npmrc` | `@spfn` registry auth, reading `GITEA_NPM_TOKEN` from the environment — never committed |

Existing files are never overwritten; they are reported and skipped. The runtime behind
the adapter is `createServerlessApp()` from `@spfn/core/server`. Afterwards, point
`SPFN_API_URL` at `https://<your-domain>/api/backend`, and make sure `hono` is a direct
dependency of the app so `hono/vercel` resolves.

### `spfn dev`

Starts the SPFN server + Next.js (and a codegen watcher). The server must report ready
(via a `.spfn/server-ready` signal file) before Next.js launches. Runs through `tsx`,
no pre-build needed.

| Option | Description | Default |
|--------|-------------|---------|
| `--server-only` | Run only the SPFN/Hono server (also auto-selected if Next.js isn't a dependency) | off |
| `--watch` | Restart the server on `src/server` changes (chokidar) | off |
| `-p, --port <port>` | Server port | from `server.config.ts` / env (`4000` in server-only fallback) |
| `-H, --host <host>` | Server host | `localhost` |
| `--routes <path>` | Routes directory path | server default |
| `--allow-pending-migrations` | Start even when migrations are pending (they are listed as a warning) | off |

Note: hot reload is **off by default** — pass `--watch` to restart on file changes.

Pending migrations stop the boot — see [Database](#spfn-db) for what the refusal looks
like and how to override it.

### `spfn build`

Runs codegen, builds Next.js (via the project's `build` script), and compiles
`src/server/**/*.ts` → `.spfn/server` with tsup. Also writes `.spfn/prod-server.mjs`
(the production entry consumed by `spfn start`).

| Option | Description |
|--------|-------------|
| `--server-only` | Build only the SPFN server (skip Next.js) |
| `--next-only` | Build only Next.js (skip the SPFN server) |
| `--turbo` | Use Turbopack for the Next.js build |

### `spfn start`

Starts the production servers from build output. Requires `spfn build` first — it errors
if `.spfn/server`, `.spfn/prod-server.mjs`, or `.next` are missing.

| Option | Description | Default |
|--------|-------------|---------|
| `--server-only` | Run only the SPFN server | off |
| `--next-only` | Run only Next.js | off |
| `-p, --port <port>` | SPFN server port (sets `SPFN_PORT`) | `8790` |
| `-h, --host <host>` | SPFN server host (sets `SPFN_HOST`) | `0.0.0.0` |
| `--allow-pending-migrations` | Start even when migrations are pending (they are listed as a warning) | off |

Next.js is started on `0.0.0.0:3790`. Both run together via `concurrently --kill-others`.

Pending migrations stop the boot unless `--allow-pending-migrations` or
`SPFN_ALLOW_PENDING_MIGRATIONS=true` is set — see [Database](#spfn-db). `--next-only`
skips the check: no SPFN server starts, so nothing can drift.

### `spfn codegen`

Manages code generators driven by `.spfnrc.ts`. The default generator is
`@spfn/core:route-map`, which emits `src/generated/route-map.ts` from `src/server/router.ts`
so the RPC proxy can resolve routes without importing server code. Generators also run
automatically during `spfn dev` and `spfn build`.

| Subcommand | Description |
|------------|-------------|
| `codegen init` | Create `.spfnrc.ts` (`--with-example` shows custom-generator usage) |
| `codegen list` (`ls`) | List configured generators and their watch patterns |
| `codegen run` | Run all generators once (no watch) |

`package.json` exposes this as the `codegen` script (`spfn codegen run`).

To add a custom generator, implement the `Generator` interface from `@spfn/core/codegen`
and reference it in `.spfnrc.ts`:

```ts
// .spfnrc.ts
import { defineConfig, defineGenerator } from '@spfn/core/codegen';

export default defineConfig({
    generators: [
        defineGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: './src/generated/route-map.ts',
        }),
    ],
});
```

### `spfn contract`

Manages the route contract — what a **separately deployed** client (a mobile app, an external
API consumer) is promised. A web client needs none of this: it derives its types from
`AppRouter` in the same build, so a broken response already fails the compile.

Requires the `@spfn/core:contract` generator in `.spfnrc.ts`. Every command regenerates the
contract from the router first, so a stale `contracts/current.json` is never what gets checked
or released.

```bash
# Regenerate and compare against the newest released snapshot
spfn contract check

# Cut a release — writes contracts/released/1.3.0.json. Commit it.
spfn contract release 1.3.0

# List released snapshots
spfn contract list
```

| Subcommand | Description | Exit code |
|------------|-------------|-----------|
| `contract check` | Compares the current contract against the newest released snapshot | 1 when a promise is broken |
| `contract release <version>` | Writes the snapshot every later build is compared against | 1 when the contract is broken, the version already exists, or it is not newer than the newest one |
| `contract list` (`ls`) | Lists released snapshots | 0 |

`--dir <path>` overrides the contracts directory; by default it comes from the generator's
`outputDir` in `.spfnrc.ts`.

**`spfn build` runs the same gate.** A broken contract fails the build with a non-zero exit
code — that is the point of hanging the check off codegen rather than leaving it to a
separate step.

See [`@spfn/core` contract docs](../core/src/contract/README.md) for the case table and the
removal rules.

### `spfn db`

Wraps Drizzle Kit with auto-generated config. Most commands read `DATABASE_URL` from the
loaded `.env` chain.

| Subcommand | Description |
|------------|-------------|
| `db generate` (`g`) | Generate migrations from schema changes (timestamp-prefixed) |
| `db push` | Diff with Drizzle Kit's current PostgreSQL engine and apply the selected DDL atomically. Destructive changes need confirmation; `--force` applies them, `--dry-run` previews |
| `db migrate` (`m`) | Run pending migrations. `--with-backup` snapshots first |
| `db status` | Show which migrations are applied and which are pending, for the project and for each installed function package |
| `db studio` | Open Drizzle Studio. `-p, --port` (auto-finds a free port) |
| `db check` | Verify the database connection |
| `db drop` | Drop all tables — **destructive**, double-prompts (see [Pitfalls](#pitfalls)) |
| `db backup` | Create a backup (`-f sql|custom`, `-o`, `-s`, `--data-only`, `--schema-only`, `--tag`, `--env`) |
| `db restore [file]` | Restore from a backup (`--drop`, `-s`, `--data-only`, `--schema-only`, `-v`) |
| `db backup:list` | List backups |
| `db backup:clean` | Prune backups (`-k, --keep <n>`, `-o, --older-than <days>`) |
| `db reindex` | Convert sequential migration prefixes to timestamps (`--dry-run`) |

> `db push` is for development. For production, use `db generate` + `db migrate` to keep
> migration history.

**A server refuses to start while migrations are pending.** Bumping `@spfn/auth` and
skipping `db migrate` used to boot fine, pass the health check, and then fail every
request that touched a new column as an opaque 500. `spfn dev` and `spfn start` now
compare the migrations each installed function package ships (and `src/server/drizzle`,
where present) against what the database records as applied, print the ones still
waiting, and stop:

```
❌ Refusing to start: 1 pending migration(s) in @spfn/auth
   @spfn/auth: 1 pending migration(s) (12/13 applied)
       - 20260805143152_client_identity

   Run: pnpm spfn db migrate
```

`--allow-pending-migrations` starts anyway and logs the same list as a warning.
`SPFN_ALLOW_PENDING_MIGRATIONS=true` does the same where no flag can be passed — a
container's env, a CI job. The check is skipped when the app initializes no database
or no package ships migrations, and a database it cannot reach is reported as
"could not verify", never as drift.

`db push` and `db migrate` also replay migrations shipped by installed SPFN function
packages (`@spfn/auth`, `@spfn/cms`, …) into per-package tracking tables
(`drizzle.__spfn_fn_<pkg>_migrations`). The CLI applies these with a built-in runner
that reads both migration layouts — drizzle-kit ≤0.31 (`NNNN_name.sql` +
`meta/_journal.json`) and drizzle-kit 1.0 (`<timestamp>_name/migration.sql`) — so a
package's layout never has to match the CLI's bundled drizzle version. `db push`
validates every package's migration folder before applying the project schema, and a
function-migration failure after a successful schema apply exits 1 with a message
making clear the project schema was already committed.

Database TLS is controlled by `DATABASE_URL`. Loopback URLs (`localhost`, `127.0.0.1`,
and `::1`) default to `ssl: false`; add an explicit `sslmode` when the local server uses
TLS. For a TLS connection with a self-signed certificate, set
`SPFN_DB_INSECURE_TLS=1` to disable certificate verification. This opt-in never enables
TLS by itself and `sslmode=disable` remains authoritative.

### `spfn env`

Schema-driven environment variable tooling (schema comes from a package's `envSchema`,
default `@spfn/core`). Routes vars to the right file: `NEXT_PUBLIC_*` → `.env`/`.env.local`,
server vars → `.env.server`.

| Subcommand | Description |
|------------|-------------|
| `env list` | List vars from the schema (`-g` groups by target file) |
| `env stats` | Show variable statistics |
| `env search <query>` | Search vars by key or description |
| `env init` | Generate `.env` template files (`-e <env>` for per-env, `-f` to overwrite) |
| `env check` | Check `.env` files against the schema (`-e <env>` for a full env chain) |
| `env validate` | Validate `process.env` against the schema — for CI/CD (`-e <env>`, `-s` strict) |

All accept `-p, --package <pkg>` (`env validate` uses `-p, --packages <pkgs...>`).

### `spfn key [preset]`

Generate cryptographically random secrets (base64url, 256-bit default).

```bash
spfn key                       # generic 256-bit secret
spfn key auth-encryption -c    # preset key, copy to clipboard
spfn key --list                # list presets
spfn key gen -b 64             # raw value only, no metadata (alias of `key generate`)
```

Presets: `auth-encryption`, `nextauth-secret`, `jwt-secret`, `session-secret`, `api-key`.
Options: `-l, --list`, `-b, --bytes <n>` (1–128), `-e, --env <name>`, `-c, --copy`.
The command prints the value to stdout for you to paste into an env file — it does **not**
write any file.

### `spfn secret`

Unified secret management: local secrets live in the OS keychain, deployed secrets in
encrypted SOPS files. The runtime never sees a reference — `spfn dev` injects local
values into the server process and GitOps injects them in production, so the app always
reads plain `process.env`.

| Subcommand | Description |
|------------|-------------|
| `secret set [key]` | Store a value (masked prompt). `--env local` → keychain; other envs → SOPS |
| `secret list` | List declared secrets and their status per env (never prints values) |
| `secret generate [key]` | Mint values for schema secrets with a `generate` strategy (`-a/--all`) |
| `secret rotate [key]` | Rotate values; external secrets are flagged for manual reissue (`-a/--all`) |
| `secret keygen` | Generate an age key pair for the SOPS no-cloud backend |
| `secret recipients <add\|remove\|list> [age1…]` | Manage `.sops.yaml` recipients + re-encrypt |
| `secret check` | Static lint — flag plaintext secret leaks |

Options: `-e, --env <env>` (`local` default; also `development`/`staging`/`production`),
`-p, --package <pkg>` (schema source, default `@spfn/core`).

**Local (keychain).** `spfn secret set DB_URL` stores the value in the OS keychain
(macOS `security`, Windows Credential Manager via optional `@napi-rs/keyring`, Linux
libsecret) and writes a `secret:keychain:spfn_DB_URL` reference into `.env.server`. The
reference is not sensitive; the real value never lands in the repo. `spfn dev` resolves
and injects it. Note: injection happens only when the server is started via `spfn dev` —
running the app another way (a bare `node`, tests) would see the raw reference, so use
`spfn dev` locally (a runtime resolver for other runners is planned).

**Deployed (SOPS).** `spfn secret set DB_URL --env production` writes the value into
`secrets/production.enc.json`, encrypted by SOPS. The backend (age / GCP KMS / AWS KMS)
is chosen by `.sops.yaml` creation rules — KMS needs no local key file (IAM + cloud
auth), age is the no-cloud fallback (`secret keygen` + `secret recipients add`). Commit
the encrypted file; your GitOps step decrypts it into env at deploy time. `sops`/`age`
are needed only for the deployed envs, never for local keychain use.

Schema-driven: a secret declared with `envSecret({ generate: 'base64url32' })` can be
minted/rotated automatically (`secret generate`/`rotate`); one without `generate` is an
external value you paste in (`secret set`).

### `spfn setup icons`

Install and configure SVGR for SVG-as-component imports (Next.js only).

### `spfn ops`

Invoke a running app's ops surface — the routes it exposes with
[`createOpsRouter`](../core/README.md#how-do-i-operate-the-app-from-the-terminal).
Commands are discovered from the app's `GET /_ops/_manifest`, so nothing is generated or
configured locally.

```bash
spfn ops list --app https://api.example.com           # what can this app do?
spfn ops call listSignups --query limit=50            # invoke a command
spfn ops call refundOrder --param id=42 --data '{"reason":"duplicate"}'
spfn ops call listSignups --describe                  # what does it take?
```

`--describe` answers from the manifest's schemas, so the usage is the running app's own,
not a local copy that can drift:

```
listSignups  GET /_ops/signups

  query parameters (--query)
    limit  number  optional  1–100, default 10
    state  string  required  one of: pending, approved

  Invoke: spfn ops call listSignups --query limit=<value>
```

Add `--json` for the raw JSON Schema. The server still validates every call — `--describe`
reports what it will accept, and the app's answer decides.

The app URL comes from `--app` or `SPFN_OPS_APP`. The ops token resolves `--token` →
`SPFN_OPS_TOKEN` → macOS keychain, and its lifecycle is managed with:

```bash
spfn ops token issue --name laptop --scopes 'waitlist:read' --app <url>
spfn ops token issue --name ci --scopes '*' --no-expiry --to-keychain --app <url>
spfn ops token list --app <url>
spfn ops token revoke <id> --app <url>
spfn ops token store --app <url>      # hidden prompt → keychain
spfn ops token forget --app <url>
```

`issue`, `list` and `revoke` call the app's own admin-only routes, so the CLI prompts for
an administrator's email and password first — no database access. Only the token's SHA-256
hash is ever stored, so the secret exists in the clear once, in the issuance answer;
`--to-keychain` delivers it without printing it.

`--expires-days` takes 1 to 36500 days (about a century), or `--no-expiry` for a token that
never expires. The upper bound is there because a day count becomes a date by arithmetic,
and a big enough count produces an invalid date rather than a distant one.

SPFN authenticates a request with a JWT the client signs itself, so the CLI generates a key
pair for the command, signs the one call it needs, and revokes the key before the command
ends — on the failing path as much as the succeeding one. Nothing is written to disk.

These three commands need `@spfn/auth` **0.3.0-beta.2 or later** installed in the app: the
ops token lives in its schema, and the signing comes from its `@spfn/auth/crypto` entry
point, which that release added. The CLI does not depend on the package in any form — it
loads it from the app at run time, and tells a missing package apart from one too old to
carry the entry point, so the message names the thing to do.

---

## Scaffold structure

Both modes produce the core full-stack skeleton:

```
src/
  app/api/rpc/[routeName]/route.ts   # RPC proxy — re-exports { GET, POST } from @spfn/core/nextjs/server
  generated/route-map.ts             # generated by codegen (run `spfn codegen run` if missing)
  lib/
    api-client.ts                    # createApi<AppRouter>() — the type-safe client
  server/
    router.ts                        # defineRouter({ ...routes }) → export type AppRouter
    server.config.ts                 # defineServerConfig().port(8790).host('0.0.0.0').routes(appRouter)
    config/env.config.ts             # environment schema
    entities/                        # Drizzle tables (example.entity.ts, config.ts)
    repositories/                    # BaseRepository subclasses (example.repository.ts)
    routes/                          # route DSL handlers: root.ts, health.ts, examples.ts
    tsconfig.json, tsup.config.ts
.spfnrc.ts                           # codegen config (route-map generator)
spfn.config.js                       # deployment config (subdomain/region/domains) — committed
docker-compose.yml                   # Postgres + Redis (dev)
docker-compose.production.yml
Dockerfile, .dockerignore
next.config.ts                       # patched when auth is enabled: /_auth/:path* rewrite → SPFN API
.env.example                         # committed reference — every key, placeholder values
.env.local                           # generated, gitignored (values loaded by Next.js)
.env.server                          # generated, gitignored (server secrets: DB, cache)
```

Full mode overlays the Prototype-to-Production baseline:

```
src/
  app/login/page.tsx                 # provider login starter UI
  app/auth/callback/page.tsx         # OAuth session handoff
  i18n/catalogs.ts                   # application-owned en/ko starter messages
  i18n/server.ts                     # configured server-side i18n registry
  server/mcp.ts                      # authenticated /mcp endpoint + starter app_status tool
  server/router.ts                   # authRouter + mcpRouter + global authenticate
  server/server.config.ts            # createAuthLifecycle + i18n startup
next.config.ts                       # /_auth/* callback rewrite
.env.local                           # generated auth session secret (gitignored)
.env.server                          # auth keyring + MCP operator key (gitignored)
```

The full RPC proxy imports the auth interceptor and merges `authRouteMap`. Internal auth
and MCP keys are generated with cryptographic randomness in ignored local env files;
`.env.example` contains placeholders only. Add only the provider keys you use, then run
`pnpm spfn db migrate`. The starter MCP endpoint accepts `SPFN_MCP_API_KEY` as a Bearer
token for first-party operation; replace that validator with OAuth before third-party access.

`init` also patches `package.json` (scripts: `spfn:dev`, `spfn:server`, `spfn:next`,
`spfn:build`, `spfn:start`, `codegen`; deps: `@spfn/core`, `spfn`, `drizzle-orm`,
`@sinclair/typebox`, `concurrently`, etc.; full also adds `@spfn/auth`, `@spfn/i18n`,
`@spfn/mcp`, auth's `@spfn/notification` peer, and a Node `>=20.0.0` engine when the
existing range still permits older Node versions), excludes `src/server` from the root
`tsconfig.json` (Vercel compat), and adds `.spfn/`, `.env.local`, `.env.server` to
`.gitignore`.

### Route DSL (the current architecture)

Routes are defined with the `route` builder and collected by `defineRouter`. There is no
separate "contract" layer — the router's type *is* the contract; the client infers from it.

```ts
// src/server/routes/examples.ts
import { route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';

export const getExample = route.get('/examples/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .handler(async (c) =>
    {
        const { params } = await c.data();
        return { id: params.id };
    });
```

```ts
// src/server/router.ts
import { defineRouter } from '@spfn/core/route';
import { getExample } from './routes/examples';

export const appRouter = defineRouter({ getExample });
export type AppRouter = typeof appRouter;
```

```ts
// src/lib/api-client.ts
import { createApi } from '@spfn/core/nextjs';
import type { AppRouter } from '@/server/router';

export const api = createApi<AppRouter>();
const example = await api.getExample.call({ params: { id: '123' } });
```

Client calls go through the Next.js RPC proxy (`/api/rpc/[routeName]`), which forwards to
the SPFN API with cookie forwarding and interceptors, resolving routes via the generated
`route-map.ts`.

---

## Deployment

Two targets, both shipping from the same repository.

**Vercel — serverless, one origin, no container.** Run `spfn add vercel` (above) and
deploy. Frontend and backend share a single Vercel origin. One caveat: the in-process job
worker does not run there, so enqueuing works but nothing drains the queue — schedule a
route that processes a batch (Vercel Cron), or run jobs on an always-on target.

**Always-on — a long-lived process.** `spfn build` then `spfn start`, or the generated
Docker files. Background jobs, WebSocket events and the periodic database health check all
need this path.

```bash
# Build + run locally
pnpm spfn:build
pnpm spfn:start                 # Next.js :3790 + SPFN API :8790

# Docker (single image runs both)
docker compose -f docker-compose.production.yml up --build -d
```

The Dockerfile (`node:22-alpine`) installs with `pnpm --frozen-lockfile`, runs
`pnpm run spfn:build`, prunes dev deps, exposes `3790`/`8790`, health-checks
`http://localhost:8790/health`, and starts via `pnpm run spfn:start`.

Run migrations against the target DB before/with deploy:

```bash
docker exec <container> npx spfn db migrate
```

Forget, and the container will not come up: the server refuses to serve while migrations
are pending and prints which ones. That is the intended failure — a deploy that stops at
the gate is one that never served the 500s. If a rollout has to proceed anyway, set
`SPFN_ALLOW_PENDING_MIGRATIONS=true` in the container's environment; the pending list is
logged as a warning instead.

A readiness probe can catch the same drift on a cluster the local gate never sees. When
detailed health is on, `GET /health` carries a `migrations` object with per-package
applied/pending counts — assert `migrations.pending === 0` in the probe to hold a
drifted pod out of rotation. Reporting drift does not, by itself, change the overall
health `status`.

`spfn.config.js` (committed) configures the managed `*.spfn.app` deployment: `subdomain`,
`region` (`us` default, `kr`, …), `customDomains`, and non-secret `env`. Its `SpfnConfig`
type ships from `spfn` (`@type {import('spfn').SpfnConfig}`).

---

## FAQ

**`create` or `init` — which one?**
`create` starts a new project: it runs `create-next-app` with SPFN's flags and then runs
`init` inside it. `init` adds SPFN to a Next.js app that already exists. If you built
something with an AI coding agent and now want a real backend under it, `init` is the one.

**`bare` or `full`?**
`full` is the recommended baseline: core, auth, i18n and MCP wired together, so you get a
working authenticated app on day one. `bare` is core only — the architecture with nothing
else decided. Automation should always pass `--mode` explicitly, because a `--yes` run
without one still produces `bare` for backward compatibility.

**Why doesn't my server restart when I edit a file?**
Because hot reload is off by default. `spfn dev --watch` restarts the server on `src/server`
changes. Next.js reloads on its own either way.

**Do I have to use Docker?**
No. Vercel is a first-class target and needs no container. Docker is the always-on path,
and `docker compose up -d` is also the convenient way to get PostgreSQL and Redis locally —
pointing at your own PostgreSQL works too. PostgreSQL itself is not optional.

**Which Node version do I need?**
20 or later, in both modes. `@spfn/core` runs on `@hono/node-server` 2, which declares
that floor, and full mode's MCP server needs the same.

**When do I have to run codegen by hand?**
Whenever routes change outside `spfn dev`, which runs a codegen watcher for you. A stale or
missing `src/generated/route-map.ts` makes the RPC proxy answer 404 — run `spfn codegen run`
and commit the result.

**Where do secrets go?**
`.env.server` (gitignored, server-only) for backend values, `.env.local` for the session
cookie secret that the Next.js runtime itself needs. Never `spfn.config.js` — that file is
committed.

## Pitfalls

- **`.env.server` is gitignored and server-only.** Put backend-only DB/secret values there,
  not in `.env` (committed). Full mode's session-cookie secret is the intentional exception:
  it lives in gitignored `.env.local` because Next.js must encrypt the cookie. There is no
  `.env.server.local`. `spfn init` generates `.env.server`; put DB/secret values there.
  Load order is the standard dotenv chain ending with `.env.server`.
- **Never commit secrets in `spfn.config.js`.** It's checked into Git; its `env` block is
  for non-sensitive values only. Use CI/CD secret management for credentials.
- **`spfn dev` does not hot-reload by default.** Add `--watch` to restart on `src/server`
  changes.
- **`spfn start` needs a prior `spfn build`.** It hard-fails without `.spfn/server`,
  `.spfn/prod-server.mjs`, and `.next`.
- **Destructive DB commands are guarded.** `db drop` double-confirms (and verifies the
  target); `db push` applies the selected statements in one transaction and withholds
  destructive ones unless `--force`/confirmed. Prefer `db generate` + `db migrate` for
  production; `db push` is dev-only.
- **`spfn add` requires a scoped package name** (must contain `/`) and only applies
  migrations when `DATABASE_URL` is set — otherwise it skips with a hint. The single
  exception is `spfn add vercel`, a built-in target rather than a package.
- **Package manager is auto-detected from lockfiles.** If detection is wrong (e.g. mixed
  lockfiles), pass `--pm` to `create`. In a pnpm workspace, `create` installs from the
  workspace root, not the new project dir.
- **Make scaffold mode explicit in automation.** Interactive runs recommend `full`, while
  historical `--yes` calls without `--mode` remain `bare`. Pass `--mode full` or
  `--mode bare` so scripts state their intended architecture.
- **Regenerate the route map after route changes outside dev.** If
  `src/generated/route-map.ts` is missing or stale, run `spfn codegen run` — the RPC proxy
  depends on it.

---

## Related

- [`@spfn/core`](../core/README.md) — server, route DSL, codegen, db, client runtime.
- [`@spfn/auth`](../auth/README.md) — what `--mode full` wires in for accounts and roles.
- [`@spfn/mcp`](../mcp/README.md) — what `--mode full` wires in for operating the app.
- Project root README — framework overview and getting started.
