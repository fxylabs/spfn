# @spfn/monitor — error tracking, logging, and a dashboard you don't build

> **Find out something broke without sending your errors to someone else's server**

A deployed product fails in ways local development never shows, and the usual answer is a
third-party service: another account, another bill, and your users' data leaving your
infrastructure. `@spfn/monitor` keeps it in your own PostgreSQL instead.

Errors are captured from the server's error handler, deduplicated by fingerprint so one
broken route is one entry rather than ten thousand, and pushed to Slack when a state
changes. A pluggable developer-log store, superadmin-only admin routes and ready-made React
dashboard components come with it — this is the one dashboard you don't have to build,
because it is generic. Operating on your own data is a different job; that is
[`@spfn/mcp`](../mcp/README.md).

It integrates into an SPFN server through `defineServerConfig()` (an `onError` middleware
plus lifecycle) and a package router mounted with `.packages([...])`.

## Install

```bash
pnpm add @spfn/monitor drizzle-orm@1.0.0-rc.4
```

Peer dep: `next` (`^16.3.3`, optional — only needed for the `nextjs/client` components).
Workspace deps `@spfn/core`, `@spfn/auth`, `@spfn/notification` come transitively.

The migrations run `CREATE EXTENSION IF NOT EXISTS pg_trgm`, which the trigram GIN index
on the error-group search needs. A managed PostgreSQL that does not allow the extension
fails the migration rather than degrading, so check the provider before installing.

## Import paths

There are **four** entry points (from `package.json` `exports`):

```typescript
// Client-safe: API client + shared types/consts
import { monitorApi, type MonitorRouter, type MonitorStats } from '@spfn/monitor';

// Server-only: router, integrations, services, repos, entities (uses node:crypto, DB)
import { monitorRouter, createMonitorErrorHandler, writeLog } from '@spfn/monitor/server';

// Config: code-level overrides + env getters + schema
import { configureMonitor, getMonitorConfig } from '@spfn/monitor/config';

// React components ('use client') — Next.js only
import { MonitorDashboard } from '@spfn/monitor/nextjs/client';
```

Importing `@spfn/monitor/server` runs `@spfn/monitor/config` as a side effect (env registry
is built). Never import `/server` or `/config`'s `env`-touching code into client/edge bundles.

---

## Setup (SPFN server)

Three integration points, all on `defineServerConfig()` + the app router:

```typescript
// src/server/server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import {
    createMonitorErrorHandler,
    createMonitorLifecycle,
} from '@spfn/monitor/server';
import { appRouter } from './router';

export default defineServerConfig()
    .middleware({ onError: createMonitorErrorHandler() })
    .routes(appRouter)
    .lifecycle(createMonitorLifecycle())
    .build();
```

