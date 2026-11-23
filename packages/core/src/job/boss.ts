/**
 * pg-boss Wrapper
 *
 * Manages pg-boss instance lifecycle
 */

import PgBoss from 'pg-boss';
import { DEFAULT_QUEUE_SCHEMA } from '@spfn/core/db';
import { logger } from '@spfn/core/logger';
import { MIN_GRACEFUL_WAIT, recordWorkers, stopInstance, stopWorkers } from './boss-workers';
import type { RunningJob } from './boss-workers';
import { decideQueueStart, type QueueStart } from './queue-start';

const jobLogger = logger.child('@spfn/core:job');

/**
 * Check if connection string uses SSL without certificate verification
 *
 * pg library verifies certificates by default even with sslmode=require.
 * For require/prefer modes (no explicit verification), we disable cert checking
 * to support self-signed certificates.
 */
function requiresSSLWithoutVerification(connectionString: string): boolean
{
    try
    {
        const url = new URL(connectionString);
        const sslmode = url.searchParams.get('sslmode');

        return sslmode === 'require' || sslmode === 'prefer';
    }
    catch
    {
        return false;
    }
}

/**
 * Remove sslmode parameter from connection string URL
 *
 * pg driver interprets sslmode=require as verify-full, which overrides
 * the ssl option object. Stripping it lets us control SSL via the ssl option only.
 */
function stripSslModeFromUrl(connectionString: string): string
{
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');

    return url.toString();
}

/**
 * globalThis keys for cross-module-cache singleton (ESM/CJS share same instance)
 */
const BOSS_KEY = Symbol.for('spfn:boss-instance');
const CONFIG_KEY = Symbol.for('spfn:boss-config');

const g = globalThis as any;

function getBossInstance(): PgBoss | null
{
    return g[BOSS_KEY] ?? null;
}

function setBossInstance(instance: PgBoss | null): void
{
    g[BOSS_KEY] = instance;
}

function getBossConfig(): BossConfig | null
{
    return g[CONFIG_KEY] ?? null;
}

function setBossConfig(config: BossConfig | null): void
{
    g[CONFIG_KEY] = config;
}

/**
 * Options for pg-boss initialization
 *
 * @example
 * ```typescript
 * await initBoss({
 *     connectionString: process.env.DATABASE_URL,
 *     schema: 'spfn_queue',
 *     clearOnStart: process.env.NODE_ENV === 'development',
 * });
 * ```
 */
export interface BossOptions
{
    /**
     * PostgreSQL connection string
     *
     * @example 'postgresql://user:password@localhost:5432/mydb'
     */
    connectionString: string;

    /**
     * Schema name for pg-boss tables
     *
     * pg-boss creates its own tables in this schema.
     *
     * @default 'spfn_queue'
     */
    schema?: string;

    /**
     * Maintenance interval in seconds
     *
     * pg-boss runs maintenance tasks (cleanup, archiving) at this interval.
     *
     * @default 120
     */
    maintenanceIntervalSeconds?: number;

    /**
     * Monitor state changes interval in seconds
     *
     * When set, pg-boss emits state change events at this interval.
     *
     * @default undefined (disabled)
     */
    monitorIntervalSeconds?: number;

    /**
     * Clear all pending/scheduled jobs on startup
     *
     * Useful for development mode to start with a clean queue.
     * Should be false in production.
     *
     * @default false
     */
    clearOnStart?: boolean;

    /**
     * Unschedule cron schedules that are no longer declared on any registered
     * job router, once at startup after job registration. Queues and job rows
     * are never deleted — only the schedule row is removed.
     *
     * Leave disabled when multiple apps share the same pg-boss schema, when
     * schedules are created directly via getBoss(), or during rolling deploys
     * that mix router versions — the sweep only knows the routers registered
     * in this process and would unschedule everything else.
     *
     * @default false
     */
    sweepOrphanSchedules?: boolean;
}

/**
 * @deprecated Use BossOptions instead
 */
