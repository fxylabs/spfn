/**
 * Orphan Schedule Sweep Integration Tests
 *
 * Exercises registerJobs against a real pg-boss + PostgreSQL backend:
 * a schedule planted outside the router (simulating a job removed from the
 * router in a later deploy) must be unscheduled, while its queue and job
 * rows stay untouched.
 *
 * Requires the local test services (./scripts/test-services.sh start).
 * Tests self-skip with a warning if the fixture cannot connect.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { job } from '../job-builder';
import { defineJobRouter } from '../job-router';
import { registerJobs, resetOrphanSweepState } from '../register-jobs';
import { getBoss, initBoss, stopBoss } from '../boss';
import { TEST_DATABASE_URL } from '../../db/__tests__/helpers/db-fixture';

const TEST_SCHEMA = 'spfn_queue_sweep_test';

describe('Orphan Schedule Sweep (Integration)', () =>
{
    let available = false;

    beforeAll(async () =>
    {
        try
        {
            await initBoss({
                connectionString: TEST_DATABASE_URL,
                schema: TEST_SCHEMA,
                sweepOrphanSchedules: true,
            });
            available = true;
        }
        catch
        {
            console.warn('[schedule-sweep] test postgres unavailable, skipping');
        }
    });

    beforeEach(({ skip }) => skip(!available, 'PostgreSQL not available'));

    afterAll(async () =>
    {
        resetOrphanSweepState();

        if (!available)
        {
            return;
        }

        await stopBoss();

        // Drop the throwaway schema so reruns start clean
        const postgres = (await import('postgres')).default;
        const sql = postgres(TEST_DATABASE_URL);
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
        await sql.end();
    });

    it('unschedules a schedule left behind by a removed job but keeps its queue', async () =>
    {
        const boss = getBoss()!;

        // Plant a legacy schedule as if 'legacy-reaper' was once a cron job
        await boss.createQueue('legacy-reaper');
        await boss.schedule('legacy-reaper', '* * * * *');

        const cronJob = job('daily-report')
            .cron('0 9 * * *')
            .handler(async () =>
            {});

        await registerJobs(defineJobRouter({ cronJob }));

        const schedules = await boss.getSchedules();
        const names = schedules.map((schedule) => schedule.name);

        expect(names).not.toContain('legacy-reaper');
        expect(names).toContain('daily-report');

        // Queues are never deleted by the sweep — only the schedule row goes
        const queues = await boss.getQueues();
        const queueNames = queues.map((queue) => queue.name);

        expect(queueNames).toContain('legacy-reaper');
        expect(queueNames).toContain('daily-report');
    }, 30000);
});