Mount `monitorRouter` as a **package router** on your app router (so its `/_monitor/admin/*`
routes are served, but stay out of `AppRouter`'s client types — call them via `monitorApi`):

```typescript
// src/server/router.ts
import { defineRouter } from '@spfn/core/route';
import { monitorRouter } from '@spfn/monitor/server';
import { authRouter } from '@spfn/auth/server';

export const appRouter = defineRouter({ /* your routes */ })
    .packages([authRouter, monitorRouter]);
```

> `monitorRouter` is built with `defineRouter({...})` — there is no `mergeRouters` export in
> `@spfn/core/route`. Use `.packages([monitorRouter])`, not `mergeRouters(...)`.

### Database migration

`monitorSchema = createSchema('@spfn/monitor')` → the PostgreSQL schema **`spfn_monitor`**
with tables `error_groups`, `error_events`, `logs`.

```bash
pnpm spfn db push                       # dev: push schema directly
# or, with migration history (production):
pnpm spfn db generate && pnpm spfn db migrate
```

`@spfn/monitor` ships pre-generated SQL under `migrations/` (declared via `package.json`
`spfn.migrations.dir`); SPFN's CLI picks up the package's entities (`spfn.schemas`).

---

## Configuration

### Environment variables

All optional. Resolution order is **code config > env > built-in default**.

| Variable | Default | Description |
|----------|---------|-------------|
| `SPFN_MONITOR_SLACK_WEBHOOK_URL` | — | Slack webhook for error notifications (falls back to `@spfn/notification` default) |
| `SPFN_MONITOR_ERROR_RETENTION_DAYS` | `90` | Days to retain error events |
| `SPFN_MONITOR_LOG_RETENTION_DAYS` | `30` | Days to retain logs |
| `SPFN_MONITOR_MIN_STATUS_CODE` | `500` | Minimum HTTP status code tracked as an error |

The webhook URL is a secret — keep it in `.env.server` (server-only), never a committed file.

### Code config

```typescript
import { configureMonitor } from '@spfn/monitor/config';

configureMonitor({
    slackWebhookUrl: process.env.SPFN_MONITOR_SLACK_WEBHOOK_URL, // override
    errorRetentionDays: 90,
    logRetentionDays: 30,
    minStatusCode: 500,
});
```

`MonitorConfig` keys: `slackWebhookUrl?`, `errorRetentionDays?`, `logRetentionDays?`,
`minStatusCode?`. Getters resolve config > env > default:
`getMonitorConfig()`, `getSlackWebhookUrl()`, `getErrorRetentionDays()`,
`getLogRetentionDays()`, `getMinStatusCode()`. The validated env proxy is exported as `env`,
the schema as `monitorEnvSchema`.

> Retention values are *exposed* config, but this package does **not** ship a purge
> scheduler. `LogStore.purge(olderThan)` and `logsRepository.deleteOlderThan(date)` exist;
> wire up your own cron/job if you want automatic retention enforcement.

---

## Error tracking

`createMonitorErrorHandler(options?)` returns an `onError` callback (signature
`(err: Error, ctx) => Promise<void>`) — a drop-in replacement for
`createErrorSlackNotifier` from `@spfn/notification`. On each error at/above `minStatusCode`
it calls `trackError`, which does state-based deduplication:

| Existing group state | Action | Slack? |
|----------------------|--------|--------|
| none (new fingerprint) | create group + event | yes (`new`) |
| `active` / `ignored` | increment count + create event | no |
| `resolved` | reopen → `active`, increment, create event | yes (`reopened`) |

Errors below `minStatusCode` are skipped. Slack/event failures are caught and logged — they
never break the response.

```typescript
createMonitorErrorHandler({
    minStatusCode: 500,                 // default: getMinStatusCode() (env or 500)
    environment: process.env.NODE_ENV,  // shown in the Slack title, e.g. "[production]"
    extractMetadata: (err, ctx) => ({   // stored on the error_event row
        serverInstance: process.env.HOSTNAME,
    }),
});
```

`MonitorErrorHandlerOptions`: `minStatusCode?`, `environment?`, `extractMetadata?(err, ctx)`.

### Fingerprinting

`generateFingerprint(name, message, path)` → `SHA-256(name:message:path)` sliced to the
first **16 hex chars**. Same name+message+path ⇒ same group. The `path` component means the
same error from different routes is grouped separately.

### Manual tracking

```typescript
import { trackError } from '@spfn/monitor/server';

await trackError(
    error,                              // Error
    {                                   // ErrorTrackingContext
        statusCode: 500,
        path: '/api/example',
        method: 'POST',
        requestId: 'req_123',           // optional
        userId: 'user_42',              // optional, string
        headers: { /* ... */ },         // optional
        query: { /* ... */ },           // optional
        environment: 'production',      // optional
    },
    { custom: 'metadata' },             // optional 3rd arg → error_event.metadata
);
```

`ErrorTrackingContext` requires `statusCode`, `path`, `method`; the rest are optional.

### Status management

```typescript
import { updateErrorGroupStatus } from '@spfn/monitor/server';

await updateErrorGroupStatus(groupId, 'resolved');  // sets resolved_at
await updateErrorGroupStatus(groupId, 'ignored');
await updateErrorGroupStatus(groupId, 'active');     // reopen
```

Throws if the group id does not exist. Statuses: `ERROR_GROUP_STATUSES` =
`['active', 'resolved', 'ignored']` (type `ErrorGroupStatus`).

---

## Developer logging

```typescript
import { writeLog, queryLogs, monitor } from '@spfn/monitor/server';

await writeLog({
    level: 'info',                      // LogLevel: debug|info|warn|error|fatal
    message: 'User signed in',
    source: 'auth',                     // optional
    requestId: 'req_123',               // optional
    userId: 'user_42',                  // optional, string
    metadata: { provider: 'google' },   // optional
});

await monitor.log({ level: 'warn', message: 'Rate limit approaching' }); // shorthand → writeLog

const logs = await queryLogs({          // LogFilters
    level: 'error',
    source: 'payment',
    search: 'timeout',                  // ILIKE over message + source
    requestId, userId,
    dateFrom: new Date('2024-01-01'),
    dateTo: new Date(),
    limit: 50,                          // unbounded if omitted
    offset: 0,
});
```

`writeLog` / `queryLogs` return `Log` / `Log[]`. `LOG_LEVELS` =
`['debug','info','warn','error','fatal']` (type `LogLevel`).

### Custom log store

Swap the default DB store for any backend implementing `LogStore`:

```typescript
import { setLogStore, getLogStore, type LogStore } from '@spfn/monitor/server';

const s3Store: LogStore = {
    async write(entry)     { /* NewLog → Log */ },
    async query(filters)   { /* LogFilters → Log[] */ },
    async purge(olderThan) { /* Date → number deleted */ },
};

setLogStore(s3Store);
```

`setLogStore` is process-global and affects `writeLog`/`queryLogs` immediately. The default
store writes to the `logs` table. The admin `GET /_monitor/admin/logs` route also goes
through the current store.

---

## Admin API routes

Mounted by `monitorRouter`. Every route requires authentication **and** the `superadmin`
role (`authenticate` + `requireRole('superadmin')` from `@spfn/auth/server`).

| Method | Path | Query / body | Description |
|--------|------|--------------|-------------|
| GET | `/_monitor/admin/errors` | `status, path, search, dateFrom, dateTo, limit(1-100), offset` | List error groups (limit default 20) |
| GET | `/_monitor/admin/errors/:id` | — | Group detail + recent 20 events |
| PATCH | `/_monitor/admin/errors/:id` | body `{ status }` | Update status (resolve/ignore/reopen) |
| GET | `/_monitor/admin/errors/:id/events` | `limit(1-100), offset` | Events for a group (limit default 20) |
| GET | `/_monitor/admin/logs` | `level, source, search, requestId, userId, dateFrom, dateTo, limit(1-100), offset` | Query logs (limit default 50) |
| GET | `/_monitor/admin/stats` | — | `MonitorStats` dashboard aggregate |

`:id` and `limit`/`offset` are numbers; `dateFrom`/`dateTo` are ISO strings.

### API client

```typescript
import { monitorApi } from '@spfn/monitor';

const stats  = await monitorApi.getStats.call({});
const errors = await monitorApi.listErrors.call({ query: { status: 'active', limit: 20 } });
const detail = await monitorApi.getErrorDetail.call({ params: { id: 42 } });
const events = await monitorApi.listErrorEvents.call({ params: { id: 42 }, query: { limit: 50 } });
const logs   = await monitorApi.listLogs.call({ query: { level: 'error' } });
await monitorApi.updateErrorStatus.call({ params: { id: 42 }, body: { status: 'resolved' } });
```

`monitorApi` is built with `createApi<typeof monitorRouter>` from `@spfn/core/nextjs`.
Route keys: `listErrors`, `getErrorDetail`, `updateErrorStatus`, `listErrorEvents`,
`listLogs`, `getStats`.

### `MonitorStats` shape

```typescript
interface MonitorStats
{
    errors: { total: number; active: number; resolved: number; ignored: number };
    recentErrors: ErrorGroup[];                       // latest 10 active groups
    logs: { total: number; byLevel: Record<LogLevel, number> };
    trends: { errorsLast24h: number; errorsLast7d: number; logsLast24h: number };
}
```

---

## Dashboard components

`'use client'` React components from `@spfn/monitor/nextjs/client`. They fetch through
`monitorApi` (so the admin routes must be served and the caller must be a superadmin) and
style with Tailwind CSS (dark-mode aware).

```tsx
// app/admin/monitor/page.tsx
import { MonitorDashboard } from '@spfn/monitor/nextjs/client';

export default function MonitorPage()
{
    return <MonitorDashboard />;   // no props — tabs (errors/logs) + stats + drill-down
}
```

Individual components and their props:

| Component | Props | Notes |
|-----------|-------|-------|
| `MonitorDashboard` | — | Full dashboard: stats + Errors/Logs tabs + detail drill-down |
| `StatsOverview` | — | Error/log count + trend cards |
| `ErrorListView` | `onSelect?: (id: number) => void` | Filterable error-group table |
| `ErrorDetailView` | `errorId: number`, `onBack?: () => void` | Detail + event timeline + status actions |
| `LogViewer` | — | Searchable log list with expandable metadata |

```tsx
<ErrorListView onSelect={(id) => router.push(`/admin/monitor/errors/${id}`)} />
<ErrorDetailView errorId={42} onBack={() => router.back()} />
```

---

## Pitfalls & anti-patterns

- **`mergeRouters` does not exist.** Some older docs/JSDoc show
  `.routes(mergeRouters(appRouter, monitorRouter))` — `@spfn/core/route` exports no such
  function. Mount the monitor router with `.packages([monitorRouter])` on your app router.
- **Package routes are excluded from `AppRouter` client types.** After
  `.packages([monitorRouter])`, the `/_monitor/admin/*` routes are served but **not** on the
  `api` client — always call them through `monitorApi`, not `api`.
- **Don't import `/server` or `/config` into client/edge bundles.** `/server` pulls in
  `node:crypto`, DB access, and (via the config side-effect) the env registry. The only
  browser-safe entry points are `@spfn/monitor` (client API + types) and
  `@spfn/monitor/nextjs/client` (components).
- **`onError` only fires for thrown/error responses ≥ `minStatusCode` (default 500).** 4xx
  results that don't throw aren't tracked. Lower `minStatusCode` (env or option) to widen.
- **Fingerprint includes `path`.** The *same* error surfacing on two routes becomes two
  groups; a templated path with embedded ids (`/users/123`) fragments groups — normalize the
  path before it reaches tracking if you need them merged.
- **No automatic retention/purge.** `*_RETENTION_DAYS` are just config values read by getters;
  nothing deletes old rows on its own. Schedule `logStore.purge()` /
  `logsRepository.deleteOlderThan()` (and an equivalent for error events) yourself.
- **No Slack webhook ⇒ silent skip, not an error.** `notifyErrorToSlack` logs a warning and
  returns when the URL is unset; tracking still persists to the DB.
- **`setLogStore` is global and unconditional.** It replaces the store for the whole process
  (including the admin log route). There is no per-call store override.
- **`userId` is a string everywhere here** (`error_events.user_id`, `logs.user_id`,
  `WriteLogParams.userId`). The error handler stringifies the auth context's `userId` for you;
  in manual calls pass a string.

---

## Complete example

```typescript
// src/server/router.ts
import { defineRouter } from '@spfn/core/route';
import { authRouter } from '@spfn/auth/server';
import { monitorRouter } from '@spfn/monitor/server';

export const appRouter = defineRouter({ /* app routes */ })
    .packages([authRouter, monitorRouter]);
```

```typescript
// src/server/server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { createMonitorErrorHandler, createMonitorLifecycle } from '@spfn/monitor/server';
import { configureMonitor } from '@spfn/monitor/config';
import { appRouter } from './router';

configureMonitor({ minStatusCode: 500, logRetentionDays: 14 });

export default defineServerConfig()
    .middleware({
        onError: createMonitorErrorHandler({ environment: process.env.NODE_ENV }),
    })
    .routes(appRouter)
    .lifecycle(createMonitorLifecycle())
    .build();
```

```tsx
// app/admin/monitor/page.tsx — superadmin-gated route
import { MonitorDashboard } from '@spfn/monitor/nextjs/client';

export default function MonitorPage()
{
    return <MonitorDashboard />;
}
```

```typescript
// anywhere server-side: structured logging
import { monitor } from '@spfn/monitor/server';

await monitor.log({ level: 'info', message: 'job done', source: 'cron', metadata: { took: 120 } });
```

---

## Exports reference

```typescript
// '@spfn/monitor' (client-safe)
monitorApi
type MonitorRouter, MonitorStats, ErrorGroupStatus, LogLevel
ERROR_GROUP_STATUSES, LOG_LEVELS

// '@spfn/monitor/server'
monitorRouter
createMonitorErrorHandler, createMonitorLifecycle              // integration
trackError, updateErrorGroupStatus, generateFingerprint       // error tracking
writeLog, queryLogs, setLogStore, getLogStore, monitor        // logging
getMonitorStats                                               // stats
errorGroupsRepository, errorEventsRepository, logsRepository  // repositories
errorGroups, errorEvents, logs, monitorSchema                 // entities
ERROR_GROUP_STATUSES, LOG_LEVELS, monitorLogger
type ErrorTrackingContext, MonitorErrorHandlerOptions, MonitorLifecycleConfig,
     LogStore, WriteLogParams, MonitorStats, ErrorGroupFilters, LogFilters,
     ErrorGroup, NewErrorGroup, ErrorGroupStatus, ErrorEvent, NewErrorEvent,
     Log, NewLog, LogLevel

// '@spfn/monitor/config'
configureMonitor, getMonitorConfig
getSlackWebhookUrl, getErrorRetentionDays, getLogRetentionDays, getMinStatusCode
env, monitorEnvSchema
type MonitorConfig

// '@spfn/monitor/nextjs/client'
MonitorDashboard, StatsOverview, ErrorListView, ErrorDetailView, LogViewer
```

## Related

- [@spfn/core/route](../core/src/route/README.md) — `defineRouter`, `.packages()`, route DSL
- [@spfn/core/server](../core/src/server/README.md) — `defineServerConfig`, `onError` middleware
- [@spfn/core/env](../core/src/env/README.md) — env schema / registry used by `/config`
- [@spfn/notification](../notification/README.md) — `sendSlack`, `createErrorSlackNotifier`
- [@spfn/auth](../auth/README.md) — `authenticate`, `requireRole` guarding the admin routes