export type BossConfig = BossOptions;

/**
 * Initialize pg-boss with the given configuration
 *
 * Must be called before registerJobs(). Typically handled by defineServerConfig().
 *
 * Before pg-boss starts, the queue schema is read as the connected role and
 * the boot rule (queue-start.ts) decides whether pg-boss may install or
 * migrate it as that role (`migrate: true`), starts on it as it is
 * (`migrate: false`), or does not start: the app role changes the queue's
 * structure only where it owns the schema and every object in it or, with
 * nothing installed, may create it. pg-boss's structure step — its install,
 * migration or version check — runs first, on an instance of its own that
 * starts nothing else (`settleQueueSchema`), and the running instance starts
 * after it, on the schema as that step left it. The schema can change between
 * the read and pg-boss's first statement: when the structure step then fails,
 * its instance is stopped and the schema read again, and an answer that
 * differs is acted on once; an unchanged one rethrows pg-boss's error.
 *
 * @param options - pg-boss configuration options
 * @returns The pg-boss instance
 * @throws JobQueueSchemaError when the boot rule refuses the queue schema:
 *     not installed, older than pg-boss's or unreadable to a role that may
 *     not change it, or not pg-boss's
 * @throws QueueSchemaNameError when `schema` is no queue schema name
 *
 * @example
 * ```typescript
 * const boss = await initBoss({
 *     connectionString: process.env.DATABASE_URL!,
 *     schema: 'spfn_queue',
 * });
 * ```
 */
export async function initBoss(options: BossOptions): Promise<PgBoss>
{
    const existing = getBossInstance();
    if (existing)
    {
        jobLogger.warn('pg-boss already initialized, returning existing instance');

        return existing;
    }

    jobLogger.info('Initializing pg-boss...');

    const read = startable(await decideQueueStart(options.connectionString, options.schema));

    setBossConfig(options);

    const start = await settleQueueSchema(options, read).catch((error: unknown) => settleChangedQueue(options, read, error));
    const boss = await startBoss(options, start);

    setBossInstance(boss);

    jobLogger.info('pg-boss started successfully');

    return boss;
}

type StartableQueue = Exclude<QueueStart, { kind: 'refused' }>;

/** `start`, unless the boot rule refused the queue schema: then its `JobQueueSchemaError` is thrown. */
function startable(start: QueueStart): StartableQueue
{
    if (start.kind === 'refused')
    {
        throw start.error;
    }

    return start;
}

/**
 * pg-boss's structure step failed on the queue schema the boot rule answered
 * `acted` for, and its instance is stopped. The schema may have changed
 * between that read and pg-boss's first statement — pg-boss offers no hook to
 * make them one step — so it is read again: where the rule now answers
 * otherwise, that answer is acted on, once — refused, or the step run the way
 * it says. Otherwise `error` is pg-boss's own and is rethrown unchanged, as it
 * is where the schema cannot be read again.
 */
async function settleChangedQueue(options: BossOptions, acted: StartableQueue, error: unknown): Promise<StartableQueue>
{
    const now = await decideQueueStart(options.connectionString, options.schema).catch((rereadError: unknown) =>
    {
        jobLogger.warn('pg-boss failed to start, and the queue schema could not be read again', { error: rereadError });

        return acted;
    });

    if (now.kind === acted.kind)
    {
        throw error;
    }

    jobLogger.warn(`pg-boss failed to start on the queue schema as read (${acted.kind}); read again, it is ${now.kind}: acting on that`, { error });

    return settleQueueSchema(options, startable(now));
}

/**
 * pg-boss's structure step on the queue schema as `start` says — its install
 * or migration, or its version check — on an instance that supervises and
 * schedules nothing, so that it may be stopped whatever happens: pg-boss's
 * `stop()` does nothing on an instance whose `start()` failed, and a failed
 * start of an instance that supervises or schedules can leave its timers
 * running. Its start opens its pool, runs the step, and then starts its
 * manager, which cannot fail; so a failed start has opened its pool alone,
 * which is closed, and a started one is stopped. Resolves `start`.
 */
