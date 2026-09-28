/**
 * Retry Delay Integration Tests
 *
 * `JobOptions.retryDelay` is in milliseconds and pg-boss reads `retryDelay` in
 * seconds. Before the conversion a job declaring `retryDelay: 5000` retried
 * 5000 seconds (83 minutes) after a failure. These tests read what pg-boss
 * stored and when it scheduled the retry, so a unit mismatch cannot hide
 * behind a mocked boss.
 *
 * Requires the local test services (./scripts/test-services.sh start).
 * Tests self-skip with a warning if the fixture cannot connect.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { job } from '../job-builder';
import { defineJobRouter } from '../job-router';
import { registerJobs, resetOrphanSweepState } from '../register-jobs';
import { resolveQueuePolicy } from '../queue-policy';
import { getBoss, initBoss, stopBoss } from '../boss';
import { TEST_DATABASE_URL } from '../../db/__tests__/helpers/db-fixture';

const TEST_SCHEMA = 'spfn_retry_delay_test';

interface RetryRow
{
    state: string;
    retry_delay: number;
    retry_backoff: boolean;
    retry_limit: number;
    retry_in_seconds: number | null;
}

describe('Retry delay (Integration)', () =>
{
    let available = false;
    let sql: Sql;

    async function rowsOf(name: string): Promise<RetryRow[]>
    {
        return await sql.unsafe(
            `SELECT state, retry_delay, retry_backoff, retry_limit,
                    extract(epoch FROM start_after - now())::float AS retry_in_seconds
             FROM ${TEST_SCHEMA}.job WHERE name = $1`,
            [name],
        ) as unknown as RetryRow[];
    }

    async function createQueueFor(definition: Parameters<typeof resolveQueuePolicy>[0], name: string): Promise<void>
    {
        await getBoss()!.createQueue(name, { policy: resolveQueuePolicy(definition) });
    }

    beforeAll(async () =>
    {
        try
        {
            await initBoss({ connectionString: TEST_DATABASE_URL, schema: TEST_SCHEMA });
            sql = (await import('postgres')).default(TEST_DATABASE_URL);
            available = true;
        }
        catch
        {
            console.warn('[retry-delay] test postgres unavailable, skipping');
        }
    });

    afterAll(async () =>
    {
        resetOrphanSweepState();

        if (!available)
        {
            return;
        }

        await stopBoss();
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
        await sql.end();
    });

    it('send stores retryDelay in seconds', async () =>
    {
        if (!available) return;

        const receipt = job('retry-send')
            .options({ retryLimit: 4, retryDelay: 5000, retryBackoff: false })
            .handler(async () =>
            {});

        await createQueueFor(receipt, 'retry-send');
        await receipt.send();

        expect(await rowsOf('retry-send')).toMatchObject([
            { retry_delay: 5, retry_backoff: false, retry_limit: 4 },
        ]);
    }, 60000);

    it('sendBatch stores retryDelay in seconds', async () =>
    {
        if (!available) return;

        const bulk = job('retry-batch')
            .options({ retryDelay: 5000 })
            .handler(async () =>
            {});

        await createQueueFor(bulk, 'retry-batch');
        await bulk.sendBatch();

        expect(await rowsOf('retry-batch')).toMatchObject([{ retry_delay: 5 }]);
    }, 60000);

    it('send without options applies the documented defaults (1s, 3 retries, backoff)', async () =>
    {
        if (!available) return;

        const plain = job('retry-defaults')
            .handler(async () =>
            {});

        await createQueueFor(plain, 'retry-defaults');
        await plain.send();

        expect(await rowsOf('retry-defaults')).toMatchObject([
            { retry_delay: 1, retry_backoff: true, retry_limit: 3 },
        ]);
    }, 60000);

    it('a delay under one second rounds up to one second, not to an immediate retry', async () =>
    {
        if (!available) return;

        const quick = job('retry-sub-second')
            .options({ retryDelay: 200 })
            .handler(async () =>
            {});

        await createQueueFor(quick, 'retry-sub-second');
        await quick.send();

        expect(await rowsOf('retry-sub-second')).toMatchObject([{ retry_delay: 1 }]);
    }, 60000);

    it('a failed job is retried seconds later, not thousands of seconds later', async () =>
    {
        if (!available) return;

        let attempts = 0;
        const flaky = job('retry-flaky')
            .options({ retryLimit: 1, retryDelay: 5000, retryBackoff: false, pollingIntervalSeconds: 0.5 })
            .handler(async () =>
            {
                attempts++;
                throw new Error('transient');
            });

        await registerJobs(defineJobRouter({ flaky }));
        await flaky.send();

        const until = Date.now() + 20000;
        let rows = await rowsOf('retry-flaky');

        while (rows[0]?.state !== 'retry' && Date.now() < until)
        {
            await new Promise(resolve => setTimeout(resolve, 200));
            rows = await rowsOf('retry-flaky');
        }

        expect(attempts).toBe(1);
        expect(rows[0].state).toBe('retry');
        expect(rows[0].retry_in_seconds).toBeGreaterThan(0);
        expect(rows[0].retry_in_seconds).toBeLessThanOrEqual(5);
    }, 60000);
});
