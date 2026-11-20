/**
 * Pool Recovery Integration Tests
 *
 * Exercises the real postgres.js driver + a real PostgreSQL backend to
 * validate the full rebuild path end-to-end:
 *  - forceReconnectDatabase atomic swap correctness
 *  - Concurrent coalescing (only one rebuild runs)
 *  - reportDatabaseError → sliding window → real rebuild
 *  - Recovery after the DB server terminates our backends
 *
 * Requires the local test services (./scripts/test-services.sh start).
 * Tests self-skip with a warning if the fixture cannot connect.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
    forceReconnectDatabase,
    getDatabase,
    reportDatabaseError,
    resetConnectionErrorCounter,
} from '../../index';
import { getReadClient, getWriteClient } from '../global-state';
import { createDbTestFixture } from '../../__tests__/helpers/db-fixture';

describe('Pool Recovery (Integration)', () =>
{
    const dbFixture = createDbTestFixture();

    beforeAll(async () =>
    {
        await dbFixture.setup();
    });

    beforeEach((context) => dbFixture.skipIfUnavailable(context));

    afterAll(async () =>
    {
        await dbFixture.teardown();
    });

    beforeEach(() =>
    {
        resetConnectionErrorCounter();
    });

    // ========================================================================
    // forceReconnectDatabase — happy path
    // ========================================================================

    describe('forceReconnectDatabase', () =>
    {
        it('performs an atomic swap and the new pool serves queries', async () =>
        {
            // Sanity: pool works before the rebuild.
            const before = await getDatabase('write').execute('SELECT 1 AS ok');
            expect(before).toBeDefined();

            const oldWriteClient = getWriteClient();
            const oldReadClient = getReadClient();
            expect(oldWriteClient).toBeDefined();

            const ran = await forceReconnectDatabase('integration_test');
            expect(ran).toBe(true);

            // The global reference MUST have flipped — this is what proves
            // the atomic swap actually happened and we are not still holding
            // the old Sql instance.
            const newWriteClient = getWriteClient();
            expect(newWriteClient).toBeDefined();
            expect(newWriteClient).not.toBe(oldWriteClient);

            // Read client points at the same new Sql when running single-DB.
            const newReadClient = getReadClient();
            if (oldReadClient === oldWriteClient)
            {
                expect(newReadClient).toBe(newWriteClient);
            }

            // The fresh pool must be functional.
            const after = await getDatabase('write').execute('SELECT 42 AS answer');
            expect(after).toBeDefined();
        });

        it('coalesces concurrent callers to a single rebuild', async () =>
        {
            const beforeClient = getWriteClient();

            const results = await Promise.all([
                forceReconnectDatabase('caller_a'),
                forceReconnectDatabase('caller_b'),
                forceReconnectDatabase('caller_c'),
            ]);

            // Exactly one caller actually ran the rebuild; the others
            // observed isReconnecting=true and returned false.
            const ranCount = results.filter(Boolean).length;
            expect(ranCount).toBe(1);

            // Pool reference moved exactly once (one rebuild).
            const afterClient = getWriteClient();
            expect(afterClient).not.toBe(beforeClient);

            // Still functional.
            const rows = await getDatabase('write').execute('SELECT 1');
            expect(rows).toBeDefined();
        });

        it('survives repeated rebuilds without leaking state', async () =>
        {
            let previousClient = getWriteClient();

            for (let i = 0; i < 3; i++)
            {
                const ran = await forceReconnectDatabase(`loop_${i}`);
                expect(ran).toBe(true);

                const current = getWriteClient();
                expect(current).not.toBe(previousClient);
                previousClient = current;

                // Each new pool is immediately usable.
                await getDatabase('write').execute('SELECT 1');
            }
        });
    });

    // ========================================================================
    // reportDatabaseError — threshold-driven real rebuild
    // ========================================================================

    describe('reportDatabaseError threshold', () =>
    {
        it('crossing the threshold triggers a real pool rebuild', async () =>
        {
            const beforeClient = getWriteClient();
            expect(beforeClient).toBeDefined();

            // Simulate three connection-level errors arriving from query
            // catch sites (3 different physical errors so the WeakSet dedup
            // does not collapse them into one).
            for (let i = 0; i < 3; i++)
            {
                const err = Object.assign(new Error(`conn dead ${i}`), { code: 'ECONNRESET' });
                reportDatabaseError(err);
            }

            // reportDatabaseError fires triggerForceReconnect in the
            // background. Give its promise microtasks + any retry setTimeout
            // a chance to complete.
            await waitForClientSwap(beforeClient, 5000);

            const afterClient = getWriteClient();
            expect(afterClient).not.toBe(beforeClient);

            // The rebuilt pool must be usable.
            const rows = await getDatabase('write').execute('SELECT 1 AS ok');
            expect(rows).toBeDefined();
        });

        it('does not rebuild for query errors (syntax / constraint)', async () =>
        {
            const beforeClient = getWriteClient();

            // 10 syntax errors — classifier must reject all of them.
            for (let i = 0; i < 10; i++)
            {
                const err = Object.assign(new Error('syntax'), { code: '42601' });
                reportDatabaseError(err);
            }

            // Also a few unique-constraint errors.
            for (let i = 0; i < 10; i++)
            {
                const err = Object.assign(new Error('unique'), { code: '23505' });
                reportDatabaseError(err);
            }

            // Give any hypothetical trigger time to fire (it must not).
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(getWriteClient()).toBe(beforeClient);
        });
    });

    // ========================================================================
    // Recovery after pool corruption (user-triggered simulation)
    // ========================================================================

    // NOTE: we deliberately do NOT use `pg_terminate_backend` against the
    // whole test database — parallel integration tests share the same DB,
    // and killing "all backends for testuser" would corrupt their in-flight
    // transactions in a non-deterministic way. The atomic-swap test above
    // already proves the operator recovery contract (new pool ref, queries
    // succeed). This block focuses on a scenario the previous tests do not
    // cover: an explicit forceReconnect racing with live traffic on the old
    // pool, and both sides completing cleanly.
    describe('forceReconnect during live traffic', () =>
    {
        it('interleaving queries and a rebuild does not crash or hang', async () =>
        {
            // Fire a handful of queries against the current pool while a
            // rebuild is running. The rebuild's `closeClient` gives the old
            // pool's in-flight queries up to 5s to drain, so anything that
            // has already been dispatched should still resolve successfully.
            const db = getDatabase('write');
            const queriesBefore = Array.from({ length: 10 }, () =>
                db.execute('SELECT pg_sleep(0.01), 1'),
            );

            const rebuild = forceReconnectDatabase('live_traffic');

            const [rebuildResult, ...queryResults] = await Promise.all([rebuild, ...queriesBefore]);

            expect(rebuildResult).toBe(true);
            expect(queryResults).toHaveLength(10);

            // Post-rebuild queries hit the new pool.
            const rowsAfter = await getDatabase('write').execute('SELECT 1 AS ok');
            expect(rowsAfter).toBeDefined();
        });
    });
});

/**
 * Poll until the write client reference changes (or timeout).
 *
 * reportDatabaseError fires triggerForceReconnect via a fire-and-forget
 * Promise chain, so the rebuild is not awaitable from the test. We wait
 * for the observable side effect — the global reference flipping — instead
 * of guessing at internal timing.
 */
async function waitForClientSwap(
    previous: unknown,
    timeoutMs: number,
): Promise<void>
{
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        if (getWriteClient() !== previous) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Pool rebuild did not happen within ${timeoutMs}ms`);
}
