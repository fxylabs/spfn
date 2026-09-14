# SPFN Environment Variables

This document lists the environment variables read by `@spfn/core` and the `spfn` CLI.
Variables owned by other packages (`@spfn/auth`, `@spfn/cms`, `@spfn/storage`, …) are
listed under [Package-Specific Variables](#package-specific-variables).

Verified against the source on 2026-08-05. The authoritative definition is
`packages/core/src/config/schema.ts`; where a variable is read directly through
`process.env` the read site is named instead.

> **Renamed since the previous revision.** Old names are no longer read by any code.
> Nothing throws when they are left in place — the cache simply stays disabled and the
> API URL falls back to `http://localhost:8790` — so an outdated `.env` file fails
> silently. Rename these keys:
>
> | Old name | New name |
> |---|---|
> | `REDIS_URL` | `CACHE_URL` |
> | `REDIS_WRITE_URL` | `CACHE_WRITE_URL` |
> | `REDIS_READ_URL` | `CACHE_READ_URL` |
> | `REDIS_SENTINEL_HOSTS` | `CACHE_SENTINEL_HOSTS` |
> | `REDIS_MASTER_NAME` | `CACHE_MASTER_NAME` |
> | `REDIS_CLUSTER_NODES` | `CACHE_CLUSTER_NODES` |
> | `REDIS_PASSWORD` | `CACHE_PASSWORD` |
> | `REDIS_TLS_REJECT_UNAUTHORIZED` | `CACHE_TLS_REJECT_UNAUTHORIZED` |
> | `SERVER_API_URL` | `SPFN_API_URL` |
> | `NEXT_PUBLIC_API_URL` | `NEXT_PUBLIC_SPFN_API_URL` |

## Table of Contents

- [API Configuration](#api-configuration)
- [Database Configuration](#database-configuration)
- [Cache Configuration](#cache-configuration)
- [Server Configuration](#server-configuration)
- [Logger Configuration](#logger-configuration)
- [Package-Specific Variables](#package-specific-variables)

---

## API Configuration

> `SERVER_API_URL` was renamed to `SPFN_API_URL`, and `NEXT_PUBLIC_API_URL` to
> `NEXT_PUBLIC_SPFN_API_URL`. No code reads the old names — `SERVER_API_URL` survives
> only in a stale doc comment at `packages/core/src/nextjs/proxy/interceptors/types.ts:225`.

### `SPFN_API_URL`
- **Type**: `string` (URL)
- **Required**: Yes
- **Default**: None (call sites fall back to `http://localhost:8790`)
- **Description**: SPFN backend URL used by the Next.js RPC proxy for server-side calls
- **Usage**: Server-side (also readable by Next.js server code)
- **Example**: `http://localhost:8790`, `http://spfn-service:8790` (k8s)
- **Location**: `packages/core/src/config/schema.ts:399`, read at `packages/core/src/nextjs/proxy/rpc.ts:115`

### `NEXT_PUBLIC_SPFN_API_URL`
- **Type**: `string` (URL)
- **Required**: Yes
- **Default**: None (call sites fall back to `http://localhost:8790`)
- **Description**: Public API URL for browser-side calls (SSE and WebSocket clients)
- **Usage**: Available in both server and client
- **Example**: `https://api.example.com`, `http://localhost:8790`
- **Location**: `packages/core/src/config/schema.ts:406`, read at `packages/core/src/event/sse/client.ts:72` and `packages/core/src/event/ws/client.ts:70`

### `SPFN_APP_URL`
- **Type**: `string` (URL)
- **Required**: No
- **Default**: None (SSR falls back to the inbound request `Host` header)
- **Description**: Next.js application URL, used by the SPFN server to build absolute URLs
- **Example**: `http://localhost:3790`, `https://your-app.com`
- **Location**: `packages/core/src/config/schema.ts:413`, read at `packages/core/src/nextjs/client/core.ts:123`

### `RPC_PROXY_TIMEOUT`
- **Type**: `number` (milliseconds)
- **Required**: No
- **Default**: `120000`
- **Description**: Abort timeout for requests the Next.js proxy forwards to the backend. Keep it below `FETCH_HEADERS_TIMEOUT`.
- **Location**: `packages/core/src/config/schema.ts:420`

**Priority**: explicit `apiUrl` option > `SPFN_API_URL` > `'http://localhost:8790'`

---

## Database Configuration

### `DATABASE_URL`
- **Type**: `string` (PostgreSQL connection URL)
- **Required**: Yes (for database operations)
- **Default**: None
- **Description**: PostgreSQL database connection string
- **Example**: `postgresql://user:password@localhost:5432/dbname`
- **Location**: `packages/core/src/config/schema.ts:54`, read at `packages/core/src/server/start-server.ts:301`

### `DATABASE_WRITE_URL`
- **Type**: `string` (PostgreSQL connection URL)
- **Required**: No
- **Default**: None
- **Description**: Write (master) database URL in the master–replica setup
- **Location**: `packages/core/src/config/schema.ts:62`

### `DATABASE_READ_URL`
- **Type**: `string` (PostgreSQL connection URL)
- **Required**: No
- **Default**: None
- **Description**: Read (replica) database URL in the master–replica setup
- **Location**: `packages/core/src/config/schema.ts:70`

### `DRIZZLE_SCHEMA_PATH`
- **Type**: `string`
- **Required**: No
- **Default**: `./src/server/entities/config.ts`
- **Description**: Entity registry file that `spfn db push` / `db generate` / `db studio` load when `src/server/entities/` holds no entity file, or when the registry exports a table no file there defines
- **Location**: `packages/core/src/config/schema.ts:224`

### `DRIZZLE_OUT_DIR`
- **Type**: `string`
- **Required**: No
- **Default**: `./drizzle`
- **Description**: Output directory for Drizzle migrations
- **Location**: `packages/core/src/config/schema.ts:231`

### `SPFN_ALLOW_PENDING_MIGRATIONS`
- **Type**: `boolean`
- **Required**: No
- **Default**: `false`
- **Description**: Start the server even when a function package (or the project) has
  migrations the database has not applied. Off by default: such a server boots, passes
  its health check, and then fails every request touching a missing column as an opaque
  500. Set it where a CLI flag cannot be passed — a container's env, a CI job. The flag
  equivalent is `spfn dev --allow-pending-migrations` / `spfn start
  --allow-pending-migrations`; the config equivalent is
  `defineServerConfig().migrations({ allowPending: true })`. Either way the pending
  migrations are logged as a warning.
- **Location**: `packages/core/src/config/schema.ts`, read at
  `packages/core/src/server/migration-gate.ts`

### `TRANSACTION_TIMEOUT`
- **Type**: `number` (milliseconds)
- **Required**: No
- **Default**: `30000` (30 seconds)
- **Description**: Transaction timeout for database operations
- **Location**: `packages/core/src/config/schema.ts:188`, read at `packages/core/src/db/transaction/runner.ts:157`

### Additional database variables

All defined in `packages/core/src/config/schema.ts`.

| Variable | Type | Default | Description |
|---|---|---|---|
| `DB_POOL_MAX` | number | `10` | Max connections in the pool |
| `DB_POOL_READ_MAX` | number | falls back to `DB_POOL_MAX` | Max connections for the read-replica pool |
| `DB_POOL_IDLE_TIMEOUT` | number (seconds) | `30` | Idle connection timeout |
| `DB_RETRY_MAX` | number | `3` | Max connection retry attempts |
| `DB_RETRY_INITIAL_DELAY` | number (ms) | `100` | First retry delay |
| `DB_RETRY_MAX_DELAY` | number (ms) | `10000` | Retry delay cap |
| `DB_RETRY_FACTOR` | number | `2` | Exponential backoff factor |
| `DB_HEALTH_CHECK_ENABLED` | boolean | `true` | Run periodic health checks |
| `DB_HEALTH_CHECK_INTERVAL` | number (ms) | `60000` | Health check interval |
| `DB_HEALTH_CHECK_RECONNECT` | boolean | `true` | Reconnect on health check failure |
| `DB_HEALTH_CHECK_MAX_RETRIES` | number | `3` | Retries before marking the DB failed |
| `DB_HEALTH_CHECK_RETRY_INTERVAL` | number (ms) | `5000` | Delay between health check retries |
| `DB_MONITORING_ENABLED` | boolean | `false` | Query performance monitoring |
| `DB_MONITORING_SLOW_THRESHOLD` | number (ms) | `1000` | Slow query threshold |
| `DB_MONITORING_LOG_QUERIES` | boolean | `false` | Log every query, not just slow ones |
| `DB_MAX_ROWS` | number | `0` (unlimited) | Safety ceiling on rows returned by `findMany` |
| `DB_DEBUG_TRACE` | boolean | `false` | Detailed debug tracing |
| `TRANSACTION_IDLE_TIMEOUT` | number (ms) | `30000` | Idle time before Postgres kills a transaction (`0` disables) |
| `JOB_POLLING_INTERVAL_SECONDS` | number (seconds) | `2` | How often a pg-boss worker polls for jobs |

---

## Cache Configuration

> The whole `REDIS_*` family was renamed to `CACHE_*`. **Nothing throws when the old
> names are left in place** — `hasCacheConfig()` finds no `CACHE_*` key, logs
> "No cache configuration found" and returns no client, so the app runs cacheless.
> Check the startup log if caching silently stopped working.

All cache variables are declared in `packages/core/src/config/schema.ts` and read
directly from `process.env` in `packages/core/src/cache/cache-factory.ts`.

### Single Instance Mode

#### `CACHE_URL`
- **Type**: `string`
- **Required**: No (optional if no cache is used)
- **Default**: None
- **Description**: Redis/Valkey connection URL for single instance mode. Formerly `REDIS_URL`.
- **Example**:
  - `redis://localhost:6379`
  - `rediss://secure.cache.com:6380` (TLS)
  - `redis://:password@localhost:6379` (with auth)
- **Location**: `packages/core/src/config/schema.ts:251`, read at `packages/core/src/cache/cache-factory.ts:118`

### Read/Write Split Mode

#### `CACHE_WRITE_URL`
- **Type**: `string`
- **Required**: Yes (if using read/write split)
- **Default**: None
- **Description**: Master node URL for write operations. Formerly `REDIS_WRITE_URL`.
- **Example**: `redis://master:6379`
- **Location**: `packages/core/src/config/schema.ts:259`, read at `packages/core/src/cache/cache-factory.ts:119`

#### `CACHE_READ_URL`
- **Type**: `string`
- **Required**: Yes (if using read/write split)
- **Default**: None
- **Description**: Replica node URL for read operations. Formerly `REDIS_READ_URL`.
- **Example**: `redis://replica:6379`
- **Location**: `packages/core/src/config/schema.ts:267`, read at `packages/core/src/cache/cache-factory.ts:120`

### Sentinel Mode

#### `CACHE_SENTINEL_HOSTS`
- **Type**: `string` (comma-separated)
- **Required**: Yes (if using Sentinel)
- **Default**: None
- **Description**: Sentinel hosts. A host without a port defaults to `26379`. Formerly `REDIS_SENTINEL_HOSTS`.
- **Example**: `sentinel1:26379,sentinel2:26379,sentinel3:26379`
- **Location**: `packages/core/src/config/schema.ts:275`, read at `packages/core/src/cache/cache-factory.ts:122`

#### `CACHE_MASTER_NAME`
- **Type**: `string`
- **Required**: Yes (if using Sentinel)
- **Default**: None
- **Description**: Sentinel master name. Formerly `REDIS_MASTER_NAME`.
- **Example**: `mymaster`
- **Location**: `packages/core/src/config/schema.ts:287`, read at `packages/core/src/cache/cache-factory.ts:123`

### Cluster Mode

#### `CACHE_CLUSTER_NODES`
- **Type**: `string` (comma-separated)
- **Required**: Yes (if using Cluster)
- **Default**: None
- **Description**: Cluster nodes. A node without a port defaults to `6379`. Formerly `REDIS_CLUSTER_NODES`.
- **Example**: `node1:6379,node2:6379,node3:6379`
- **Location**: `packages/core/src/config/schema.ts:281`, read at `packages/core/src/cache/cache-factory.ts:121`

### Common Cache Options

#### `CACHE_PASSWORD`
- **Type**: `string`
- **Required**: No
- **Default**: None
- **Description**: Authentication password. Applied in Sentinel and Cluster mode only — in single-instance and read/write-split mode put the password in the URL. Formerly `REDIS_PASSWORD`.
- **Location**: `packages/core/src/config/schema.ts:293`, read at `packages/core/src/cache/cache-factory.ts:124`

#### `CACHE_TLS_REJECT_UNAUTHORIZED`
- **Type**: `string` (`'true'` | `'false'`)
- **Required**: No
- **Default**: `'true'`
- **Description**: Whether to reject unauthorized TLS connections. Only takes effect for a `rediss://` URL. Formerly `REDIS_TLS_REJECT_UNAUTHORIZED`.
- **Example**: `'false'` (for self-signed certificates)
- **Location**: `packages/core/src/config/schema.ts:300`, read at `packages/core/src/cache/cache-factory.ts:63`

#### `CACHE_MAX_RETRIES_PER_REQUEST`
- **Type**: `number`
- **Required**: No
- **Default**: `3` (ioredis' own default is 20)
- **Description**: Retries per command before it rejects, so a cache outage fails fast instead of hanging
- **Location**: `packages/core/src/config/schema.ts:306`, read at `packages/core/src/cache/cache-factory.ts:21`

#### `CACHE_ENABLE_OFFLINE_QUEUE`
- **Type**: `boolean`
- **Required**: No
- **Default**: `true`
- **Description**: Queue commands while disconnected (`true`), or reject immediately for strict fail-fast (`false`)
- **Location**: `packages/core/src/config/schema.ts:312`, read at `packages/core/src/cache/cache-factory.ts:22`

---

## Server Configuration

### `NODE_ENV`
- **Type**: `string` (`'local'` | `'development'` | `'staging'` | `'production'` | `'test'`)
- **Required**: No
- **Default**: `'local'`
- **Description**: Node.js environment mode. Also picks which `.env.{NODE_ENV}` files load.
- **Location**: `packages/core/src/config/schema.ts:44`
- **Note**: The CLI sets it only when it is not already set — `'production'` in `spfn build` / `spfn start`, `'development'` in `spfn dev`.

### `SPFN_PORT`
- **Type**: `string` | `number`
- **Required**: No
- **Default**: none — unset, the app's own `server.config` decides
- **Description**: Overrides the SPFN API server's port. Left unset, `spfn.config.js` `ports.server` decides, then the `8790` default. Read from `process.env` — the core env schema does not declare it, on purpose.
- **Example**: `8791`
- **Location**: `packages/core/src/app-config/index.ts`; `spfn dev --port` / `spfn start --port` write it

### `SPFN_HOST`
- **Type**: `string`
- **Required**: No
- **Default**: none — unset, the app's own `server.config` decides
- **Description**: Overrides the SPFN API server's host. Left unset, `spfn.config.js` `host` decides, then `localhost`. A container sets `0.0.0.0`.
- **Example**: `localhost`, `0.0.0.0`
- **Location**: `packages/core/src/app-config/index.ts`; `spfn dev --host` / `spfn start --host` write it

### `NEXT_PORT`
- **Type**: `string` | `number`
- **Required**: No
- **Default**: none — unset, `spfn.config.js` `ports.next` decides, then `3790`
- **Description**: Overrides the Next.js frontend's port. The CLI hands the resolved value to `next` as `-p`, so Next never has to find one of its own.
- **Example**: `3900`
- **Location**: `packages/core/src/app-config/index.ts`; passed through by `spfn dev` and `spfn start`

### `PORT` / `HOST` — removed

No longer read by anything. They were declared in the core env schema with
defaults of `4000` and `localhost`, and a schema default is indistinguishable
from a value someone set, so `env.PORT` was never undefined and the environment
had to be consulted last. Use `SPFN_PORT` / `SPFN_HOST`, or `spfn.config.js`.

`PORT` is also Next.js's own variable, which is the second reason the framework
does not claim it.

`@spfn/auth` derived its cookie-name suffix from `PORT` and now uses `SPFN_PORT`
— an app that had `PORT` set gets different cookie names and one sign-in restores
the session.

### Timeouts, proxy trust, rate limiting

All defined in `packages/core/src/config/schema.ts`.

| Variable | Type | Default | Description |
|---|---|---|---|
| `SERVER_TIMEOUT` | number (ms) | `120000` | Inbound request timeout |
| `SERVER_KEEPALIVE_TIMEOUT` | number (ms) | `65000` | Keep-alive timeout |
| `SERVER_HEADERS_TIMEOUT` | number (ms) | `60000` | Headers timeout |
| `SHUTDOWN_TIMEOUT` | number (ms) | `280000` | Graceful shutdown budget |
| `FETCH_CONNECT_TIMEOUT` | number (ms) | `10000` | Outbound TCP connect timeout |
| `FETCH_HEADERS_TIMEOUT` | number (ms) | `300000` | Outbound response-header timeout |
| `FETCH_BODY_TIMEOUT` | number (ms) | `300000` | Outbound timeout between body chunks |
| `SPFN_PROXY_SECRET` | string (secret) | None | Shared HMAC secret signing proxy→backend requests. Unset disables proxy-guard signing. Same value in both processes; belongs in `.env.local`. |
| `SPFN_PROXY_SECRET_PREVIOUS` | string (secret) | None | Grace keys still accepted during rotation, `<keyId>:<secret>` comma-separated. Backend-only — `.env.server`. |
| `TRUSTED_PROXY_HOPS` | number | `1` | Reverse proxies in front of the Next.js proxy, for real-client-IP extraction |
| `RATE_LIMIT_MODE` | `'off'` \| `'on'` | `'off'` | Global default rate limiter |
| `RATE_LIMIT_DEFAULT_LIMIT` | number | `100` | Requests per window for the default limiter |
| `RATE_LIMIT_DEFAULT_WINDOW_MS` | number (ms) | `60000` | Window length for the default limiter |
| `RATE_LIMIT_FAIL_CLOSED` | boolean | `false` | Reject with 429 when the cache backing the limiter is down |
| `SAFE_FETCH_BLOCK_PRIVATE_IPS` | boolean | `true` | `safeFetch` blocks requests resolving to private/reserved IPs |

---

## Logger Configuration

> The logger no longer reads any of `LOGGER_ADAPTER`, `LOGGER_FILE_ENABLED`, `LOG_DIR`,
> `SLACK_WEBHOOK_URL`, `SLACK_CHANNEL`, `SLACK_USERNAME`, `SMTP_HOST`, `SMTP_PORT`,
> `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` or `EMAIL_TO`. No code in the repository
> reads them. Slack and email delivery moved to `@spfn/notification` and `@spfn/monitor`
> — see [Package-Specific Variables](#package-specific-variables).

### `SPFN_LOG_LEVEL`
- **Type**: `string` (`'debug'` | `'info'` | `'warn'` | `'error'` | `'fatal'`)
- **Required**: No
- **Default**: `'info'`
- **Description**: Minimum log level to output
- **Location**: `packages/core/src/config/schema.ts:242`, read at `packages/core/src/logger/factory.ts:37`
- **Note**: Read once at import time. Changing it after startup has no effect.

### `NEXT_PUBLIC_SPFN_LOG_LEVEL`
- **Type**: same as `SPFN_LOG_LEVEL`
- **Required**: No
- **Default**: None (falls back to `SPFN_LOG_LEVEL`, then `'info'`)
- **Description**: Log level for browser-side code, where a non-`NEXT_PUBLIC_` variable is not visible
- **Location**: `packages/core/src/logger/factory.ts:38`

`NODE_ENV` also affects the logger: console output is colorized outside production
(`packages/core/src/logger/config.ts:16`).

---

## Package-Specific Variables

Each package declares its own schema. Read that file for the authoritative list —
only the entry points are named here.

| Package | Schema | Prefix |
|---|---|---|
| `@spfn/auth` | `packages/auth/src/config/schema.ts` | `SPFN_AUTH_*`, plus OAuth provider keys |
| `@spfn/cms` | `packages/cms/src/config/schema.ts` | `SPFN_CMS_*` |
| `@spfn/notification` | `packages/notification/src/config/schema.ts` | `SPFN_NOTIFICATION_*` (e.g. `SPFN_NOTIFICATION_SLACK_WEBHOOK_URL`, `SPFN_NOTIFICATION_EMAIL_FROM`) |
| `@spfn/monitor` | `packages/monitor/src/config/schema.ts` | `SPFN_MONITOR_*` (e.g. `SPFN_MONITOR_SLACK_WEBHOOK_URL`) |
| `@spfn/storage` | no schema module — read directly via `process.env` | `STORAGE_PROVIDER`, `S3_*`, `GCS_*`, `LOCAL_STORAGE_*`, `STORAGE_CONTRACT_*` |

**Declared but unread:** `@spfn/cms` declares `SPFN_CMS_DETECT_BROWSER_LANGUAGE`
(`packages/cms/src/config/schema.ts:48`) and `SPFN_CMS_DEFAULT_LOCALE`
(`packages/cms/src/config/schema.ts:38`), but no code reads either. Setting them
does nothing.

---

## Environment Variable Priority

### API URL Resolution
```
explicit apiUrl option
  > SPFN_API_URL (server-side proxy)
    > 'http://localhost:8790' (fallback)

Browser (SSE / WebSocket clients):
NEXT_PUBLIC_SPFN_API_URL
  > 'http://localhost:8790' (fallback)
```

### Server Port / Host Resolution

Three layers, and the same three whichever way the server is started.

```
SPFN_PORT > spfn.config.js ports.server > 8790
NEXT_PORT > spfn.config.js ports.next   > 3790
SPFN_HOST > spfn.config.js host         > localhost
```

Each default exists in exactly one place, `packages/core/src/app-config`. That is
the point of the shape: a default declared at an input layer — a CLI option, a
generated entry file, an env schema — cannot be told apart from a value someone
supplied, so it silently outranks everything below it. Three separate defects
came from that, including an env schema default that forced the environment to be
consulted last and made an injected port unreachable.

`spfn dev --port` / `spfn start --port` write `SPFN_PORT`, so a flag sits at the
top of the chain by joining it rather than bypassing it.

Two names because two processes are started, and Next.js reads `PORT` as its own.
`PORT` and `HOST` are no longer part of the core env schema.

`ServerConfig.port()` / `.host()` are deprecated. They still work for one release,
sitting between `spfn.config.js` and the default, and warn at boot.

### Cache Mode Detection

Evaluated in this order in `packages/core/src/cache/cache-factory.ts:127`:

```
1. Single Instance:  CACHE_URL set, and no CACHE_WRITE_URL / CACHE_READ_URL / CACHE_CLUSTER_NODES
2. Read/Write Split: CACHE_WRITE_URL + CACHE_READ_URL both set
3. Sentinel:         CACHE_SENTINEL_HOSTS + CACHE_MASTER_NAME both set
4. Cluster:          CACHE_CLUSTER_NODES set
5. Fallback:         CACHE_URL set alongside other keys
6. No Cache:         none set — logged, not thrown
```

### `.env` File Loading Order

Later files override earlier ones (`packages/core/src/env/loader.ts`):

```
.env
  > .env.{NODE_ENV}
    > .env.local            (skipped when NODE_ENV=test)
      > .env.{NODE_ENV}.local
        > .env.server       (server-only; Next.js never loads it)
```

---

## Example Configurations

### Development (.env.local)
```bash
# Database
DATABASE_URL=postgresql://spfn:spfn@localhost:5432/spfn_dev

# Cache (optional)
CACHE_URL=redis://localhost:6379

# API URLs
SPFN_API_URL=http://localhost:8790
NEXT_PUBLIC_SPFN_API_URL=http://localhost:8790
SPFN_APP_URL=http://localhost:3790

# Server
NODE_ENV=development
```

### Production (Docker/K8s)
```bash
# Database
DATABASE_URL=postgresql://user:pass@db-host:5432/production_db

# Cache Cluster
CACHE_CLUSTER_NODES=node1:6379,node2:6379,node3:6379
CACHE_PASSWORD=<set in your secret manager>

# API URLs
SPFN_API_URL=http://spfn-service:8790          # Internal k8s service
NEXT_PUBLIC_SPFN_API_URL=https://api.example.com  # Public domain

# Server
NODE_ENV=production
SPFN_PORT=8790
SPFN_HOST=0.0.0.0

# Logging
SPFN_LOG_LEVEL=info
```

### Production (AWS EC2)
```bash
# Database
DATABASE_URL=postgresql://user:pass@rds-endpoint:5432/db

# Cache Sentinel
CACHE_SENTINEL_HOSTS=sentinel1:26379,sentinel2:26379
CACHE_MASTER_NAME=mymaster
CACHE_PASSWORD=<set in your secret manager>

# API URLs
SPFN_API_URL=http://172.31.x.x:8790            # Internal VPC IP
NEXT_PUBLIC_SPFN_API_URL=https://api.example.com  # Public domain

# Alerts — see @spfn/notification for the full set
SPFN_NOTIFICATION_EMAIL_FROM=noreply@example.com
```

---

## Notes

### Security
- **Never commit `.env.local`, `.env.*.local` or `.env.server`** to version control
- Only `*.example` env files are committed, with placeholder values
- Store production secrets in CI/CD secret management
- Prefix client-accessible vars with `NEXT_PUBLIC_`

### `.env.server`
- Server-only variables live in **`.env.server`**. Next.js never loads this file, so
  nothing in it can leak into the browser bundle.
- `.env.server.local` no longer exists — move anything still in it to `.env.server`.
- A variable read by both the Next.js process and the SPFN backend (such as
  `SPFN_PROXY_SECRET`) must go in `.env.local` instead, since `.env.server` is invisible
  to Next.js.

### Next.js Behavior
- `NEXT_PUBLIC_*` vars are embedded in browser bundle
- Non-prefixed vars are server-only
- Changes require rebuild for browser bundle

### SPFN CLI Behavior
- `spfn build` sets `NODE_ENV=production` **only if it is not already set**
- `spfn start` sets `NODE_ENV=production` **only if it is not already set**
- `spfn dev` keeps current `NODE_ENV` or defaults to `development`
