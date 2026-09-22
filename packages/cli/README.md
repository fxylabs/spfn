# spfn — the SPFN CLI (backend layer for Next.js)

`spfn` takes a Next.js idea from prototype to production with a consistent full-stack
architecture. It can scaffold either a core-only backend or a production baseline with
authentication, internationalization, and a terminal operations surface, then runs the
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

Requirements: Node.js 20+ in both modes, Next.js 16.3.3+ (App Router, `src/` dir),
PostgreSQL 14+ (Redis optional). Next.js 15
is not supported — see [the root README](../../README.md#what-do-i-need-installed).

## Usage

```bash
# Prototype-to-Production baseline: core + auth + i18n + ops
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
`provision`, `codegen`, `contract`, `key`, `setup`, `db`, `env`, `ops`, `secret`,
`cloud`, `kit`.

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
| `--mode <mode>` | `bare` (core only) \| `full` (core, auth, i18n, ops) |
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
| `--mode <mode>` | `bare` (core only) \| `full` (core, auth, i18n, ops) |
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
| `.npmrc` | which registry the `@spfn` scope resolves to — a mapping, not a credential |

The registry token does **not** go in that `.npmrc`. pnpm 10 and later refuse to expand an
environment variable in a registry credential that came from a project `.npmrc` — the file is
committed, and a hostile edit could redirect the secret to a registry nobody chose. pnpm drops
the line with a warning and the install fails as unauthorized. So the credential goes in Vercel's
`NPM_RC` environment variable, which Vercel writes to the build container's user-level `~/.npmrc`,
where pnpm still expands it. `spfn add vercel` prints the exact block to paste.

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
| `-p, --port <port>` | SPFN server port (sets `SPFN_PORT`) | `spfn.config.js` `ports.server`, then `8790` |
| `-H, --host <host>` | SPFN server host (sets `SPFN_HOST`) | `spfn.config.js` `host`, then `localhost` |
| `--allow-pending-migrations` | Start even when migrations are pending (they are listed as a warning) | off |
| `--no-agent-files` | Do not write the SPFN instruction block into `AGENTS.md` (same as `SPFN_AGENT_FILES=0`) | writes on |

Note: hot reload is **off by default** — pass `--watch` to restart on file changes.

On startup `spfn dev` refreshes a marked block of SPFN conventions in the project's
`AGENTS.md` (creating the file, and a `CLAUDE.md` that references it, when absent) so
coding agents read the right idioms. Only the marked region is rewritten, and only when
its content actually changed.

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
| `-p, --port <port>` | SPFN server port (sets `SPFN_PORT`) | `spfn.config.js` `ports.server`, then `8790` |
| `-h, --host <host>` | SPFN server host (sets `SPFN_HOST`) | `spfn.config.js` `host`, then `localhost` |
| `--allow-pending-migrations` | Start even when migrations are pending (they are listed as a warning) | off |

Both run together via `concurrently --kill-others`.

Neither flag has a default value, deliberately. A default is indistinguishable
from a value the operator typed, and it was forwarded as `SPFN_PORT` either way —
which overrode the app's own configuration. Pass nothing and `spfn.config.js`
decides; pass a flag and it wins.

Next.js is started on the port `spfn.config.js` gives as `ports.next` (`3790` by
default), overridable with `NEXT_PORT`.

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
| `db status` | Show which migrations are applied and which are pending, for the project and for each installed function package. `--json` prints one machine-readable report instead |
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

**Which files are the schema.** `db push`, `db generate` and `db studio` resolve the
project schema in the same order:

1. `db push --schema <path>`: a file, a directory or a glob.
2. `./drizzle.config.ts`, when the project has one: its `schema` entry, and for `db push`
   a non-empty `schemaFilter`.
3. Every entity file under `src/server/entities/`, barrel files (`index.*`, `config.*`)
   excluded.
4. The registry — `src/server/entities/config.ts`, or the file `DRIZZLE_SCHEMA_PATH`
   names — loaded alone, in two cases: the scan finds no entity file (the folder holds
   only the registry and the tables live elsewhere), or the registry exports a table,
   enum, view or sequence none of the scanned files define while the folder defines
   nothing the registry lacks (the tables moved out and a re-exported file was left
   behind). The command says which and names the objects. A registry whose objects
   are all among the scanned files (the scaffold) changes nothing. When each side
   defines objects the other lacks, no choice keeps every table, so the command stops
   and names both sets: re-export the folder's entities from the registry, move the
   leftover files out, or name the schema in `drizzle.config.ts`.

An entry named through 1–2 is expanded the way drizzle-kit expands it and nothing is
filtered: a file is loaded as-is, a directory is read one level deep, a glob uses glob
syntax (`**`, `*`, `?`, `{a,b}`, `[…]`) with parentheses taken literally, so
`src/server/(workspace)/entities/*.ts` works, and a directory the glob matches is read
one level deep. Symlinks are followed (a link cycle ends where a directory was already
visited); a walk skips dot-directories like drizzle-kit's glob does. The accepted
extensions are drizzle-kit's (`.ts .mts .cts .tsx .js .mjs .cjs .jsx`). Two deliberate
differences: declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are skipped, and a walk
never enters `node_modules`, so a `**` pattern cannot pull a dependency's file into
the schema. A registry loaded as-is (2 or 4) contributes only what it exports:
re-export with `export *` so a `pgEnum` or `pgSchema` defined next to a table comes
along. `db push` diffs the PostgreSQL schemas the declared `schemaFilter` names (else
`public`) plus every schema the loaded modules name — tables, `pgSchema()` objects,
enums, views, sequences; `--schema` replaces the files but keeps that declared filter.

**A function package's own schema is never the project's.** An installed package that
ships migrations (`@spfn/auth` → `spfn_auth`) creates and alters its own tables when
`db push` or `db migrate` runs its migrations, so the project never diffs or generates
them. Whichever files are loaded, `db push` drops the objects living in such a schema
from the diff and leaves that schema out of the filter it derives — a registry that
re-exports one package table for a relation no longer proposes `DROP TABLE` for the
package tables it does not re-export. A `schemaFilter` declared in `drizzle.config.ts`
still stands verbatim; naming a package schema there is the user's own choice. Schemas
the project itself owns (`pgSchema('billing')`) are unaffected: they are created and
diffed as before.

`db generate` cannot be filtered the same way — drizzle-kit loads the schema files
itself and its `generate` reads no `schemaFilter` — so it stops instead when the files
it would read reach a package's objects:

```
❌ The schema read from entity registry ./src/server/entities/config.ts reaches
   users (@spfn/mockfn), which the package migrates itself. …
```

Keep package re-exports out of the registry: a relation can `import` the package's
table and reference it without re-exporting it.

Earlier releases gave `db push` the folder scan alone, so a project whose tables lived
outside `src/server/entities/` and were re-exported from the registry pushed nothing
(`No schema files found`), and a project with a `drizzle.config.ts` had `db push` and
`db generate` reading different files. `db push` prints which source it used, exits 1
when a path named through 1–2 has no schema files, and exits 1 when `drizzle.config.ts`
cannot be loaded rather than pushing something `db generate` would not read. One
consequence for code calling `getDrizzleConfig({ schema, expandGlobs: true })`
directly: an explicit glob is no longer barrel-filtered, so a glob that matches both a
barrel and the files it re-exports now makes drizzle-kit report a duplicate table, as
it would for the same glob in a hand-written `drizzle.config.ts`.

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

### `spfn cloud`

Free-tier management for apps deployed to your own **Vercel Hobby + Supabase Free**
accounts: see the plan limits, watch live usage against them, keep the Supabase
project from pausing, and sync env vars/API keys. Account tokens and key values live
in the OS keychain and never appear in command output.

| Subcommand | Description |
|------------|-------------|
| `cloud link` | Connect accounts: Vercel access token + Supabase personal access token (masked prompt or `VERCEL_TOKEN`/`SUPABASE_ACCESS_TOKEN` env), pick the project on each side. Identifiers land in gitignored `.spfn/cloud.json`; tokens go to the keychain |
| `cloud limits` | The free-plan limits (constants verified against the official docs, date shown) — works before `link` |
| `cloud usage` | Current usage: Vercel billing feed (rolling 30 days), Supabase DB size + last-24h API requests |
| `cloud status` | Usage measured against the limits on one screen; items at ≥80% get a migration warning |
| `cloud keepalive` | Daily cron hitting `/api/backend/_core/health?detailed=true` (the detailed check runs a DB query, which is what prevents the ~7-idle-day pause). Vercel cron by default; `--github-actions --url <deployed-url>` for a workflow instead |
| `cloud env pull` | Supabase keys → local: project URL + anon key into `.env.local`, service-role key into the keychain (`.env.server` gets a reference). `--db-url` also composes `DATABASE_URL` (prompts for the DB password) |
| `cloud env push KEY…` | Push local env values to the Vercel project env by name. Values resolve from `.env`/`.env.local`/`.env.server`+keychain; everything is sent encrypted except `NEXT_PUBLIC_*` |

Free-tier behavior worth knowing (also printed by `cloud limits`): Vercel Hobby
allows one cron at most once per day and pauses a capability when its rolling
30-day limit is hit (it never bills); Supabase Free quota is summed per
organization (except DB size), and org totals like egress/MAU have no public API —
`cloud status` shows per-item numbers and points at the dashboard for the rest.
Hobby is limited to personal, non-commercial use — a monetized app needs Vercel Pro
or a migration off the free tier.

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

#### Capability modules

An app can also mount ops commands a package described, with
[`defineOpsModule`](../core/README.md#can-a-package-ship-ops-commands). Those commands are
named `<module>.<command>` and carry a summary, an effect and their scopes, so the CLI can
group them and say what each one does. From **0.3.0-beta.5**:

```bash
spfn ops modules                                      # what is mounted, and from where
spfn ops modules --json                               # same, machine-readable
spfn ops list --module ledger                         # just that module's commands
spfn ops call ledger.compact --yes                    # effect=destructive needs this
```

`spfn ops call` refuses a command the app declared `effect: destructive` unless `--yes` is
given. It refuses the same way when the app announced module metadata this CLI could not
validate: the effect is then unknown rather than absent, and an unknown effect is not
treated as a safe one. The command still lists — an operator reading a short list would
otherwise take it for the app's whole surface — and the warning names what was dropped.

Everything in the manifest is the app's own text written to your terminal, so control
characters in it are replaced before anything is printed.

The app URL comes from `--app` or `SPFN_OPS_APP`, and it must be **https** — every one of
these commands carries a secret, and `token issue` carries an administrator's password.
`http` is accepted only against `localhost`, `127.0.0.1` and `::1`, where there is no
network to listen on. A URL with a base path (`https://example.com/api`) is kept whole:
both the ops calls and the administrator sign-in go through it.

The ops token resolves `--token` → `SPFN_OPS_TOKEN` → macOS keychain, and its lifecycle is
managed with:

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

Because the package is the app's, it is resolved **from the directory the command runs in**.
Run `spfn ops token` from the app's root; running it elsewhere reports the package as
missing, and the message names the directory it looked in.

### `spfn kit`

Install, verify and update a **Superfunction Kit** — a licensed product that ships as a
signed release: an SPFN scaffold, an exact dependency graph, files the Kit manages on the
customer's behalf, and its own tooling. `spfn kit` is the generic installer for all of
them. It hard-codes no product: which Kit, which packages and which files are managed all
come from the signed setup descriptor and release manifest, and every judgement specific to
a product comes from that product's own `/tooling` entry, which the CLI *discovers* among
the packages the manifest installs.

There is one binary and one command group. No Kit gets its own CLI.

| Subcommand | Description |
|------------|-------------|
| `kit install <setup-url> <dir>` | Install the newest entitled stable release into a new or empty directory: verify the setup link, activate the license, create the SPFN base, materialize the managed files, install the exact graph, run migrations, run the gates, write the lock and make the first commit |
| `kit restore` | Reinstall the exact release a clean clone records, using the committed lock and this machine's credential. Rewrites no source file |
| `kit status` | Read-only report: installed release, activation, credential, managed drift, migrations, open operation. Anything the CLI could not determine is reported as `unknown` |
| `kit check` | Read-only contract check with stable diagnostic codes, the path each is about, and the command that would fix it |
| `kit plan [--to <release>]` | What an update would change, with the approval digest. Writes nothing |
| `kit update [--to <release>] [--approve-plan <digest>]` | Update through the signed update edges, then gates, lock and commit |
| `kit resume [operation-id]` | Continue an operation that stopped — after re-reading the project and confirming the recorded checkpoints still hold |
| `kit abandon [operation-id]` | Record that an operation will not be finished, and report what it left behind. Deletes and rolls back nothing |

**Secrets never travel as arguments.** There is no `--license-key <value>` option, by
design: a secret on a command line is in the process table, the shell history and every log
that records an argv. A key arrives either through a masked prompt or through
`--license-key-stdin`. Once activation succeeds the key is discarded and only the local
credential the server issued remains, in the OS keychain under its own service
(`superfunction.spfn.kit`), separate from the env secrets `spfn secret` manages. The
short-lived registry session is handed to the package-manager child process in its
environment and nowhere else, as npm configuration addressed to the registry it opens
(`npm_config_//host/npm/:_authToken`). The committed `.npmrc` maps the release's scopes to
that registry and carries no credential at all — not a value, and not a variable naming
one: pnpm 10 and later ignore a credential that reaches them from a project `.npmrc`, because that
file is committed and a hostile edit could send the secret to another registry.

**`--json` is the agent surface.** Every subcommand takes it, prints newline-delimited
events with a stable `code`, `phase` and safe next command, and never opens a prompt. A
JSON-mode command that needs a secret exits `2` and reports `input: masked-stdin`.

| Exit | Meaning |
|-----:|---------|
| `0` | Completed, or an idempotent no-op |
| `2` | Waiting for a person: a secret on stdin, or an exact plan approval |
| `3` | Recoverable failure — `spfn kit resume` can continue it |
| `4` | Refused before any write: drift, compatibility, entitlement or a busy project |
| `5` | An external service could not be reached |
| `10` | This CLI and the release speak different protocol versions |

**What an install does not do.** It stops at a verified local repository: no cloud account
is linked, nothing is pushed, nothing is deployed. That is a checkpoint for the agent to
continue from, not a finished product install.

**Approval is exact.** A breaking release or an external effect requires the digest of the
very plan being run (`--approve-plan`), which can only be obtained by reading the plan.
There is no blanket `--yes`.

**One operation at a time.** A project holds a filesystem lock while a write operation
runs. A lock left behind by a dead process is not simply deleted — it is reconciled against
the operation journal, and reclaimed only when that journal agrees the work is over or the
caller is resuming exactly the operation it belongs to.

Generated state lives under `.spfn/`: `license.json` and `kit-lock.json` are committed and
hold public identifiers only; `operations/` is per-machine and gitignored.

**Exactness is proved, not assumed.** Before the package manager runs, every package the
signed manifest names is fetched through the licensed registry proxy and checked twice: the
version's integrity against the digest the manifest pinned, then the bytes that actually
arrived against that same digest. The first says the registry agrees with the release; only
the second says the file on this disk is the file the release described. The project's base
arrives the same way — one scaffold archive, verified against the manifest's integrity
before a single file is expanded, and refused outright if it names a path that would leave
the project directory or overwrite a file that is already there.

**An artifact is written as what it is.** A managed bridge is a file, and its
bytes are the file. The scaffold and the Agent Pack are archives, and the CLI expands them —
the pack into `.spfn/agent-pack/`, because a release's guides, schemas and checklists are a
directory and belong to the release rather than among customer source. Both are proven
against the manifest's digest before they are opened, and both refuse an entry that is a
symlink or that would be written outside the project. What the pack expanded to is recorded
in `.spfn/agent-pack.json` so drift can compare the tree file by file.

**A materialize that stopped can be resumed.** Coming back to a half-written tree compares
rather than overwrites: a file already holding exactly the bytes the release would write
counts as done and the resume continues past it, and a file holding anything else is refused
with that file left exactly as it was found. An update is the one operation that replaces —
and only after drift has already been refused, so every managed file is known to hold the
previous release's bytes rather than somebody's edit.

**Release files are paid content, and are fetched as such.** Managed files, agent packs and
the scaffold archive go out with the same bearer the private registry takes, and a refusal
comes back in the same vocabulary — so "this machine's credential has been replaced" never
arrives disguised as "that file is missing". The setup descriptor, the release catalog and
the manifests stay public and carry no bearer: they are locators and promises about a
release, and nothing anyone paid for is inside them.

**Credentials rotate before they expire, not after.** A local credential opens the registry
for a limited window. When that window is close to closing, the CLI asks the control plane
for a replacement and writes it to the keychain *before* using it — a rotation that was not
recorded can never have happened. A credential another machine has already replaced is
reported as stale rather than as missing: the two mean different things, and only one of
them means someone else's machine changed.

**Nothing secret is ever an argument.** That now includes the keychain write itself: the
`security` command goes in on stdin and the value goes in hex-encoded, so a local `ps` sees
`security -i` and nothing else. It also means a keychain item can hold a value a quoted
command line could not have carried at all, such as a multi-line key.

**Machine-local state stays local.** `spfn kit` writes `.spfn/.gitignore` covering
`operations/` the moment it creates that directory — in its own directory, never in the
project's root `.gitignore`, which belongs to the customer. Without it a release whose
scaffold forgot the rule would commit an operation journal and a lock naming the machine's
hostname and process id.

All ten places `spfn kit` touches the outside world are real implementations now. Six reach
the network or a release artifact — signed catalogs and manifests, licence activation,
credential rotation, the registry proxy, release artifacts and the scaffold — and four run
something on this machine: `pnpm install --frozen-lockfile`, the migrations through
`spfn db status --json` and `spfn db migrate`, the release's gates as the project's own
scripts, and Git for `init`, `status` and the first commit. Nothing else: no remote is
added and nothing is pushed.

What still stops a real install is the trust root. The list of keys this CLI will accept a
signed release from is **empty in this build**, because the release signing key is not
published yet — so every signed document fails verification with `KIT_MANIFEST_INVALID`,
which is the correct behaviour for a CLI that cannot yet tell a real release from a forged
one. `SPFN_KIT_TRUSTED_KEYS` supplies a list for a staging run or a release rehearsal, as a
JSON array of `{ "keyId", "publicKey" }` with base64 SPKI keys. It *replaces* the built-in
list rather than adding to it.

`SPFN_KIT_SETUP_ALLOWLIST` names the origins a setup link may be fetched from, as a
comma-separated list of bare origins. It follows the same rule as the key list — it
*replaces* the shipped one, so it can only ever narrow what this CLI will fetch a descriptor
from — and it is the one place plain `http` is accepted, for `localhost` and `127.0.0.1`
only, matched literally so a name like `127.0.0.1.example.test` is not one of them. A path,
a query, a fragment, userinfo, or a non-loopback `http` entry makes the whole variable
invalid rather than being quietly trimmed. A setup link may carry an explicit port, which is
what lets a certification environment serve one; the link itself must still be `https`
unless its origin is loopback *and* on the list.

`SPFN_KIT_CONTROL_PLANE_URL` and `SPFN_KIT_REGISTRY_URL` point a project that has *not yet
been activated* at a staging or local control plane. They are ignored once it has: the
addresses a checkout recorded when it was licensed are the addresses it keeps, so a stray
shell variable cannot move an activated project onto another service.

`status` and `check` never depend on any of it: an unreachable remote must not hide local
state, so they read the lock, the license file, the drift and the open operation from disk
and report everything else as `unknown`.

The command surface, journal, lock, keychain, verification and the whole install →
activation → exact frozen install → restore path are exercised in `test/kit/`: the remote
half against a loopback HTTP fixture answering with the licence service's and the registry
proxy's own statuses and error bodies, the scaffold against real archives on real temporary
directories, and one integration case that runs the whole install with pnpm resolving from
a registry on 127.0.0.1, the gate as a real child process and a real Git commit at the end.

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
.env.local.example                   # committed reference — Next.js keys, placeholder values
.env.server.example                  # committed reference — backend keys, placeholder values
.env.local                           # generated, gitignored (values loaded by Next.js)
.env.server                          # generated, gitignored (server secrets: DB, cache)
```

The reference is split by consumer, never combined, and a key's file follows who
reads it rather than whether it is secret:

- `.env.local` / `.env.local.example` — the Next.js process (server routes, proxy,
  SSR) and, through `NEXT_PUBLIC_*`, the browser: `SPFN_API_URL`, `SPFN_APP_URL`,
  `SPFN_AUTH_SESSION_SECRET`, `SPFN_AUTH_SESSION_TTL`, `SPFN_AUTH_CSRF`.
- `.env.server` / `.env.server.example` — the SPFN backend only, never loaded by
  Next.js: `NODE_ENV`, `SPFN_LOG_LEVEL`, `DATABASE_URL`, `CACHE_URL`, `DB_POOL_*`,
  and every OAuth, token, and admin secret.

So the session secret is secret and still lives in `.env.local` — the Next.js proxy
verifies cookies with it — while `DATABASE_URL` never appears there at all.

Full mode overlays the Prototype-to-Production baseline:

```
src/
  app/login/page.tsx                 # provider login starter UI
  app/auth/callback/page.tsx         # OAuth session handoff
  i18n/catalogs.ts                   # application-owned en/ko starter messages
  i18n/server.ts                     # configured server-side i18n registry
  server/routes/ops.ts               # ops routes under /_ops + the manifest `spfn ops` reads
  server/router.ts                   # authRouter + opsRouter + global authenticate
  server/server.config.ts            # createAuthLifecycle + i18n startup
next.config.ts                       # /_auth/* callback rewrite
.env.local                           # generated auth session secret (gitignored)
.env.server                          # auth keyring (gitignored)
```

The full RPC proxy imports the auth interceptor; it merges no route map, because the
generated one already carries the routes of the packages `.packages()` mounts. Internal auth
keys are generated with cryptographic randomness in ignored local env files;
`.env.local.example` and `.env.server.example` contain placeholders only. Add only the provider keys you use, then run
`pnpm spfn db migrate`.

Operating the app is [`spfn ops`](#spfn-ops), not a dashboard: the starter
`src/server/routes/ops.ts` exposes two read commands, and `spfn ops` discovers them from
the running server's manifest. Issuing the first token signs in as an administrator, so
uncomment `SPFN_AUTH_ADMIN_ACCOUNTS` in `.env.server` and restart before
`spfn ops token issue`. The ops surface adds no dependency — the router comes from
`@spfn/core/ops` and the tokens from `@spfn/auth`.

`init` also patches `package.json` (scripts: `spfn:dev`, `spfn:server`, `spfn:next`,
`spfn:build`, `spfn:start`, `codegen`; deps: `@spfn/core`, `spfn`, `drizzle-orm`,
`@sinclair/typebox`, `concurrently`, etc.; full also adds `@spfn/auth`, `@spfn/i18n`,
auth's `@spfn/notification` peer, and a Node `>=20.0.0` engine when the
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
`http://localhost:8790/_core/health`, and starts via `pnpm run spfn:start`.

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
detailed health is on, `GET /_core/health` carries a `migrations` object with per-package
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
`full` is the recommended baseline: core, auth, i18n and the ops surface wired together, so
you get a working authenticated app on day one, operable from the terminal. `bare` is core only — the architecture with nothing
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
that floor, and full mode's `@spfn/auth` needs the same.

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
- [`@spfn/mcp`](../mcp/README.md) — an agent-facing MCP endpoint, added on demand with
  `spfn add @spfn/mcp`.
- Project root README — framework overview and getting started.
