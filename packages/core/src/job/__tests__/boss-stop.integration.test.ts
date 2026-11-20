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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';

import { getBoss, initBoss, stopBoss } from '../boss';
import { TEST_DATABASE_URL } from '../../db/__tests__/helpers/db-fixture';

const TEST_SCHEMA = 'spfn_boss_stop_test';
const QUEUE = 'boss-stop';

describe('pg-boss\'s stop() on the getBoss() instance', () =>
{
    let sql: Sql;

    beforeEach(async () =>
    {
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

function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}
