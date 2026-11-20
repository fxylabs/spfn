/**
 * pg-boss's own stop() on the instance getBoss() returns
 *
 * Core runs that instance's workers (boss-workers.ts), and pg-boss's stop()
 * acts only on the workers pg-boss runs. These rows pin that an app calling
 * `getBoss().stop()` itself gets pg-boss's stop for core's workers: it waits
 * for them, fails what still runs, stops their polling and refuses `work()`.
 *
 * Requires the local test services (./scripts/test-services.sh start).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';

import type PgBoss from 'pg-boss';

import { getBoss, initBoss, stopBoss } from '../boss';
import { TEST_DATABASE_URL } from '../../db/__tests__/helpers/db-fixture';

const TEST_SCHEMA = 'spfn_boss_stop_test';
const QUEUE = 'boss-stop';

describe('pg-boss\'s stop() on the getBoss() instance', () =>
{
    let sql: Sql;

    let timersBefore = 0;

    beforeEach(async () =>
    {
        timersBefore = timers();
        await initBoss({ connectionString: TEST_DATABASE_URL, schema: TEST_SCHEMA });
        await getBoss()!.createQueue(QUEUE, { retryLimit: 2 });
        sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
    });

    afterEach(async () =>
    {
        await stopBoss(0);
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
        await sql.end();
    });

    it('B1: a graceful stop({ timeout }) waits for a running handler, whose job completes before stop() resolves', async () =>
    {
        const boss = getBoss()!;
        const started = startedHandler(sleep(1500));
        await boss.work(QUEUE, { pollingIntervalSeconds: 0.5 }, started.handler);
        const id = await boss.send(QUEUE, {});
        await started.running;

        await boss.stop({ graceful: true, timeout: 5000 });

        expect(await jobState(id)).toBe('completed');
    }, 15000);

    it('B2: no worker fetches once stop() began', async () =>
    {
        const boss = getBoss()!;
        await boss.work(QUEUE, { pollingIntervalSeconds: 0.5 }, async () => undefined);
        const fetch = boss.fetch.bind(boss);
        let fetches = 0;
        let stopping = false;
        (boss as any).fetch = (...args: Parameters<typeof fetch>) =>
        {
            fetches += stopping ? 1 : 0;

            return fetch(...args);
        };

        stopping = true;
        await boss.stop({ graceful: true, timeout: 1000 });
        await sleep(1500);

        expect(fetches).toBe(0);
    }, 15000);

    it('B3: work() after stop() rejects as pg-boss\'s does, and starts a worker again after start()', async () =>
    {
        const boss = getBoss()!;
        await boss.stop({ graceful: false });

        await expect(boss.work(QUEUE, async () => undefined)).rejects.toThrow('Workers are disabled. pg-boss is stopped');

        await boss.start();
        await expect(boss.work(QUEUE, async () => undefined)).resolves.toEqual(expect.any(String));
    }, 15000);

    it('B4: a non-graceful stop() fails a running job, which goes to retry', async () =>
    {
        const boss = getBoss()!;
        const started = startedHandler(new Promise(() => undefined));
        await boss.work(QUEUE, { pollingIntervalSeconds: 0.5 }, started.handler);
        const id = await boss.send(QUEUE, {});
        await started.running;

        await boss.stop({ graceful: false });

        expect(await jobState(id)).toBe('retry');
    }, 15000);

    it('B5: a stop whose fail statement errors rejects with that error after pg-boss stopped; stop() then does nothing and start() starts again', async () =>
    {
        const boss = getBoss()!;
        let release = () => undefined as void;
        const started = startedHandler(new Promise<void>((resolve) => release = resolve));
        await boss.work(QUEUE, { pollingIntervalSeconds: 0.5 }, started.handler);
        await boss.send(QUEUE, {});
        await started.running;
        const restore = breakFailStatement(boss);

        await expect(boss.stop({ graceful: false })).rejects.toThrow('connection terminated (injected)');
        restore();
        release();

        await vi.waitFor(() => expect(timers()).toBeLessThanOrEqual(timersBefore), { timeout: 2000, interval: 50 });
        await expect(boss.stop({ graceful: false })).resolves.toBeUndefined();
        await boss.start();
        await expect(boss.work(QUEUE, async () => undefined)).resolves.toEqual(expect.any(String));
    }, 15000);

    it('B6: a stop() while one runs, or after it, does nothing — neither it nor the first rejects with a handler still running', async () =>
    {
        const boss = getBoss()!;
        const started = startedHandler(new Promise(() => undefined));
        await boss.work(QUEUE, { pollingIntervalSeconds: 0.5 }, started.handler);
        const id = await boss.send(QUEUE, {});
        await started.running;

        const first = boss.stop({ graceful: true, timeout: 1000 });
        await expect(boss.stop({ graceful: false })).resolves.toBeUndefined();
        await expect(first).resolves.toBeUndefined();
        await expect(boss.stop({ graceful: false })).resolves.toBeUndefined();

        expect(await jobState(id)).toBe('retry');
    }, 15000);

    async function jobState(id: string | null): Promise<string>
    {
        const rows = await sql.unsafe(`SELECT state FROM ${TEST_SCHEMA}.job WHERE id = $1`, [id as string]);

        return rows[0]?.state;
    }
});

/** A handler that runs until `done`, and a promise that resolves once it started */
function startedHandler(done: Promise<unknown>): { handler: () => Promise<void>; running: Promise<void> }
{
    let started = () => undefined as void;
    const running = new Promise<void>((resolve) => started = resolve);

    return {
        handler: async () =>
        {
            started();
            await done;
        },
        running,
    };
}

/** Make pg-boss's statement that fails jobs by id throw, as a dropped connection does; returns the undo */
function breakFailStatement(boss: PgBoss): () => void
{
    const db = boss.getDb() as any;
    const executeSql = db.executeSql;
    db.executeSql = async (text: string, values: unknown) =>
    {
        if (text.includes('deleted_jobs') && text.includes('UNNEST($2'))
        {
            throw new Error('connection terminated (injected)');
        }

        return executeSql.call(db, text, values);
    };

    return () =>
    {
        db.executeSql = executeSql;
    };
}

/** Timers alive in this process — pg-boss's intervals and the pool's among them */
function timers(): number
{
    return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}
