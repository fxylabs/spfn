# @spfn/core/config — @spfn/core's own validated env config

A **prebuilt env registry** for the variables `@spfn/core` itself consumes (database,
cache, server, fetch, Next.js integration). It is a thin application of `@spfn/core/env`:
it owns one fixed schema (`coreEnvSchema`), builds a registry from it, and exports the
validated proxy. It does **not** add new env machinery — for the schema DSL, parsers,
registry semantics, and file loading, see [@spfn/core/env](../env/README.md).

## Import paths

```typescript
// The validated proxy + the schema + the registry — all from one entry point.
import { env, envSchema, registry } from '@spfn/core/config';
```

There is a single entry point (`@spfn/core/config`). It re-exports nothing from
`@spfn/core/env`; if you need `defineEnvSchema`, parsers, `loadEnv`, type guards, etc.,
import them from `@spfn/core/env` / `@spfn/core/env/loader` directly.

---

## Public API (complete)

The module exports exactly three values:

| Export | Type | What it is |
|--------|------|------------|
| `env` | `InferEnvType<typeof coreEnvSchema>` (a **Proxy**) | The validated config object. Read variables off it. |
| `envSchema` | `EnvSchemaCollection` | The schema object (`coreEnvSchema`), re-exported under the name `envSchema`. Read `.description` / `.default` / `.examples` per key. |
| `registry` | `EnvRegistry` | The `EnvRegistry` instance backing `env` (`createEnvRegistry(coreEnvSchema)`). Exposes `.validate()`, `.validateAll()`, `.reset()`, `.register(...)`. |

`env` is literally `registry.validate()` — they are the same proxy.

> **No** `getEnv` / `loadConfig` / `config()` / `getConfig` function exists, and the schema
> is **not** something you pass in — it is fixed. To define your *own* app's variables,
> build a separate schema/registry with `@spfn/core/env`; do not try to extend
> `coreEnvSchema` by mutation.

---

## Quick Start

```typescript
import { env } from '@spfn/core/config';

const poolMax: number  = env.DB_POOL_MAX;          // number  (default 10)
const logLevel         = env.SPFN_LOG_LEVEL;       // 'debug' | 'info' | 'warn' | 'error' | 'fatal'
const apiUrl: string   = env.SPFN_API_URL;         // string  (required)
const appUrl           = env.SPFN_APP_URL;         // string | undefined (optional)
```

In the **SPFN server** entry point, call `loadEnv()` (from `@spfn/core/env/loader`)
**before** reading any value, so `process.env` is populated from the `.env*` files:

```typescript
import { loadEnv } from '@spfn/core/env/loader';
import { env } from '@spfn/core/config';

loadEnv();              // populate process.env (server reads .env.server too)
console.log(env.PORT);  // validated lazily, here
```

In **Next.js** code, do **not** call `loadEnv()` — Next.js loads `.env*` itself. Just read
from `env`.

---

## Validation is lazy (read this before relying on startup checks)

`env` is the Proxy returned by `registry.validate()`. Importing `@spfn/core/config` does
**not** read or validate any variable value. Each variable is read from `process.env`,
defaulted, and run through its `validator` **at the moment you access the property**.

```typescript
import { env } from '@spfn/core/config';  // imports the proxy — validates nothing yet
import { loadEnv } from '@spfn/core/env/loader';

loadEnv();
env.SPFN_API_URL;  // read + validated HERE; throws if missing (required) or invalid
```

Consequences:

- A missing **required** variable (`SPFN_API_URL`) does not
  throw on import — it throws on first access (`Error('Environment validation failed')`).
- You may import `env` before `loadEnv()` runs; values are picked up lazily.
- For an **eager** all-at-once check (CI / startup gate), call `registry.validateAll()`
  (returns `{ errors, warnings }`) or pass `registry` to `validateAllEnv([...])` from
  `@spfn/core/env`. `SKIP_ENV_VALIDATION=true` skips only the lazy `required` check, not
  these eager checks.
