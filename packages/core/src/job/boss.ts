/**
 * pg-boss Wrapper
 *
 * Manages pg-boss instance lifecycle
 */

import PgBoss from 'pg-boss';
import { logger } from '@spfn/core/logger';
import { MIN_GRACEFUL_WAIT, recordWorkers, stopInstance, stopWorkers } from './boss-workers';
import type { RunningJob } from './boss-workers';

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
 * @param options - pg-boss configuration options
 * @returns The pg-boss instance
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

    setBossConfig(options);

    const needsSSL = requiresSSLWithoutVerification(options.connectionString);

    const pgBossOptions: PgBoss.ConstructorOptions = {
        // pg 드라이버가 URL의 sslmode=require를 verify-full로 해석해서
        // ssl 옵션을 무시하므로, URL에서 sslmode를 빼고 ssl 객체만 전달
        connectionString: needsSSL
            ? stripSslModeFromUrl(options.connectionString)
            : options.connectionString,
        schema: options.schema ?? 'spfn_queue',
        maintenanceIntervalSeconds: options.maintenanceIntervalSeconds ?? 120,
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

    const boss = new PgBoss(pgBossOptions);
    recordWorkers(boss);

    // Event handlers
    boss.on('error', (error) =>
    {
        jobLogger.error('pg-boss error:', error);
    });

    await boss.start();

    setBossInstance(boss);

    jobLogger.info('pg-boss started successfully');

    return boss;
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
        jobLogger.error('Error stopping pg-boss:', error);
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
