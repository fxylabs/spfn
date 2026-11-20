/**
 * The job queue during a graceful shutdown
 *
 * Fetching and sending stop at different times: the stopping instance stops
 * fetching first, so it starts no job it may have to fail, and keeps accepting
 * sends until everything that may still enqueue has drained. Every phase is
 * bounded by one deadline.
 *
 * Requires the local test services (./scripts/test-services.sh start). The
 * database is probed before the rows are collected: without it every row is
 * reported skipped, never passed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql as statement } from 'drizzle-orm';
import postgres from 'postgres';
import type { Sql } from 'postgres';

// The server reaches the database through the package entry point, so the
// transaction in T7 runs through that same module.
import { getTransaction, onAfterCommit, runInTransaction } from '@spfn/core/db';
import { closeDatabase } from '../../db';
import { TEST_DATABASE_URL } from '../../db/__tests__/helpers/db-fixture';
import { logger } from '@spfn/core/logger';
import { getBoss, stopBoss } from '../../job/boss';
import { runningJobs } from '../../job/boss-workers';
import { JOB_FAIL_TIME } from '../shutdown-budget';
import { job } from '../../job/job-builder';
import { defineJobRouter } from '../../job/job-router';
import { resetOrphanSweepState } from '../../job/register-jobs';
import { serverLogger } from '../logger';
import { getShutdownManager, resetShutdownManager } from '../shutdown-manager';
import { startServer } from '../start-server';
import type { ServerConfig } from '../types';

vi.mock('@hono/node-server', () => ({
    serve: vi.fn(() => ({
        close: (callback: (error?: Error) => void) => callback(),
        requestTimeout: 0,
        keepAliveTimeout: 0,
        headersTimeout: 0,
    })),
}));

const TEST_SCHEMA = 'spfn_shutdown_queue_test';

interface Latch
{
    promise: Promise<void>;
    release: () => void;
    released: () => boolean;
}

const available = await canReachDatabase();

describe.skipIf(!available)('the job queue during shutdown', () =>
{
    let sql: Sql;
    let latches: Latch[] = [];
    let logLines: { message: string; at: number }[] = [];
    let logWaiters: { fragment: string; resolve: (at: number) => void }[] = [];

    beforeAll(() =>
    {
        sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
    });

    afterAll(async () =>
    {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
        await sql.end();
    });

    beforeEach(() =>
    {
        // Core's required variable — the boot check stops a server without it.
        vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
        vi.stubEnv('DATABASE_URL', TEST_DATABASE_URL);
        recordLog('info');
        recordLog('warn');
    });

    afterEach(async () =>
    {
        latches.forEach((latch) => latch.release());
        latches = [];
        logLines = [];
        logWaiters = [];
        await stopBoss();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        resetOrphanSweepState();
        resetShutdownManager();
        await closeDatabase();
    });

    function recordLog(level: 'info' | 'warn'): void
    {
        const original = serverLogger[level].bind(serverLogger) as (...args: unknown[]) => void;

        vi.spyOn(serverLogger, level).mockImplementation((message: string, ...rest: unknown[]) =>
        {
            const at = Date.now();
            logLines.push({ message, at });
            logWaiters.filter((waiter) => message.includes(waiter.fragment)).forEach((waiter) => waiter.resolve(at));

            return original(message, ...rest);
        });
    }

    /** Resolves with the time the first server log line containing `fragment` was written. */
    function logged(fragment: string): Promise<number>
    {
        const line = logLines.find((entry) => entry.message.includes(fragment));

        return line
            ? Promise.resolve(line.at)
            : new Promise((resolve) => logWaiters.push({ fragment, resolve }));
    }

    function latch(): Latch
    {
        let release = () => undefined as void;
        let released = false;
        const promise = new Promise<void>((resolve) =>
        {
            release = () =>
            {
                released = true;
                resolve();
            };
        });
        const created = { promise, release: () => release(), released: () => released };
        latches.push(created);

        return created;
    }

    function startWith(jobs: Parameters<typeof defineJobRouter>[0], config: Partial<ServerConfig> = {})
    {
        return startServer({
            host: '127.0.0.1',
            port: 39995,
            infrastructure: { database: true, redis: false },
            database: { provider: { kind: 'test-provider', write: { execute: async () => undefined } as never, close: async () => undefined } },
            jobs: defineJobRouter(jobs),
            jobsConfig: { schema: TEST_SCHEMA },
            ...config,
        });
    }

    /**
     * The premise of a row whose job falls due during the drain: the drain the
     * row got outlasts the job's due time by three polling intervals. Read from
     * the budget the server logged; the row fails here when it does not hold.
     */
    async function expectDrainOutlasts(dueAt: number, pollingInterval: number): Promise<void>
    {
        const drainStartedAt = await logged('Phase 3:');
        const drainLine = logLines.find((entry) => entry.message.includes('Phase 3:'))!.message;
        const drainBudget = Number(/budget: (\d+)ms/.exec(drainLine)![1]);

        expect(drainStartedAt + drainBudget).toBeGreaterThanOrEqual(dueAt + 3 * pollingInterval);
        // The drain ended at its bound, not because the stopping instance started the job
        expect(logLines.map((entry) => entry.message)).toContain('Shutdown manager: drain timeout — abandoning operations');
    }

    /** Records core's job-queue log lines (`@spfn/core:job`), which the server spies do not see */
    function recordJobLog(): { message: string; at: number }[]
    {
        const lines: { message: string; at: number }[] = [];
        const loggerClass = Object.getPrototypeOf(logger);

        for (const level of ['info', 'warn'] as const)
        {
            const original = loggerClass[level];

            vi.spyOn(loggerClass, level).mockImplementation(function (this: unknown, ...args: unknown[])
            {
                lines.push({ message: String(args[0]), at: Date.now() });

                return original.apply(this, args);
            });
        }

        return lines;
    }

    /**
     * Holds the instance's next fetch for `queue` until `release` resolves,
     * then lets it run its SQL — the fetch a slow pool or a cold queue cache
     * keeps in flight
     */
    function gateFetch(queue: string, release: Promise<unknown>): { held: Promise<void>; settledAt: () => number | null }
    {
        const boss = getBoss()!;
        const fetch = boss.fetch.bind(boss) as (name: string, options?: object) => Promise<unknown>;
        const held = latch();
        let settledAt: number | null = null;

        (boss as any).fetch = async (name: string, options?: object) =>
        {
            if (name !== queue || held.released())
            {
                return fetch(name, options);
            }

            held.release();
            await release;

            return fetch(name, options).finally(() =>
            {
                settledAt = Date.now();
            });
        };

        return { held: held.promise, settledAt: () => settledAt };
    }

    async function jobState(id: string | null): Promise<string>
    {
        const rows = await sql.unsafe(`SELECT state FROM ${TEST_SCHEMA}.job WHERE id = $1`, [id as string]);

        return rows[0]?.state;
    }

    it('T1: a tracked operation that enqueues after the drain started leaves its job in the queue', async () =>
    {
        // Polls once when it starts, then idles. Phase 2 waits for that poll if it is still in
        // flight, so no fetch is left that could take the job sent from Phase 3 on.
        const sendMail = job('shutdown-t1-mail')
            .options({ pollingIntervalSeconds: 3600 })
            .handler(async () =>
            {});
        const instance = await startWith({ sendMail });

        const enqueued = getShutdownManager().trackOperation(
            'mail-after-commit',
            logged('Phase 3:').then(() => sendMail.send()),
        );
        enqueued.catch(() => undefined);

        await instance.close();

        const jobId = await enqueued;
        expect(await jobState(jobId)).toBe('created');
    });

    it('T2: a job due during the drain is not started by the stopping instance and stays created', async () =>
    {
        const started = latch();
        const handlerRelease = latch();
        const report = job('shutdown-t2-report')
            .options({ pollingIntervalSeconds: 1, retryLimit: 0 })
            .handler(async () =>
            {
                started.release();
                await handlerRelease.promise;
            });
        const instance = await startWith({ report }, { shutdown: { timeout: 14000 } });
        const jobId = await report.send({ startAfter: 2 });
        const dueAt = Date.now() + 2000;

        // The drain runs to its bound, or ends early if the stopping instance starts the job.
        getShutdownManager().trackOperation('slow-request', started.promise).catch(() => undefined);

        await instance.close();

        await expectDrainOutlasts(dueAt, 1000);
        expect(started.released()).toBe(false);
        expect(await jobState(jobId)).toBe('created');
    });

    it('T3: a handler running at shutdown start finishes inside its bound and its job completes', async () =>
    {
        const started = latch();
        const sync = job('shutdown-t3-sync')
            .options({ pollingIntervalSeconds: 1 })
            .handler(async () =>
            {
                started.release();
                await logged('Phase 3:');
            });
        const instance = await startWith({ sync }, { shutdown: { timeout: 12000 } });
        const jobId = await sync.send();
        await started.promise;

        await instance.close();

        expect(await jobState(jobId)).toBe('completed');
    });

    it('T4: with every phase at its bound the database close still starts before the deadline with its reserve', async () =>
    {
        const timeout = 10000;
        // The rule for the database's reserve with the job queue and the database on
        const databaseReserve = Math.floor(Math.min(5000, 0.3 * timeout * 5000 / (2000 + 5000)));
        const started = latch();
        const never = latch();
        const slow = job('shutdown-t4-slow')
            .options({ pollingIntervalSeconds: 1 })
            .handler(async () =>
            {
                started.release();
                await never.promise;
            });
        const instance = await startWith({ slow }, {
            shutdown: { timeout },
            lifecycle: { beforeShutdown: () => never.promise },
        });
        getShutdownManager().onShutdown('slow-hook', () => never.promise, { timeout: 60000 });
        await slow.send();
        await started.promise;
        getShutdownManager().trackOperation('slow-drain', never.promise).catch(() => undefined);

        await instance.close();

        const shutdownStartedAt = await logged('Shutdown started');
        const databaseCloseAt = await logged('Phase 6: Closing database');
        const databaseLine = logLines.find((entry) => entry.message.includes('Phase 6: Closing database'));
        // At least its reserve: what the job queue's stop did not use flows forward to it
        expect(Number(/budget: (\d+)ms/.exec(databaseLine!.message)![1])).toBeGreaterThanOrEqual(databaseReserve);
        expect(databaseCloseAt + databaseReserve).toBeLessThanOrEqual(shutdownStartedAt + timeout);
    });

    it('T5: a worker the app started with getBoss().work() stops fetching, and work() after shutdown began starts nothing', async () =>
    {
        const noop = job('shutdown-t5-noop').options({ pollingIntervalSeconds: 3600 }).handler(async () =>
        {});
        const instance = await startWith({ noop }, { shutdown: { timeout: 14000 } });
        const boss = getBoss()!;
        await boss.createQueue('shutdown-t5-tenant');
        await boss.createQueue('shutdown-t5-late');

        const started = latch();
        const lateStarted = latch();
        await boss.work('shutdown-t5-tenant', { pollingIntervalSeconds: 1 }, async () => started.release());
        const jobId = await boss.send('shutdown-t5-tenant', {}, { startAfter: 2 });
        const dueAt = Date.now() + 2000;
        const lateJobId = await boss.send('shutdown-t5-late', {});

        // Shutdown has begun: this worker must not start, and the late job must not be fetched.
        const lateWork = logged('Phase 3:').then(() => boss.work(
            'shutdown-t5-late',
            { pollingIntervalSeconds: 1 },
            async () => lateStarted.release(),
        ));
        lateWork.catch(() => undefined);

        // The drain runs to its bound, or ends early if the stopping instance starts the job.
        getShutdownManager().trackOperation('slow-request', started.promise).catch(() => undefined);

        await instance.close();

        await expectDrainOutlasts(dueAt, 1000);
        await expect(lateWork).rejects.toThrow(/stopped fetching for a shutdown/);
        expect(started.released()).toBe(false);
        expect(lateStarted.released()).toBe(false);
        expect(await jobState(jobId)).toBe('created');
        expect(await jobState(lateJobId)).toBe('created');
    });

    it('T6: a drain that reaches its bound leaves onShutdown hooks and beforeShutdown time to run', async () =>
    {
        const ran: string[] = [];
        const never = latch();
        const noop = job('shutdown-t6-noop').options({ pollingIntervalSeconds: 1 }).handler(async () =>
        {});
        const instance = await startWith({ noop }, {
            shutdown: { timeout: 10000 },
            lifecycle: { beforeShutdown: async () => void ran.push('beforeShutdown') },
        });
        getShutdownManager().onShutdown('flush-buffer', async () => void ran.push('onShutdown'), { timeout: 1000 });
        getShutdownManager().trackOperation('long-task', never.promise).catch(() => undefined);

        await instance.close();

        expect(ran).toEqual(['onShutdown', 'beforeShutdown']);
    });

    it('T7: an after-commit send from a transaction that commits during the drain is in the queue, with no hook', async () =>
    {
        const sendMail = job('shutdown-t7-mail').options({ pollingIntervalSeconds: 3600 }).handler(async () =>
        {});
        // The real database, so the transaction runs through core's runner.
        const instance = await startWith({ sendMail }, { database: undefined, shutdown: { timeout: 12000 } });
        let jobId: string | null = null;

        // The request finishes at its commit; its after-commit send outlasts it
        // by three drain polls.
        getShutdownManager().trackOperation('request', logged('Phase 3:').then(() => runInTransaction(async () =>
        {
            await getTransaction()!.execute(statement`SELECT 1`);
            onAfterCommit(async () =>
            {
                await sleep(1500);
                jobId = await sendMail.send();
            });
        }))).catch(() => undefined);

        await instance.close();

        expect(jobId).not.toBeNull();
        expect(await jobState(jobId)).toBe('created');
    });

    it('T8: with a short shutdown.timeout, a handler still running has its job failed before close() resolves — retry, not active', async () =>
    {
        const started = latch();
        const never = latch();
        const slow = job('shutdown-t8-slow').options({ pollingIntervalSeconds: 1, retryLimit: 2 })
            .handler(async () =>
            {
                started.release();
                await never.promise;
            });
        const instance = await startWith({ slow }, { shutdown: { timeout: 3000 } });
        const jobId = await slow.send();
        await started.promise;

        await instance.close();

        // Finished inside Phase 5, not left to finish in the background: on a
        // signal, process.exit follows close() at once.
        expect(logLines.map((line) => line.message)).toContain('pg-boss stop done');
        expect(await jobState(jobId)).toBe('retry');
    });

    it('T8b: a jobs budget below pg-boss\'s minimum wait fails the running job at once, inside the time held for it', async () =>
    {
        const started = latch();
        const never = latch();
        const slow = job('shutdown-t8b-slow').options({ pollingIntervalSeconds: 1, retryLimit: 2 })
            .handler(async () =>
            {
                started.release();
                await never.promise;
            });
        const instance = await startWith({ slow });
        const jobId = await slow.send();
        await started.promise;

        const stopStartedAt = Date.now();
        await stopBoss(JOB_FAIL_TIME - 1);
        const stopTook = Date.now() - stopStartedAt;
        await instance.close();

        console.info(`[shutdown-job-queue] T8b: stopping pg-boss without a wait took ${stopTook}ms`);
        expect(await jobState(jobId)).toBe('retry');
        expect(stopTook).toBeLessThan(JOB_FAIL_TIME);
    });

    it('T9: a server started after a completed close() is not shutting down, and its own close() waits for its after-commit callback', async () =>
    {
        const noop = job('shutdown-t9-noop').options({ pollingIntervalSeconds: 3600 }).handler(async () =>
        {});
        const first = await startWith({ noop }, { database: undefined, shutdown: { timeout: 14000 } });
        await first.close();
        expect(getShutdownManager().isShuttingDown()).toBe(false);

        const second = await startWith({ noop }, { database: undefined, shutdown: { timeout: 14000 } });
        expect(getShutdownManager().isShuttingDown()).toBe(false);

        let callbackFinished = false;
        await runInTransaction(async () =>
        {
            await getTransaction()!.execute(statement`SELECT 1`);
            onAfterCommit(async () =>
            {
                await sleep(1500);
                callbackFinished = true;
            });
        });
        expect(getShutdownManager().getActiveOperationCount()).toBe(1);

        await second.close();

        expect(callbackFinished).toBe(true);
    });

    it('T9b: a server started after a shutdown that began but never completed starts running', async () =>
    {
        const noop = job('shutdown-t9b-noop').options({ pollingIntervalSeconds: 3600 }).handler(async () =>
        {});
        getShutdownManager().beginShutdown();

        const instance = await startWith({ noop }, { shutdown: { timeout: 14000 } });

        expect(getShutdownManager().isShuttingDown()).toBe(false);
        await instance.close();
    });

    it('T10: a job pg-boss failed at its expiration while the handler ran on is not reported as failed by the stop', async () =>
    {
        const started = latch();
        const never = latch();
        const hung = job('shutdown-t10-hung').options({ pollingIntervalSeconds: 1, retryLimit: 0, expireInSeconds: 1 })
            .handler(async () =>
            {
                started.release();
                await never.promise;
            });
        const instance = await startWith({ hung });
        const boss = getBoss()!;
        const jobId = await hung.send();
        await started.promise;
        const errors = vi.spyOn(Object.getPrototypeOf(logger), 'error');

        // Core's loop stops waiting for the handler at the job's expiration, pg-boss's bound, and fails the job
        await vi.waitFor(async () => expect(await jobState(jobId)).toBe('failed'), { timeout: 10000, interval: 200 });
        expect(runningJobs(boss)).toEqual([]);

        await instance.close();

        const reported = errors.mock.calls.filter(([message]) => String(message).includes('still running when pg-boss stopped'));
        expect(reported).toEqual([]);
    });

    it('T11: a fetch in flight when Phase 2 starts settles before fetching is called stopped, and takes no job sent from Phase 3 on', async () =>
    {
        const sendMail = job('shutdown-t11-mail').options({ pollingIntervalSeconds: 1 }).handler(async () =>
        {});
        const instance = await startWith({ sendMail }, { shutdown: { timeout: 14000 } });
        // Released only once close() is in Phase 2, so that the fetch is in flight there
        const gate = gateFetch('shutdown-t11-mail', logged('Phase 2:').then(() => sleep(100)));
        await gate.held;
        const jobLog = recordJobLog();

        const enqueued = getShutdownManager().trackOperation(
            'mail-after-commit',
            logged('Phase 3:').then(() => sendMail.send()),
        );
        enqueued.catch(() => undefined);

        await instance.close();

        const stoppedAt = jobLog.find((line) => line.message.includes('Stopped job fetch'))?.at;
        expect(gate.settledAt()).not.toBeNull();
        expect(stoppedAt).toBeGreaterThanOrEqual(gate.settledAt()!);
        expect(await jobState(await enqueued)).toBe('created');
    });

    it('T12: a fetch still in flight when Phase 2\'s budget ends is reported as in flight, not stopped, and the shutdown completes', async () =>
    {
        const sendMail = job('shutdown-t12-mail').options({ pollingIntervalSeconds: 1 }).handler(async () =>
        {});
        const instance = await startWith({ sendMail }, { shutdown: { timeout: 10000 } });
        const gate = gateFetch('shutdown-t12-mail', latch().promise);
        await gate.held;
        const jobLog = recordJobLog();

        await instance.close();

        const messages = jobLog.map((line) => line.message);
        expect(messages.some((message) => message.includes('Job fetch not stopped: 1 fetch(es) still in flight'))).toBe(true);
        expect(messages.some((message) => message.includes('Stopped job fetch'))).toBe(false);
        expect(logLines.map((line) => line.message)).toContain('Server shutdown completed');
    });
});

function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether the test database answers; decided before the rows are collected. */
async function canReachDatabase(): Promise<boolean>
{
    const probe = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 5, onnotice: () => undefined });

    try
    {
        await probe`SELECT 1`;

        return true;
    }
    catch
    {
        console.warn('[shutdown-job-queue] test postgres unavailable: every row is skipped');

        return false;
    }
    finally
    {
        await probe.end();
    }
}