async function settleQueueSchema(options: BossOptions, start: StartableQueue): Promise<StartableQueue>
{
    const boss = new PgBoss({ ...pgBossOptions(options, start), supervise: false, schedule: false });

    boss.on('error', (error) =>
    {
        jobLogger.error('pg-boss error:', { error });
    });

    await boss.start().catch((error: unknown) => closePool(boss).then(() => Promise.reject(error)));
    await boss.stop({ graceful: false });

    return start;
}

/** Close the pool of `boss`, whose `start()` failed: the pool pg-boss opened for it, the only thing that start leaves. */
async function closePool(boss: PgBoss): Promise<void>
{
    await (boss.getDb() as PgBoss.Db & { close(): Promise<void> }).close();
}

/**
 * The running pg-boss instance, on a queue schema its structure step has
 * settled (`settleQueueSchema`): unmigrated (`migrate: false`) unless the
 * schema is newer than pg-boss's, where only `migrate: true` lets pg-boss
 * start, and sends nothing.
 */
async function startBoss(options: BossOptions, start: StartableQueue): Promise<PgBoss>
{
    const boss = new PgBoss({ ...pgBossOptions(options, start), migrate: start.kind === 'newer' });
    recordWorkers(boss);

    boss.on('error', (error) =>
    {
        jobLogger.error('pg-boss error:', { error });
    });

    await boss.start();

    return boss;
}

function pgBossOptions(options: BossOptions, start: StartableQueue): PgBoss.ConstructorOptions
{
    const needsSSL = requiresSSLWithoutVerification(options.connectionString);

    const pgBossOptions: PgBoss.ConstructorOptions = {
        // pg 드라이버가 URL의 sslmode=require를 verify-full로 해석해서
        // ssl 옵션을 무시하므로, URL에서 sslmode를 빼고 ssl 객체만 전달
        connectionString: needsSSL
            ? stripSslModeFromUrl(options.connectionString)
            : options.connectionString,
        schema: options.schema ?? DEFAULT_QUEUE_SCHEMA,
        maintenanceIntervalSeconds: options.maintenanceIntervalSeconds ?? 120,
        migrate: start.kind !== 'current',
    };

    if (needsSSL)
    {
        pgBossOptions.ssl = { rejectUnauthorized: false };
    }

    // Only set monitorIntervalSeconds if explicitly provided (must be >= 1)
    if (options.monitorIntervalSeconds !== undefined && options.monitorIntervalSeconds >= 1)
    {
        pgBossOptions.monitorIntervalSeconds = options.monitorIntervalSeconds;
    }

    return pgBossOptions;
}

/**
 * Get the current pg-boss instance
 *
 * Workers started on it with `work()` — here or by registerJobs() — run on
 * core's fetch loop, so `stopFetching()` stops them all and knows when their
 * last fetch settled. Once `stopFetching()` ran, `work()` on it rejects: the
 * instance is shutting down. Its own `stop(options)` is the path `stopBoss()`
 * takes, so it waits for, fails and stops those workers as pg-boss's stop does
 * its own.
 */
export function getBoss(): PgBoss | null
{
    return getBossInstance();
}

/**
 * How long `stopFetching()` waits for in-flight fetches when not given a wait
 */
const DEFAULT_FETCH_WAIT = 5000;

/**
 * Stop fetching: every worker started on the current instance stops polling,
 * and the fetches they have in flight settle
 *
 * The first step of a graceful shutdown. Every worker started on the instance
 * `getBoss()` returns counts — by registerJobs() or by the app's own
 * `getBoss().work(...)` — and from here until the instance is stopped a
 * `work()` call on it rejects instead of starting a worker.
 *
 * A fetch already in flight is waited for, up to `fetchWait` ms: the jobs it
 * takes start here, and once it settled the instance takes no other job — a
 * job not yet fetched stays `created` for another instance. If the wait ends
 * with a fetch unsettled, the log says so: a job it takes still starts on
 * this instance. Handlers are not waited for: one already running continues
 * and its job completes or fails as usual. Sending stays open — `send()` and
 * event publishes keep working until `stopBoss()`; so does pg-boss's own
 * timekeeping, whose cron ticks only insert job rows for a running instance
 * to fetch.
 */
