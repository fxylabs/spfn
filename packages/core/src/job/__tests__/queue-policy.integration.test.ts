/**
 * Queue Policy Integration Tests
 *
 * Exercises queue policies against a real pg-boss + PostgreSQL backend: on a
 * `standard` queue pg-boss has no unique index on
 * `(name, COALESCE(singleton_key, ''))`, so the insert's ON CONFLICT DO
 * NOTHING never conflicts and `singletonKey` is stored and ignored. Only a
 * non-standard policy — `exclusive` here — actually deduplicates.
 *
 * Requires the local test services (./scripts/test-services.sh start).
 * Tests self-skip with a warning if the fixture cannot connect.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { job } from '../job-builder';
import { defineJobRouter } from '../job-router';
import { registerJobs, resetOrphanSweepState } from '../register-jobs';
import { resolveQueuePolicy } from '../queue-policy';
import { getBoss, initBoss, stopBoss } from '../boss';
import { TEST_DATABASE_URL } from '../../db/__tests__/helpers/db-fixture';

const TEST_SCHEMA = 'spfn_queue_policy_test';

// Workers poll immediately when they start, then wait this long. Long enough
// that no job registered here is consumed before it is counted.
const IDLE_POLLING_SECONDS = 3600;

describe('Queue Policy (Integration)', () =>
{
    let available = false;
    let sql: Sql;

    // Held open so a runOnce job picked up by its own worker stays 'active'
    // instead of completing and freeing its singletonKey mid-test.
    let releaseHandlers: () => void = () =>
    {};
    const handlerGate = new Promise<void>((resolve) =>
    {
        releaseHandlers = resolve;
    });

    async function countJobRows(name: string): Promise<number>
    {
        const rows = await sql.unsafe(
            `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.job WHERE name = $1`,
            [name],
        );

        return rows[0].count as number;
    }

    beforeAll(async () =>
    {
        try
        {
            await initBoss({
                connectionString: TEST_DATABASE_URL,
                schema: TEST_SCHEMA,
            });
            sql = (await import('postgres')).default(TEST_DATABASE_URL);
            available = true;
        }
        catch
        {
            console.warn('[queue-policy] test postgres unavailable, skipping');
        }
    });

    beforeEach(({ skip }) => skip(!available, 'PostgreSQL not available'));

    afterAll(async () =>
    {
        resetOrphanSweepState();
        releaseHandlers();

        if (!available)
        {
            return;
        }

        await stopBoss();
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
        await sql.end();
    });

    it('row 17: enqueues a runOnce job only once across two registerJobs calls', async () =>
    {
        const initCache = job('init-cache')
            .runOnce()
            .options({ pollingIntervalSeconds: IDLE_POLLING_SECONDS })
            .handler(async () =>
            {
                await handlerGate;
            });

        const router = defineJobRouter({ initCache });

        await registerJobs(router);
        await registerJobs(router);

        expect(await countJobRows('init-cache')).toBe(1);

        const states = await sql.unsafe(
            `SELECT state FROM ${TEST_SCHEMA}.job WHERE name = 'init-cache'`,
        );
        expect(['created', 'active']).toContain(states[0].state);

        // The registration path swallows the send result, so re-send the same
        // runOnce key directly: pg-boss drops it and returns null.
        const boss = getBoss()!;
        expect(await boss.send('init-cache', {}, { singletonKey: 'runOnce:init-cache' })).toBeNull();
        expect(await countJobRows('init-cache')).toBe(1);
    }, 60000);

    it('row 18: drops the second send of an exclusive job sharing a singletonKey', async () =>
    {
        const reindex = job('reindex')
            .options({ singletonKey: 'only-one' })
            .handler(async () =>
            {});

        // No worker: the queue alone is what the policy lives on.
        const boss = getBoss()!;
        await boss.createQueue('reindex', { policy: resolveQueuePolicy(reindex) });

        expect(await reindex.send()).not.toBeNull();
        expect(await reindex.send()).toBeNull();
        expect(await countJobRows('reindex')).toBe(1);
    }, 60000);

    it('row 19: keeps both sends when a send-time key lands on a standard queue', async () =>
    {
        const notify = job('notify')
            .handler(async () =>
            {});

        const boss = getBoss()!;
        await boss.createQueue('notify', { policy: resolveQueuePolicy(notify) });

        expect(await notify.send({ singletonKey: 'same' })).not.toBeNull();
        expect(await notify.send({ singletonKey: 'same' })).not.toBeNull();
        expect(await countJobRows('notify')).toBe(2);
    }, 60000);
});