- **The SPFN server runs that eager check at boot.** `startServer` validates this
  registry — plus any registries the app hands over with
  `defineServerConfig().env({ registries })` — before it listens, and exits with code 1
  listing each failing key (never a value). See
  [Boot-time check](../env/README.md#boot-time-check-the-server).

See [@spfn/core/env](../env/README.md) for the full registry / proxy / `SKIP_ENV_VALIDATION`
semantics — this module inherits all of it unchanged.

---

## Reading schema metadata

```typescript
import { envSchema } from '@spfn/core/config';

envSchema.DB_POOL_MAX.description; // 'Maximum number of database connections in pool'
envSchema.DB_POOL_MAX.default;     // 10
envSchema.DB_POOL_MAX.examples;    // [10, 20, 50]
```

`envSchema` is the schema object, not the values. Use `env` for actual (validated) values.

---

## Environment variables (the fixed `coreEnvSchema`)

All variables below are exactly what `coreEnvSchema` declares. URL variables marked with a
validator **throw on access** if the value is present but malformed.

### Core

| Variable | Type | Default | Notes |
|----------|------|---------|-------|
| `NODE_ENV` | `'local' \| 'development' \| 'staging' \| 'production' \| 'test'` | `'local'` | `nextjs: true` |

### Database — connection URLs (all optional, all `sensitive`, validated as postgres URLs)

| Variable | Type | Required | Validator |
|----------|------|----------|-----------|
| `DATABASE_URL` | `string` | No | `parsePostgresUrl` |
| `DATABASE_WRITE_URL` | `string` | No | `parsePostgresUrl` |
| `DATABASE_READ_URL` | `string` | No | `parsePostgresUrl` |

### Database — connection pool

| Variable | Type | Default |
|----------|------|---------|
| `DB_POOL_MAX` | `number` | `10` |
| `DB_POOL_IDLE_TIMEOUT` | `number` | `30` (seconds) |

### Database — retry

| Variable | Type | Default |
|----------|------|---------|
| `DB_RETRY_MAX` | `number` | `3` |
| `DB_RETRY_INITIAL_DELAY` | `number` | `100` (ms) |
| `DB_RETRY_MAX_DELAY` | `number` | `10000` (ms) |
| `DB_RETRY_FACTOR` | `number` | `2` |

### Database — health check

| Variable | Type | Default |
|----------|------|---------|
| `DB_HEALTH_CHECK_ENABLED` | `boolean` | `true` |
| `DB_HEALTH_CHECK_INTERVAL` | `number` | `60000` (ms) |
| `DB_HEALTH_CHECK_RECONNECT` | `boolean` | `true` |
| `DB_HEALTH_CHECK_MAX_RETRIES` | `number` | `3` |
| `DB_HEALTH_CHECK_RETRY_INTERVAL` | `number` | `5000` (ms) |

### Database — monitoring

| Variable | Type | Default |
|----------|------|---------|
| `DB_MONITORING_ENABLED` | `boolean` | `false` |
| `DB_MONITORING_SLOW_THRESHOLD` | `number` | `1000` (ms) |
| `DB_MONITORING_LOG_QUERIES` | `boolean` | `false` |

### Database — transaction / development

| Variable | Type | Default |
|----------|------|---------|
| `TRANSACTION_TIMEOUT` | `number` | `30000` (ms) |
| `DB_DEBUG_TRACE` | `boolean` | `false` |

### Drizzle ORM

| Variable | Type | Default |
|----------|------|---------|
| `DRIZZLE_SCHEMA_PATH` | `string` | `'./src/server/entities/config.ts'` |
| `DRIZZLE_OUT_DIR` | `string` | `'./drizzle'` |

### Logger

| Variable | Type | Default |
|----------|------|---------|
| `SPFN_LOG_LEVEL` | `'debug' \| 'info' \| 'warn' \| 'error' \| 'fatal'` | `'info'` |

### Cache (Redis/Valkey) — all optional

| Variable | Type | `sensitive` | Validator |
|----------|------|-------------|-----------|
| `CACHE_URL` | `string` | yes | `parseRedisUrl` |
| `CACHE_WRITE_URL` | `string` | yes | `parseRedisUrl` |
| `CACHE_READ_URL` | `string` | yes | `parseRedisUrl` |
| `CACHE_SENTINEL_HOSTS` | `string` | no | — (comma-separated hosts) |
| `CACHE_CLUSTER_NODES` | `string` | no | — (comma-separated nodes) |
| `CACHE_MASTER_NAME` | `string` | no | — (Sentinel master name) |
| `CACHE_PASSWORD` | `string` | yes | — |
| `CACHE_TLS_REJECT_UNAUTHORIZED` | `boolean` | — | default `true` |

> These four patterns are mutually exclusive at the connection layer (single / master-replica
> / sentinel / cluster) — the schema does not enforce that; it only validates individual values.

### Server

| Variable | Type | Default |
|----------|------|---------|
| `PORT` | `number` | `4000` |
| `HOST` | `string` | `'localhost'` |
| `SERVER_TIMEOUT` | `number` | `120000` (ms) |
| `SERVER_KEEPALIVE_TIMEOUT` | `number` | `65000` (ms) |
| `SERVER_HEADERS_TIMEOUT` | `number` | `60000` (ms) |
| `SHUTDOWN_TIMEOUT` | `number` | `280000` (ms) — must be < k8s `terminationGracePeriodSeconds` minus preStop sleep |

### Fetch (outbound HTTP via Node `undici`)

| Variable | Type | Default |
|----------|------|---------|
| `FETCH_CONNECT_TIMEOUT` | `number` | `10000` (ms) |
| `FETCH_HEADERS_TIMEOUT` | `number` | `300000` (ms) |
| `FETCH_BODY_TIMEOUT` | `number` | `300000` (ms) |

### Next.js integration

| Variable | Type | Required | Validator | Notes |
|----------|------|----------|-----------|-------|
| `SPFN_API_URL` | `string` (`envUrl`) | **Yes** | URL | `nextjs: true`; Next.js → backend |
| `NEXT_PUBLIC_SPFN_API_URL` | `string` (`envUrl`) | No | URL | `nextjs: true`; client-exposed, inlined by Next.js at build; the server uses `SPFN_API_URL` |
| `SPFN_APP_URL` | `string` (`envUrl`) | No (no default) | URL | `nextjs: true`; SPFN server → Next.js |
| `RPC_PROXY_TIMEOUT` | `number` | No (default `120000`) | — | `nextjs: true`; keep < `FETCH_HEADERS_TIMEOUT` |

> `SPFN_API_URL` is **required** — a missing or non-URL value throws on first access.
> `NEXT_PUBLIC_SPFN_API_URL` is optional to the server, which falls back to `SPFN_API_URL`;
> set it wherever browser code needs the API URL. These three URLs are declared by
> `@spfn/core` only — packages read them from `@spfn/core/config` rather than declaring them again.

---

## Pitfalls & anti-patterns

- **Don't expect validation on import.** Importing `@spfn/core/config` validates nothing;
  the proxy validates each variable on property access. A missing `SPFN_API_URL` throws
  when you *read* it, not when you import `env`. The SPFN server does check it eagerly at
  boot (`startServer` / `createServerlessApp`), so a server process needs it set.
- **The three URLs are validated as URLs (`envUrl`).** A non-URL string in `SPFN_API_URL`,
  `NEXT_PUBLIC_SPFN_API_URL` or `SPFN_APP_URL` fails on access and at boot.
- **Don't call `loadEnv()` inside Next.js.** Next.js already loads `.env*`. Calling it there
  (with `server: true`) would pull `.env.server` secrets into the Next.js process. In the
  **SPFN server** entry point you *do* call `loadEnv()` before touching `env`.
- **The schema is fixed — don't try to add app variables here.** `coreEnvSchema` covers only
  `@spfn/core`'s own variables. For your application's variables, define a separate schema
  and registry via `@spfn/core/env` (`defineEnvSchema` + `createEnvRegistry`); validate both
  registries together with `validateAllEnv([coreRegistry, appRegistry])`.
- **`env` vs `envSchema`.** `env.DB_POOL_MAX` is the resolved value (`number`);
  `envSchema.DB_POOL_MAX` is the schema entry (read `.default` / `.description` / `.examples`).
  Don't read values off `envSchema` or metadata off `env`.
- **`CACHE_*` / `DATABASE_*` URLs are validated.** A present-but-malformed value throws via
  `parseRedisUrl` / `parsePostgresUrl` on access — these are not free-form strings.
- **No config-specific loader.** This module re-exports nothing from `@spfn/core/env`. Import
  `loadEnv` from `@spfn/core/env/loader`, parsers/guards from `@spfn/core/env`.

---

## Complete example

```typescript
// SPFN server entry point
import { loadEnv } from '@spfn/core/env/loader';
import { env, registry } from '@spfn/core/config';

loadEnv();   // populate process.env from .env* (server includes .env.server)

// Eager gate for a custom entry point — startServer() already runs this check
// (see "Boot-time check" in the env README), so an SPFN server needs none of it.
const { errors, warnings } = registry.validateAll();
for (const w of warnings) console.warn(`${w.key}: ${w.message}`);
if (errors.length)
{
    for (const e of errors) console.error(`${e.key}: ${e.message}`);
    process.exit(1);
}

// Lazily-validated reads:
const server =
{
    port: env.PORT,                       // 4000 (default)
    host: env.HOST,                       // 'localhost' (default)
    requestTimeout: env.SERVER_TIMEOUT,   // 120000 (default)
};

const db =
{
    url: env.DATABASE_URL,                // string | undefined
    poolMax: env.DB_POOL_MAX,             // 10 (default)
    monitoring: env.DB_MONITORING_ENABLED // false (default)
};

const apiUrl = env.SPFN_API_URL;          // required URL — throws if unset/invalid
```

```typescript
// Next.js — no loadEnv()
import { env } from '@spfn/core/config';

const apiUrl = env.NEXT_PUBLIC_SPFN_API_URL; // optional URL, client-exposed
```

```typescript
// Reset the validated flag (tests only)
import { registry } from '@spfn/core/config';
registry.reset();
```

---

## Types reference

```typescript
// env's element types come straight from coreEnvSchema via InferEnvType:
type NodeEnv  = 'local' | 'development' | 'staging' | 'production' | 'test';
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
// `typeof env` = InferEnvType<typeof coreEnvSchema> (see @spfn/core/env)
```

## Related

- [@spfn/core/env](../env/README.md) — the schema DSL, parsers, registry, type guards, and
  `loadEnv` that this module is built on. **Read this for everything not specific to
  `coreEnvSchema`.**
- [@spfn/core/logger](../logger/README.md) — consumes `SPFN_LOG_LEVEL`.
- [@spfn/core/db](../db/README.md) — consumes the `DATABASE_*` / `DB_*` variables.
- [@spfn/core](../../README.md) — main package documentation.