export async function stopFetching(fetchWait = DEFAULT_FETCH_WAIT): Promise<void>
{
    const boss = getBossInstance();
    if (!boss)
    {
        return;
    }

    const { stopped, inFlight } = await stopWorkers(boss, fetchWait);

    if (inFlight > 0)
    {
        jobLogger.warn(
            `Job fetch not stopped: ${inFlight} fetch(es) still in flight after ${fetchWait}ms — ` +
            'a job such a fetch takes starts on this instance; sending stays open',
        );

        return;
    }

    jobLogger.info(`Stopped job fetch: ${stopped} worker(s), no fetch in flight; sending stays open`);
}

/**
 * The shortest handler wait a stop does — a wait below it is no wait. Kept
 * from pg-boss's graceful stop, which the shutdown budget was built on.
 */
export const BOSS_MIN_HANDLER_WAIT = MIN_GRACEFUL_WAIT;

/**
 * Stop pg-boss: wait for running job handlers, fail what still runs, then stop
 *
 * With `handlerWait` of at least 1000, core waits up to that long for the
 * handlers its workers run, and for a fetch still in flight; with less, it
 * does not wait at all. Either way, a handler still running then has its job
 * failed ("pg-boss shut down while active") before the pool closes: a job
 * with attempts left goes to `retry` and runs again on a live instance after
 * its retry delay; a job on its last attempt ends `failed`. Sending stops here.
 *
 * This is the instance's own `stop({ graceful, timeout })` with `graceful`
 * set by whether `handlerWait` reaches 1000 — the same code path, so an app
 * that calls `getBoss().stop()` itself gets the same wait and failures.
 *
 * Only this instance's state is cleared: if a newer instance was initialised
 * while this one was stopping, `getBoss()` keeps returning the newer one.
 */
export async function stopBoss(handlerWait = 30000): Promise<void>
{
    const boss = getBossInstance();
    if (!boss)
    {
        return;
    }

    const wait = handlerWait >= BOSS_MIN_HANDLER_WAIT ? handlerWait : 0;

    jobLogger.info(wait > 0
        ? `Stopping pg-boss (running handlers get ${wait}ms)...`
        : 'Stopping pg-boss without waiting for running handlers...');

    try
    {
        logJobsFailedAtStop(await stopInstance(boss, { graceful: wait > 0, timeout: wait }));
        jobLogger.info('pg-boss stopped');
    }
    catch (error)
    {
        jobLogger.error('Error stopping pg-boss:', { error });
        throw error;
    }
    finally
    {
        if (getBossInstance() === boss)
        {
            setBossInstance(null);
            setBossConfig(null);
        }
    }
}

/**
 * A handler still running once the wait ended has had its job failed
 */
function logJobsFailedAtStop(cut: RunningJob[]): void
{
    if (cut.length === 0)
    {
        return;
    }

    jobLogger.error(
        `${cut.length} job handler(s) were still running when pg-boss stopped; their jobs were failed ` +
        '("pg-boss shut down while active") — retried on a live instance if attempts remain, left failed ' +
        'on the last attempt',
        { jobs: cut },
    );
}

/**
 * Check if pg-boss is initialized and running
 */
export function isBossRunning(): boolean
{
    return getBossInstance() !== null;
}

/**
 * Check if jobs should be cleared on start
 */
export function shouldClearOnStart(): boolean
{
    return getBossConfig()?.clearOnStart ?? false;
}

/**
 * Check if orphan cron schedules should be swept after registration
 */
export function shouldSweepOrphanSchedules(): boolean
{
    return getBossConfig()?.sweepOrphanSchedules ?? false;
}
