# @spfn/core/job — pg-boss background jobs

Type-safe background jobs on PostgreSQL (pg-boss): a fluent `job()` builder with typed
input/output, cron scheduling, run-once, event-driven triggers, batch processing, and
compensation — grouped in a `JobRouter` and registered through `defineServerConfig()`.

## Import paths

One entry point. `@spfn/core` depends on pg-boss pinned exactly (11.1.2), so the queue schema
version is the one this core release states.

```typescript
import {
    job, defineJobRouter,
    initBoss, getBoss, stopBoss, isBossRunning, registerJobs,
} from '@spfn/core/job';
import { defineEvent } from '@spfn/core/event';   // for .on(event) jobs
import { Type } from '@sinclair/typebox';         // for .input()/.output() schemas
```

In a normal SPFN app you do **not** call `initBoss` / `registerJobs` yourself — wiring a
`JobRouter` into `defineServerConfig().jobs(...)` does both at server start (see Quick Start).

---

## Public API (complete)

From `@spfn/core/job`:

- Builder: `job(name)` → `JobBuilder`
- Router: `defineJobRouter(jobs)`, `mergeJobRouters(base, extra)`, `collectJobs(router, prefix?)`,
  `isJobDef(v)`, `isJobRouter(v)`
- Queue policy: `resolveQueuePolicy(job)`
- pg-boss lifecycle: `initBoss(options)`, `getBoss()`, `stopFetching(fetchWait?)`,
  `stopBoss(handlerWait?)`, `isBossRunning()`, `shouldClearOnStart()` — `stopFetching(fetchWait =
  5000)` stops every worker started on the instance `getBoss()` returns (by `registerJobs()` or by
  the app's own `getBoss().work()`) and waits up to `fetchWait` for the fetches they have in
  flight, while `send()` keeps working; from then on `getBoss().work()` rejects. It logs `Stopped
  job fetch` only once no fetch is in flight — otherwise a warning that one still is, since a job
  it takes starts on this instance. `stopBoss(handlerWait = 30000)` waits that long for running
  handlers (with less than 1000ms, the minimum kept from pg-boss, it does not wait), fails the jobs
  of those still running — retried if attempts remain — then stops pg-boss. The server's graceful
  shutdown calls both — see the server README
- Workers on `getBoss()`: `work()`, `offWork()` and `notifyWorker()` on that instance run core's
  fetch loop, built on pg-boss's public `fetch` / `complete` / `fail` and keeping its worker's
  behaviour — `pollingIntervalSeconds` (default 2, at least 0.5), `batchSize`, `includeMetadata`,
  `priority`; one batch at a time per worker; the handler bounded by the batch's largest
  `expireInSeconds` (at least 1s); a single job completed with the handler's result, a batch
  without one; a throw (or a failed completion) fails the batch with the error's description —
  `describeError` from `@spfn/core/logger`, which keeps a database error's SQLSTATE, constraint,
  table, SQL text and `paramCount` and never its bound values, and an ordinary error's name,
  message, `code` and numeric `statusCode` and none of its other fields — which pg-boss stores as the job's
  `output` and retries per the job's retry options; a failed poll emitted as the
  instance's `error` event with `queue` and `worker`. `stop(options)` and `start()` on that instance
  are core's too, so pg-boss's lifecycle covers those workers: `stop()` is the path `stopBoss()`
  takes — with `graceful` (default) it waits up to `timeout` (default 30000, at least 1000) for a
  fetch in flight and the running handlers, then fails the jobs of handlers still running (`"pg-boss
  shut down while active"`), then runs pg-boss's stop with `close`; with `graceful: false` it fails
  them at once; `wait: false` resolves at once. No worker fetches once `stop()` began, `work()`
  after it rejects with pg-boss's `Workers are disabled. pg-boss is stopped`, and `start()` lets it
  start workers again; the `stopped` event is pg-boss's own. Unlike pg-boss's stop, cron and queue
  supervision end after the wait, not before it. What it drops: those workers do not appear in
  pg-boss's `wip` events (`getWipData()` is not on the 11.1.2 instance). A `PgBoss` the app
  constructs itself keeps pg-boss's own workers, which a shutdown neither stops nor fails
- Registration: `registerJobs(router)` — **takes a `JobRouter`, not an array**
- Queue schema (see [Queue schema facts](#queue-schema-facts)): `QUEUE_SCHEMA_VERSION`,
  `queueInstallSql(schema)`, `queueMigrationSql(schema, from)`, `isQueueSchemaRace(error, plan)`, `QueueSchemaVersionError`,
  `QueueSchemaNameError`, `readQueueSchemaState(db, schema)`, `QueueSchemaChangedError`, type
  `QueueSchemaState`
- Boot rule (see [Who installs the queue schema](#who-installs-the-queue-schema--the-boot-rule)):
  `queueStart(state, role, declared)`, `ownsQueue(state)`, type `QueueStart`, `JobQueueSchemaError`
  (its `step`, type `QueueSchemaStep`)
- Types: `JobDef`, `JobRouter`, `JobRouterEntry`, `JobOptions`, `JobQueuePolicy`,
  `JobSendOptions`, `JobHandler`, `CompensateHandler`, `InferJobInput`, `InferJobOutput`,
  `BossOptions`, `BossConfig` (deprecated alias of `BossOptions`)

`JobBuilder` methods: `.input(schema)`, `.output(schema)`, `.on(event)`, `.cron(expr)`,
`.runOnce()`, `.options(opts)`, `.timeout(ms)`, `.compensate(fn)`, `.handler(fn)`.

`JobDef` methods (returned by `.handler()`): `.send(input?, opts?)`,
`.sendBatch(inputs?, opts?)`, `.run(input?)`.

### Removed API — do not use

The old `core/docs/job.md` documents an API that **no longer exists**. None of these are
exported; using them will not compile:

| Removed | Use instead |
|---------|-------------|
| `defineJob({ name, handler })` | `job(name).input(...).handler(...)` builder |
| `enqueue(jobDef, payload, opts)` | `jobDef.send(input, opts)` |
| `schedule(name, cron, fn)` | `job(name).cron(expr).handler(fn)` |
| `registerJobs([jobA, jobB])` (array) | `registerJobs(defineJobRouter({ jobA, jobB }))` |
| `concurrency`, `attempts`, `backoff`, `delay`, `priority: 'high'` options | `batchSize`, `retryLimit`, `retryDelay`, `startAfter`, numeric `priority` |

`registerJobs` exists but its signature changed: it accepts a **`JobRouter`**, not an array
of jobs.

---

## Quick Start

### 1. Define jobs

```typescript
// src/server/jobs/send-email.job.ts
import { job } from '@spfn/core/job';
import { Type } from '@sinclair/typebox';

export const sendEmailJob = job('send-email')
    .input(Type.Object({
        to: Type.String(),
        subject: Type.String(),
        body: Type.String(),
    }))
    .options({ retryLimit: 3 })
    .handler(async (input) =>
    {
        await emailService.send(input.to, input.subject, input.body);
    });
```

### 2. Group into a router

```typescript
// src/server/jobs/index.ts
import { defineJobRouter } from '@spfn/core/job';
import { sendEmailJob } from './send-email.job';

export const jobRouter = defineJobRouter({ sendEmailJob });
```

### 3. Register with the server (does initBoss + registerJobs)

```typescript
// server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { appRouter } from './routes';
import { jobRouter } from './jobs';

export default defineServerConfig()
    .routes(appRouter)
    .jobs(jobRouter)   // connectionString comes from env.DATABASE_URL automatically
    .build();
```

### 4. Trigger jobs

```typescript
await sendEmailJob.send({ to: 'user@example.com', subject: 'Welcome', body: 'Hi!' });
await sendEmailJob.run({ to: 'test@example.com', subject: 'Test', body: 'x' }); // sync, for tests
```

---

## Job types

`job(name)` starts a builder. The terminal `.handler(fn)` finalizes and returns a `JobDef`.
The builder kind is selected by which modifier you chain — they are not mutually exclusive in
type, but a job should be *one* of these:

### Standard — triggered via `.send()`

```typescript
const typedJob = job('typed')
    .input(Type.Object({ userId: Type.String(), action: Type.String() }))
    .handler(async (input) =>
    {
        // input: { userId: string; action: string }
        await processAction(input.userId, input.action);
    });

const noInput = job('simple').handler(async () => { await db.cleanup(); });
```

A `Type.Union([...])` input is supported: `send`, `run`, `sendBatch` and the handler are
typed on the whole union, so each member is accepted and a non-member is rejected — no cast
and no per-member overload.

### Cron — scheduled

```typescript
const dailyReport = job('daily-report')
    .cron('0 9 * * *')      // every day 09:00
    .handler(async () => { await reportService.generateDaily(); });
```

| Cron | Meaning |
|------|---------|
| `*/5 * * * *` | every 5 minutes |
| `0 * * * *` | every hour |
| `0 9 * * *` | every day 09:00 |
| `0 0 * * 0` | every Sunday 00:00 |
| `0 0 1 * *` | first day of month |

Cron jobs take **no input** — pg-boss invokes the handler with `{}`.

Removing a cron job from the router leaves its schedule behind in the DB; the opt-in
[orphan schedule sweep](#orphan-schedule-sweep) unschedules it on the next boot.

### RunOnce — once per server start

```typescript
const initCache = job('init-cache')
    .runOnce()
    .handler(async () => { await cache.warmup(); });
```

Enqueued with `singletonKey: 'runOnce:<name>'` on an `exclusive` queue, so concurrent
instances don't double-run it.

`exclusive` deduplicates against the `created`, `retry` and `active` states, so a boot while
the previous run is still queued or running is dropped. Once that run *completes*, the next
boot enqueues it again — the guarantee is **once per server start**, not once ever. For
once-ever semantics, keep a marker of your own in the database and return early.

### Event-driven — `.on(event)`

Subscribe to an event; the input type is **inferred from the event payload**. Emitting the
event enqueues the job (decoupled — one event can drive many jobs).

```typescript
import { defineEvent } from '@spfn/core/event';

export const userCreated = defineEvent('user.created', Type.Object({
    userId: Type.String(),
    email: Type.String(),
}));

export const sendWelcome = job('send-welcome')
    .on(userCreated)        // input typed as { userId: string; email: string }
    .handler(async (payload) => { await emailService.sendWelcome(payload.email); });

await userCreated.emit({ userId: '123', email: 'user@example.com' }); // triggers sendWelcome
```

`.on()` consumes the event's queue (`event:<name>`), not `<job.name>`. You do **not** call
`.send()` on an event-driven job — emit the event instead.

---

## Job options (`.options()`)

```typescript
job('important-task')
    .input(Type.Object({ id: Type.String() }))
    .options({
        retryLimit: 5,          // max retries        (default 3)
        retryDelay: 5000,       // ms between retries  (default 1000)
        expireInSeconds: 600,   // handler timeout     (default 300)
        priority: 10,           // higher = first      (default 0)
        singletonKey: 'unique', // dedupe key — see Queue policy below
        policy: 'exclusive',    // what singletonKey dedupes (default: see below)
        retentionSeconds: 86400,// keep completed jobs (default 604800 = 7d)
        batchSize: 1,           // jobs per worker poll(default 1)
    })
    .handler(async (input) => { await processImportant(input.id); });
```

`.timeout(ms)` is sugar for `expireInSeconds` (`Math.ceil(ms / 1000)`):

```typescript
job('quick').timeout(10000).handler(async () => { /* ... */ }); // expireInSeconds: 10
```

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `retryLimit` | number | 3 | max retry attempts |
| `retryDelay` | number | 1000 | ms between retries |
| `expireInSeconds` | number | 300 | handler timeout (seconds) |
| `priority` | number | 0 | higher = processed first |
| `singletonKey` | string | — | dedup key; effect depends on [`policy`](#queue-policy-and-deduplication) |
| `policy` | `JobQueuePolicy` | see below | [what `singletonKey` deduplicates](#queue-policy-and-deduplication) |
| `retentionSeconds` | number | 604800 | completed-job retention |
| `batchSize` | number | 1 | jobs fetched per worker poll; `> 1` ⇒ parallel |

### Queue policy and deduplication

`singletonKey` on its own deduplicates nothing. pg-boss puts a unique index on
`(queue name, COALESCE(singleton_key, ''))` only for non-`standard` queues; on a `standard`
queue the insert's `ON CONFLICT DO NOTHING` never conflicts, so the key is stored and
ignored. The policy is a property of the **queue**, set from the job definition at
registration.

| policy | one job per `(queue, singletonKey)` among states… |
|---|---|
| `standard` | none — the key is ignored |
| `short` | `created` (queued, not yet picked up) |
| `singleton` | `active` (running) — many may queue, one runs at a time |
| `stately` | one per state among `created`, `retry`, `active` |
| `exclusive` | `created` + `retry` + `active` together — a second enqueue while one is pending or running is dropped |

**Default rule:** an explicit `.options({ policy })` always wins; otherwise a job that is
`.runOnce()` or sets `options.singletonKey` gets `exclusive`; everything else stays
`standard`. Plain jobs must stay `standard` — `exclusive` with no key deduplicates on
`COALESCE(singleton_key, '')` and would collapse the whole queue to one pending job.

**Deduplication is scoped by queue name.** The queue name is part of every index, so two
different queues never deduplicate against each other even with the same key. Event-driven
jobs dedupe on their `event:<name>` queue, not on `<job.name>`.

**Event-driven jobs share `event:<name>`**, so the policy resolved from one subscriber
applies to every subscriber of that event, and `emit()` carries no `singletonKey` — a
non-standard policy there deduplicates on the empty key, i.e. one un-started job per event
queue. Give `.on(event)` jobs an explicit `policy: 'standard'` unless collapsing pending
emits is exactly what you want, and don't put `options.singletonKey` on one.

**A send-time `singletonKey` needs a policy on the definition.** `.send(input, {
singletonKey })` cannot change the queue's policy. On a `standard` queue the send is
accepted and the key silently does nothing; the first such send logs

```
[Job:<name>] singletonKey ignored: queue policy is "standard"; set .options({ policy: 'exclusive' }) (or another non-standard policy) to deduplicate
```

once per job name. Put `policy` on `.options()` to make the key take effect.

```typescript
const reindex = job('reindex')
    .options({ policy: 'exclusive' })       // now send-time keys deduplicate
    .handler(async () => { await search.reindex(); });
```

#### Upgrading

Queues created by earlier versions of this package exist as `standard`, and pg-boss
`create_queue` is `INSERT … ON CONFLICT DO NOTHING` — an existing queue keeps its policy and
`updateQueue` cannot change one. Registration therefore compares the wanted policy against
`getQueue()` and, on a mismatch, logs an error naming the queue, both policies and the
remedy; boot continues with a queue that does not deduplicate. The remedy is to
`getBoss().deleteQueue('<name>')` in a quiet window — **it drops that queue's job rows** —
and restart. In development, `clearOnStart` recreates the queue with the new policy
automatically.

---

## Sending jobs

### `.send(input?, options?)` → `Promise<string | null>`

Enqueue one job (returns the pg-boss job id, or `null` if deduped). Jobs with no input
schema take only the options arg.

```typescript
await sendEmailJob.send({ to: 'u@x.com', subject: 'Hi', body: '...' });

await sendEmailJob.send(
    { to: 'u@x.com', subject: 'Hi', body: '...' },
    {
        startAfter: 60,                       // delay seconds — or a Date
        priority: 10,                         // override default priority
        singletonKey: 'welcome-u@x.com',      // dedupe this invocation
    },
);
```

`JobSendOptions`: `startAfter?: number | Date`, `priority?: number`, `singletonKey?: string`.
Send-time options override the job's defaults.

### `.sendBatch(inputs?, options?)` → `Promise<void>`

Bulk-insert via `pg-boss.insert()` — a single query, far faster than a `.send()` loop.

```typescript
await sendEmailJob.sendBatch(
    users.map(u => ({ to: u.email, subject: 'Welcome', body: render(u) })),
);
```

Combine with `batchSize` for distributed parallel processing: each worker fetches `batchSize`
jobs and runs them with `Promise.allSettled`; failed jobs are individually marked
(`boss.fail`) and retried — the whole batch does not fail together. pg-boss advisory locks
prevent duplicate processing across instances.

### `.run(input?)` → `Promise<TOutput>`

Invoke the handler **synchronously, bypassing pg-boss** — for unit tests / debugging only.
No queue, no retries, no boss required.

```typescript
await sendEmailJob.run({ to: 't@x.com', subject: 'Test', body: 'x' });
```

---

## Compensation & output (workflow/saga)

`.output(schema)` types the handler's return; `.compensate(fn)` defines rollback. These are
hooks for workflow/saga orchestration — they do not run automatically on plain `.send()`.

```typescript
export const chargePayment = job('charge-payment')
    .input(Type.Object({ orderId: Type.String(), amount: Type.Number() }))
    .output(Type.Object({ chargeId: Type.String() }))
    .compensate(async (input, output) =>
    {
        await paymentService.refund(input.orderId, input.amount); // rollback
    })
    .handler(async (input) =>
    {
        return await paymentService.charge(input.orderId, input.amount);
    });
```

---

## Job router

`defineJobRouter` groups jobs (flat, nested, or mixed). `collectJobs` flattens nested
routers — nested keys become dotted names (`email.sendWelcome`).

```typescript
// flat
export const jobRouter = defineJobRouter({ sendWelcome, dailyReport, initCache });

// nested + mixed
export const jobRouter = defineJobRouter({
    initCache,                                       // flat
    email: defineJobRouter({                         // nested → 'email.sendWelcome', ...
        sendWelcome,
        sendReset,
    }),
});
```

`mergeJobRouters(base, extra)` combines two routers into a new one (neither input is
mutated) and throws when a top-level key exists in both. `.jobs()` uses it — you rarely call
it directly.

---

## Server wiring

`defineServerConfig().jobs(router, config?)` at server start: reads `env.DATABASE_URL`, calls
`initBoss({ connectionString: DATABASE_URL, ...config })`, then `registerJobs(router)`.

**`.jobs()` may be called once per domain router.** Repeated calls **merge**, the way
`.routes()` composes — they do not replace one another:

```typescript
export default defineServerConfig()
    .routes(appRouter)
    .jobs(emailJobRouter, { clearOnStart: isDev })   // pg-boss config on one call only
    .jobs(billingJobRouter)
    .jobs(reportingJobRouter)
    .build();
```

Two collisions are possible and both fail loudly:

- a **router key** present in two calls throws at config time
  (`jobs(): key "x" is already registered by an earlier .jobs() call`);
- two jobs sharing a **`job.name`** — the pg-boss queue name — throw in `registerJobs()` at
  boot, before any queue or worker is created;
- passing the pg-boss `config` on more than one call throws too; there is one boss per server.

```typescript
export default defineServerConfig()
    .routes(appRouter)
    .jobs(jobRouter, {
        schema: 'spfn_queue',                          // default 'spfn_queue'
        clearOnStart: process.env.NODE_ENV === 'development',
    })
    .build();
```

The second arg is `Omit<BossOptions, 'connectionString'>` — **do not pass
`connectionString`** here; it is taken from `env.DATABASE_URL`. If `DATABASE_URL` is unset,
server start throws `"Jobs require database connection."`. Before pg-boss starts, `initBoss`
applies [the boot rule](#who-installs-the-queue-schema--the-boot-rule): it may refuse the queue
schema with a `JobQueueSchemaError`, and there is no option to make it install or migrate the
queue as a role that does not own it.

### `BossOptions` (for manual `initBoss`)

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `connectionString` | string | (required) | PostgreSQL URL (auto-supplied by `.jobs()`) |
| `schema` | string | `'spfn_queue'` | pg-boss tables live here |
| `maintenanceIntervalSeconds` | number | 120 | cleanup/archive interval |
| `monitorIntervalSeconds` | number | — | state-change events; must be `>= 1` |
| `clearOnStart` | boolean | false | delete pending jobs on boot (dev only) |
| `sweepOrphanSchedules` | boolean | false | unschedule crons no longer declared on any registered router (see below) |

### Orphan schedule sweep

`boss.schedule` rows persist in the DB, so removing a cron job from the router leaves its
schedule behind — pg-boss keeps creating jobs on every cron tick with no worker to consume
them, and they pile up forever. With `sweepOrphanSchedules: true`, `registerJobs` runs a
sweep once after registration: any schedule whose name is not a cron job declared on a
router registered in this process is unscheduled. Queues and existing job rows are never
deleted — the sweep only stops the pile-up. Cron names accumulate across `registerJobs`
calls, so registering several routers is safe. When no cron job has been declared at all,
the sweep is skipped. Failures only log an error; startup is never blocked.

Leave the sweep disabled (the default) when any of these apply, because the sweep only
knows the routers registered in this process and would unschedule everything else:

- multiple apps share the same pg-boss schema,
- schedules are created directly via `getBoss().schedule(...)`,
- rolling deploys can boot an older router version while a newer one is live.

`sslmode=require`/`prefer` in the URL is rewritten to `ssl: { rejectUnauthorized: false }`
so self-signed certs work.

### Who installs the queue schema — the boot rule

pg-boss keeps its queue in a schema of its own (`spfn_queue` unless `.jobs(…, { schema })` names
another), with tables, an enum and two functions, at a schema version its release fixes (26 for
11.1.2). Where the database has two roles (the `@spfn/core` db README, "Database roles"), the
**owner** installs and migrates it — `spfn db push`, `db migrate` and `db grant`, run with
`DATABASE_OWNER_URL` — and grants the app role what the queue needs, in the same run (the CLI
README, [The queue schema](../../../cli/README.md#the-queue-schema-jobs)). The schema and every
object in it then belong to the owner; the app role holds only `USAGE` and row access. Those
commands cannot load server.config, so they find the schema in the app's `package.json`:

```json
{ "spfn": { "jobs": true } }
```

`"jobs": true` is the schema `spfn_queue`; `"jobs": { "schema": "app_queue" }` names another —
the one `.jobs(…, { schema })` uses. Without the declaration the commands read, run and print
nothing of the queue. With one role, as under `spfn dev` with one URL, nothing changes: the app
installs and migrates the queue itself, as before.

Before pg-boss starts, `initBoss` reads the queue schema as the role the server connects as and
decides how pg-boss starts on it — the app role changes the queue's structure only where it owns
the schema and every object in it, or where nothing is installed and it may create it:

| The queue schema, read as the app role | pg-boss starts | |
|---|---|---|
| at pg-boss's schema version (26 for pg-boss 11.1.2) | `migrate: false` | no structure statement at all |
| newer than pg-boss's — a rollback, or an older instance in a rolling deploy | with a warning, unmigrated | pg-boss migrates only up, so it sends no structure statement; its own `migrate: false` check would refuse any other version |
| older than the oldest version pg-boss migrates from (25 for 11.1.2), whoever owns it | **refused** (`QueueSchemaVersionError`) | pg-boss would apply its oldest migration to a schema it was not written for |
| older, and the app role owns the schema and every object in it | migrating it as the app role | one role, or an app that installed the queue itself |
| older, and one role other than the app role owns all of it | **refused** | the owner migrates it, connecting as that role |
| nothing installed, the app role may `CREATE` on the database, and no other role owns the schema | installing it as the app role, which then owns it | one role |
| nothing installed, otherwise, and no role or one role other than the app role owns all of it | **refused** | the owner installs it |
| pg-boss's, but its version unreadable to the app role (no `USAGE` on the schema or no `SELECT` on `version`), and one role other than the app role owns all of it | **refused** | the owner grants it, connecting as that role |
| any of those three, ownership split — the app role owning part of the queue (the schema, objects in it, or an empty schema it may not install into), or two roles or more other than the app role owning parts | **refused** | no command resolves it: the owner step installs, migrates and grants only a queue the owner holds whole, and prints the ownership transfer; the boot names that transfer, and every role that owns part of the queue |
| holding objects that are not pg-boss's (a project's table, a view named `version`) | **refused** | pg-boss is installed beside nothing |

"Owns" means what PostgreSQL checks before it lets a role alter, replace or drop an object: the app
role is the owner of the schema and of every object in it, or a member that inherits the owner's
privileges (`pg_has_role(owner, 'USAGE')`) — so an app role that inherits the owner role migrates
the queue as itself, and the objects that migration creates are the app role's.

A refusal is a `JobQueueSchemaError` (`schema`, `installed` — the version, `null` when nothing is
installed, absent when not read — `required`, and `step`: the owner's step that resolves it, `owner`
or `grant`, `null` where no command does) thrown before the server listens, logged as
`Refusing to start: …` and then `Server initialization failed`. Its text names the remedy.
`spfn db status` reports the same answer. It follows one rule: a refusal the next owner command
resolves is work to do, as pending migrations are, and exits 0; one no command resolves exits 1
(`step` `null`):

| Queue state | `step` | `spfn db status` (human) |
|---|---|---|
| not installed, older than pg-boss's, no role or one role other than the app role owning all of it | `owner` | exit 0, as pending migrations: `spfn db migrate` resolves it |
| its version unreadable to the app role, one other role owning all of it | `grant` | exit 0: `spfn db grant` — and `spfn db migrate`, whose grant step is the same — resolves it |
| either, ownership split (the app role owning part of the queue, or two other roles or more owning parts) | `null` | exit 1: the owner commands change nothing there until the ownership transfer has run |
| holding objects that are not pg-boss's, older than pg-boss migrates from | `null` | exit 1 |


| Refusal | Remedy |
|---|---|
| `Queue schema spfn_queue is at pg-boss schema version 25; pg-boss 11.1.2 in this build needs 26, and role app_user does not own the schema and every object in it, so the app does not migrate it.` | `Run spfn db migrate (or spfn db push) with DATABASE_OWNER_URL connecting as app_owner, which owns the schema and every object in it, or as a role that inherits app_owner, then start again; if that command reports the queue as another role's, its transfer lines say what to move.` — the role is the one that owns the queue, which the app role sees; which role `DATABASE_OWNER_URL` connects as it cannot. With no schema yet: `Run spfn db migrate (or spfn db push) with DATABASE_OWNER_URL set, then start again.` |
| `Queue schema spfn_queue is not installed, and role app_user may not create schemas in the database` (or `does not own it`)`, so the app does not install it.` | the same |
| `Queue schema spfn_queue is pg-boss's, but role app_user may not read its version: …` | `Run spfn db grant with DATABASE_OWNER_URL connecting as app_owner, …` |
| any of those three, ownership split | `Nor do the owner's commands: app_user, app_owner own the schema or objects in it (app_user being role app_user or a role it inherits), and pg-boss installs and migrates the queue only as the one role that owns the schema and every object in it. Make that the role DATABASE_OWNER_URL connects as (<owner> below), then start again:` — every role that owns part of the queue named — and the transfer the owner step prints for the same state (`queueOwnershipTransfer` in `@spfn/core/db`): `REASSIGN OWNED BY app_user, app_owner TO <owner>;` (for what the bootstrap superuser owns, one `ALTER … OWNER TO <owner>;` per object), then `spfn db grant` |
| `Queue schema spfn_queue is at pg-boss schema version 24; pg-boss 11.1.2 needs 26: it migrates from version 25 on.` | `Migrate it to version 25 first, with the pg-boss release that runs on that schema version.` — `queueMigrationSql` gives the owner step the same answer |
| `Queue schema spfn_queue holds objects that are not pg-boss's, …` | give the queue a schema of its own in `.jobs()` and in `package.json` |

A name pg-boss's SQL cannot carry (`isQueueSchemaName`) throws `QueueSchemaNameError` there too.

**pg-boss starts in two steps.** Its structure step — its install, its migration, or, at its
version, its check of the version — runs first, on a pg-boss instance of its own that supervises
and schedules nothing, which is stopped before the running instance starts on the schema as that
step left it. pg-boss's `stop()` does nothing on an instance whose `start()` failed, and a failed
start of an instance that supervises or schedules can leave its timers running; this one's start
opens its pool, runs the step, then starts its manager, which cannot fail — so where it fails, its
pool is all it opened, and that is closed.

**The schema can change between the read and pg-boss's start** — the owner step migrating it, a
rollback — and pg-boss offers no hook to make the two one step. When the structure step then
fails, `initBoss` reads the queue schema again: where the rule's answer for it differs from the one
acted on, it acts on the new one, once — refuses with `JobQueueSchemaError`, or runs the step the
way the new state calls for; where it is the same, pg-boss's error is rethrown unchanged. A
failure of the running instance's start is pg-boss's error, never read as a changed schema, and
no other instance starts after it: the server's initialization fails. That includes a schema
another node moves on to a newer version between the structure step and the running instance's
start: that instance is started with `migrate` only where the schema read was newer, so it fails
loudly with pg-boss's own "requires migrations" error, and the next boot reads the new state. So between the read and
the structure step an app that does not own the queue can still *send* pg-boss's migration;
PostgreSQL refuses it (only an object's owner may change it), the transaction rolls back and
nothing changes, and the boot ends with the refusal for the state that now holds.

**The declaration is compared with `.jobs()`.** `initBoss` reads `spfn.jobs` from the
`package.json` of the directory the server runs in and compares the schema it declares with the
one pg-boss is started on. A mismatch — no declaration (no `package.json` counts as none), another
schema, or a declaration that cannot be read — matters only where the owner step has to act on the
queue: a refusal then ends with how to declare it, and a start on a queue the app role does not own
(`current` or `newer` on an owner-installed queue) logs one warning (`Queue schema spfn_queue:
package.json declares no jobs, so spfn db migrate, push and grant do not install, migrate or grant
it as the owner. Declare "spfn": { "jobs": { "schema": "spfn_queue" } } in package.json.`). An app
that installs or owns its queue — every one-role app — logs nothing about it: the comparison
decides nothing by itself.

**What a two-role app no longer needs:** `CREATE` on the database. Once the owner installed the
queue, revoke it (`REVOKE CREATE ON DATABASE acme FROM app_user;`): with it, an app that boots on a
database where the queue schema is gone installs — and owns — it again. `spfn db status` says so.

**A queue the app role installed** (every two-role deployment before this release) keeps working:
the app owns it, so it still migrates it at boot. The owner step reports it and does not touch it;
moving it to the owner is described in the `@spfn/core` db README. One whose schema and objects
have different owners — the app role's schema holding the owner's objects, or the reverse — no
role can migrate: once it is older, the boot refuses it with the transfer the owner step prints.
An owner role that is a member of both — one that inherits the app role — can run the owner step
(`spfn db migrate`) instead of the transfer: PostgreSQL then counts the whole queue as its own.

**Partitioned queues are not supported under the role split.** `getBoss().createQueue(name, {
partition: true })` creates a table and attaches it to `job`, which only the owner of `job` may do,
so as the app role it fails with PostgreSQL's permission error. Core's own queues are never
partitioned. With one role it works as before.

**What the running server reports.** The detailed health payload carries the queue schema as boot
read it: `queue: { schema, installed, required, start, checkedAt }`, `start` one of `install`,
`migrate`, `current`, `newer` (see the server README, "Health check").

`queueStart(state, role, declared)` is the rule itself, a pure function of a `QueueSchemaState`:
it returns `{ kind: 'install' | 'migrate' | 'current' | 'newer' }`, or `{ kind: 'refused', error }`
with the `JobQueueSchemaError`; `declared: false` adds the declaration sentence to a refusal.
`spfn db status` reports the same answer.

### Queue schema facts

What a tool needs to know about pg-boss's schema without starting pg-boss. `initBoss` reads the
state (`readQueueSchemaState`) for the boot rule above; the owner step uses the SQL.

- `QUEUE_SCHEMA_VERSION` — the schema version the pinned pg-boss creates and runs on, read from
  its `version.json` (26 for 11.1.2).
- `queueInstallSql(schema)` — pg-boss's construction plan (`getConstructionPlans`): one
  multi-statement string, `BEGIN; …; COMMIT;` under pg-boss's advisory lock, starting with
  `CREATE SCHEMA IF NOT EXISTS`. Run it whole in one simple-protocol call (node-postgres
  `query(text)` without parameters).
- `queueMigrationSql(schema, from)` — pg-boss's migration plan from version `from`
  (`getMigrationPlans`). A `from` that is not older than `QUEUE_SCHEMA_VERSION`, or older than the
  first version pg-boss migrates from (25 for 11.1.2), throws `QueueSchemaVersionError` naming both
  versions — pg-boss itself would return a plan written for another version — and, below that
  first version, the one to migrate to first with an earlier pg-boss release. It is a
  `JobQueueSchemaError`: the boot refuses such a queue with the same answer.
- `isQueueSchemaRace(error, 'install' | 'migration')` — whether running one of those plans
  failed the way pg-boss's own start treats as a lost race and ignores: `already exists` on the
  install, `division by zero` on the migration — the messages read from the pinned pg-boss. Each
  plan takes pg-boss's advisory lock, so a second runner waits and then finds the work done; roll
  its transaction back, read the version again and judge from that.
- Both, and `readQueueSchemaState`, throw `QueueSchemaNameError` on a schema name pg-boss's
  unquoted SQL breaks on, or that it and the catalog would read differently (`isQueueSchemaName`
  in `@spfn/core/db`): upper case, a PostgreSQL keyword other than an unreserved one, `pg_…` —
  the reader before it reads the catalog, which would answer about another schema, or call
  absent a schema pg-boss cannot be installed in.
- `readQueueSchemaState(db, schema)` — on any drizzle connection, what the catalog says to the
  connected role: whether the schema `exists`, whether the role `ownsSchema` (is or inherits its
  owner) and `ownsObjects` (is or inherits the owner of every object in it; true for none),
  `ownedBy` (the roles through which it owns the schema or objects in it — itself, or a role it
  inherits — quoted; empty where it owns nothing there), `owners` (every role that owns the schema
  or an object in it, quoted, the schema's owner first; empty with no schema), `bootstrapOwned`
  (what of it the bootstrap superuser owns, as `ALTER … OWNER TO` names it), has
  `usage` on it, and `mayCreateOnDatabase`; `notPgBoss`, whether the schema is known
  not to be pg-boss's, so pg-boss may be neither installed nor migrated there; and `version`, the
  installed schema version. A schema is pg-boss's when it holds every table and type pg-boss's
  construction plan creates and no migration of its does, and nothing that plan or a migration
  does not create — a function by its name and argument types — names read from the pinned pg-boss's own SQL (`getConstructionPlans`, its
  migration store), so a pg-boss bump brings its objects along — besides the partitions pg-boss
  attaches to `job` for a partitioned queue. Anything else holding objects is not pg-boss's: some
  of its tables, a project's own `version` table, a project table beside a pg-boss install, a view
  named `version`; so is a pg-boss schema whose `version` table, where the role may read it, does
  not hold exactly one integer. `version` is `null` when nothing is
  installed and pg-boss may be: no schema, or one holding no object at all (default privileges
  set on it are no object) — absent when the schema is not pg-boss's or the role may not read it (no `USAGE` on the schema,
  or no `SELECT` on `version`), never anything but an integer. The state is the one a single
  statement saw, under one snapshot, on whatever connection it is given (a pool's statements are
  no transaction): an install, a migration or a replacement another connection commits meanwhile
  reads as before it or after it, never half of each. PostgreSQL refuses a SELECT on
  `<schema>.version` where the role may not read it — 42501 even on pg-boss's own check,
  `to_regclass('<schema>.version')`, in a schema without `USAGE` — so the catalog is read first,
  and only where it shows a pg-boss schema whose `version` the role may read does a second
  statement read the catalog again together with the version; that one's state is returned. The
  schema or its `version` table dropped or replaced, or the role's privilege revoked, between
  the two throws `QueueSchemaChangedError` — read again for the schema as it is now; so does a
  schema renamed and another created under its name inside the second statement, between
  PostgreSQL resolving the table and taking its snapshot.

---

## Pitfalls & anti-patterns

- **`registerJobs` takes a `JobRouter`, not an array.** `registerJobs([a, b])` is the removed
  API. Use `registerJobs(defineJobRouter({ a, b }))` — or just `.jobs(router)`, which is the
  normal path and also runs `initBoss`.
- **Don't grant the app role `CREATE` on the database to make jobs start.** With two roles, declare
  `"spfn": { "jobs": true }` and let `spfn db migrate`/`push` install the queue as the owner — see
  [the boot rule](#who-installs-the-queue-schema--the-boot-rule).
- **Don't call `initBoss` / `registerJobs` yourself in an SPFN app.** `defineServerConfig().jobs()`
  does both. Calling `initBoss` twice logs `"pg-boss already initialized"` and returns the
  existing instance (the second config is ignored).
- **`.send()` before the boss is up throws** `"pg-boss not initialized"`. Only call `.send()`
  after the server has started (e.g. inside route/job handlers), never at module top-level.
- **Don't pass `connectionString` to `.jobs()`.** Its config is `Omit<BossOptions,
  'connectionString'>`; the connection comes from `env.DATABASE_URL`. (Old docs showing
  `.jobs(router, { connectionString })` are wrong.)
- **Event-driven jobs are triggered by `emit()`, not `.send()`.** `.on(event)` binds the job
  to the `event:<name>` queue; emitting the event enqueues it. Calling `.send()` on such a job
  targets the wrong queue.
- **`.run()` is not `.send()`.** `.run()` executes the handler inline with no queue, retries,
  or timeout — tests/debugging only. Production dispatch is `.send()` / `.sendBatch()`.
- **Cron and runOnce jobs take no input.** They are invoked with `{}`. Don't give them
  `.input()` and expect data.
- **Job names must be unique across the (flattened) router.** Two jobs sharing a `name` map to
  the same pg-boss queue and collide. Nested router keys are namespaced into the *router* path
  but the pg-boss queue is `job.name` — keep `name` strings unique. `registerJobs()` throws on
  a duplicate name at boot, quoting both router keys.
- **`singletonKey` does nothing on a `standard` queue.** Set `policy` on the definition — see
  [Queue policy and deduplication](#queue-policy-and-deduplication).
- **`clearOnStart: true` deletes pending/scheduled jobs on boot.** Development only — it wipes
  queued work (and the subscribed event queues) every restart.
- **`expireInSeconds` is a handler timeout, not a delay.** A handler exceeding it is treated as
  failed and retried (up to `retryLimit`). Make handlers idempotent.
- **`batchSize > 1` runs jobs concurrently.** Handlers must be safe to run in parallel;
  failures are isolated per job, not per batch.

---

## Complete example

```typescript
// src/server/jobs/index.ts
import { job, defineJobRouter } from '@spfn/core/job';
import { defineEvent } from '@spfn/core/event';
import { Type } from '@sinclair/typebox';

// event-driven
export const userCreated = defineEvent('user.created', Type.Object({
    userId: Type.String(),
    email: Type.String(),
}));

export const sendWelcome = job('send-welcome')
    .on(userCreated)
    .options({ retryLimit: 3, retryDelay: 5000 })
    .handler(async (p) => { await emailService.sendWelcome(p.email); });

// standard + idempotent
export const processOrder = job('process-order')
    .input(Type.Object({ orderId: Type.String() }))
    .options({ retryLimit: 3 })
    .handler(async (input) =>
    {
        const order = await orderRepo.findById(input.orderId);
        if (order.status === 'processed') return;     // idempotent guard
        await processOrderLogic(order);
    });

// batch
export const sendBulkEmail = job('send-bulk-email')
    .input(Type.Object({ to: Type.String(), subject: Type.String(), html: Type.String() }))
    .options({ retryLimit: 3, batchSize: 50 })
    .handler(async (input) => { await emailProvider.send(input); });

// cron
export const dailyReport = job('daily-report')
    .cron('0 9 * * *')
    .handler(async () => { await reportService.generateDaily(); });

// runOnce
export const initCache = job('init-cache')
    .runOnce()
    .handler(async () => { await cache.warmup(); });

export const jobRouter = defineJobRouter({
    sendWelcome, processOrder, sendBulkEmail, dailyReport, initCache,
});
```

```typescript
// server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { appRouter } from './routes';
import { jobRouter } from './jobs';

export default defineServerConfig()
    .routes(appRouter)
    .jobs(jobRouter, { clearOnStart: process.env.NODE_ENV === 'development' })
    .build();
```

```typescript
// dispatch (inside a handler, after server start)
await processOrder.send({ orderId: 'o-1' });
await sendBulkEmail.sendBatch(users.map(u => ({ to: u.email, subject: 'Hi', html: render(u) })));
await userCreated.emit({ userId: '123', email: 'u@x.com' }); // → sendWelcome
```

```typescript
// test
import { processOrder } from './jobs';

it('processes an order', async () =>
{
    await processOrder.run({ orderId: 'o-1' });   // sync, no pg-boss
    expect(orderRepo.findById).toHaveBeenCalled();
});
```

---

## Types reference

```typescript
import type {
    JobDef, JobRouter, JobRouterEntry,
    JobOptions, JobQueuePolicy, JobSendOptions, JobHandler, CompensateHandler,
    InferJobInput, InferJobOutput, BossOptions,
} from '@spfn/core/job';

type SendInput = InferJobInput<typeof processOrder>;   // { orderId: string }
type ChargeOut = InferJobOutput<typeof chargePayment>; // { chargeId: string }

// JobHandler<TInput, TOutput> = TInput extends void
//     ? () => Promise<TOutput>
//     : (input: TInput) => Promise<TOutput>;
// CompensateHandler<TInput, TOutput> = (input: TInput, output: TOutput) => Promise<void>;
```

## Related

- [@spfn/core/event](../event/README.md) — events drive `.on(event)` jobs; emit triggers them
- [@spfn/core/server](../server/README.md) — `defineServerConfig().jobs()` wiring
- [@spfn/core/env](../env/README.md) — `DATABASE_URL` powers the job connection
- [pg-boss](https://github.com/timgit/pg-boss) — underlying queue engine
