/**
 * Job Registration
 *
 * Registers jobs with pg-boss
 */

import type PgBoss from 'pg-boss';
import { logger } from '@spfn/core/logger';
import { env } from '@spfn/core/config';
import type { JobDef, JobOptions, JobQueuePolicy, JobRouter } from './types';
import type { EventDef } from '@spfn/core/event';
import { collectJobEntries, collectJobs } from './job-router';
import { resolveQueuePolicy } from './queue-policy';
import { toPgBossRetryOptions } from './retry-options';
import { getBoss, shouldClearOnStart, shouldSweepOrphanSchedules } from './boss';

const jobLogger = logger.child('@spfn/core:job');

/**
 * Get the pg-boss queue name for an event
 */
export function getEventQueueName(eventName: string): string
{
    return `event:${eventName}`;
}

/**
 * Build default pg-boss options for a job
 */
function getDefaultJobOptions(options?: JobOptions): PgBoss.SendOptions
{
    return {
        ...toPgBossRetryOptions(options),
        expireInSeconds: options?.expireInSeconds ?? 300,
    };
}

/**
 * Register all jobs from a JobRouter with pg-boss
 *
 * This function:
 * 1. Collects all jobs from the router (including nested routers)
 * 2. Optionally clears existing jobs (if clearOnStart is enabled)
 * 3. Registers each job's worker handler with pg-boss
 * 4. Sets up cron schedules for scheduled jobs
 * 5. Queues runOnce jobs
 * 6. Connects event subscriptions to job queues
 *
 * @param router - JobRouter containing job definitions
 *
 * @example
 * ```typescript
 * // Define jobs
 * const sendEmail = job('send-email')
 *     .input(Type.Object({ to: Type.String() }))
 *     .handler(async (input) => { ... });
 *
 * const dailyReport = job('daily-report')
 *     .cron('0 9 * * *')
 *     .handler(async () => { ... });
 *
 * // Create router
 * const jobRouter = defineJobRouter({ sendEmail, dailyReport });
 *
 * // Initialize pg-boss first
 * await initBoss({ connectionString: process.env.DATABASE_URL! });
 *
 * // Register jobs
 * await registerJobs(jobRouter);
 * ```
 */
export async function registerJobs(router: JobRouter<any>): Promise<void>
{
    const boss = getBoss();
    if (!boss)
    {
        throw new Error(
            'pg-boss not initialized. Call initBoss() before registerJobs()',
        );
    }

    assertUniqueJobNames(router);

    const jobs = collectJobs(router);
    const clearOnStart = shouldClearOnStart();

    jobLogger.info(`Registering ${jobs.length} job(s)...`);

    // Clear existing jobs if requested (useful for development)
    if (clearOnStart)
    {
        jobLogger.info('Clearing existing jobs before registration...');
        for (const job of jobs)
        {
            // Clear job queue
            await boss.deleteAllJobs(job.name);

            // Also clear event queue if subscribed
            if (job.subscribedEvent)
            {
                const eventQueue = getEventQueueName(job.subscribedEvent);
                await boss.deleteAllJobs(eventQueue);
            }
        }
        jobLogger.info('Existing jobs cleared');
    }

    // Each job registers an independent pg-boss queue/worker, so register them
    // concurrently — sequential awaits made startup scale linearly with job count.
    await Promise.all(jobs.map((job) => registerJob(job)));

    for (const job of jobs)
    {
        if (job.cronExpression)
        {
            registeredCronNames.add(job.name);
        }
    }

    if (shouldSweepOrphanSchedules())
    {
        await sweepOrphanSchedules(boss);
    }

    jobLogger.info('All jobs registered successfully');
}

/**
 * Reject two job definitions that share a `name`
 *
 * A job name *is* its pg-boss queue name, so two jobs with the same name share
 * one queue and one worker: whichever registered last silently handles both.
 * Merged routers make this easy to hit, and it must fail before any queue or
 * worker exists.
 *
 * @throws if two collected jobs share a name
 */
function assertUniqueJobNames(router: JobRouter<any>): void
{
    const keysByName = new Map<string, string>();

    for (const { key, job } of collectJobEntries(router))
    {
        const existingKey = keysByName.get(job.name);

        if (existingKey)
        {
            throw new Error(
                `registerJobs(): job name "${job.name}" is defined twice ` +
                `(keys "${existingKey}" and "${key}"); ` +
                'job names are pg-boss queue names and must be unique',
            );
        }

        keysByName.set(job.name, key);
    }
}

// Cron names accumulate across registerJobs() calls so a sweep in one call
// never treats another router's schedules (registered earlier in the same
// process) as orphans.
const registeredCronNames = new Set<string>();

/**
 * Reset sweep state accumulated by registerJobs()
 *
 * @internal test-only
 */
export function resetOrphanSweepState(): void
{
    registeredCronNames.clear();
}

/**
 * Unschedule pg-boss schedules that are no longer declared on any router
 * registered in this process (opt-in via `sweepOrphanSchedules`)
 *
 * The router is the only sanctioned way to create cron schedules, so any
 * schedule whose name is not a declared cron job is an orphan: pg-boss keeps
 * creating jobs for it on every cron tick, and without a worker they
 * accumulate forever. Unscheduling stops the pile-up; the queue and its
 * existing job rows are left untouched so nothing is destroyed if the name
 * belongs to another app, an ad-hoc getBoss() schedule, or a newer deploy.
 *
 * Skipped entirely when no cron job has been declared — an empty router says
 * nothing about which schedules are orphans. Runs once after registration;
 * failures are logged per orphan and never block startup.
 */
async function sweepOrphanSchedules(boss: PgBoss): Promise<void>
{
    if (registeredCronNames.size === 0)
    {
        jobLogger.debug('No cron jobs declared; skipping orphan schedule sweep');

        return;
    }

    try
    {
        const schedules = await boss.getSchedules();
        const orphans = schedules.filter((schedule) => !registeredCronNames.has(schedule.name));

        if (orphans.length === 0)
        {
            jobLogger.debug('No orphan schedules found');

            return;
        }

        await Promise.all(orphans.map(async (orphan) =>
        {
            try
            {
                await boss.unschedule(orphan.name, orphan.key);
                jobLogger.info(`Removed orphan schedule: ${orphan.name}`);
            }
            catch (error)
            {
                jobLogger.error(`Failed to remove orphan schedule: ${orphan.name}`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }));
    }
    catch (error)
    {
        jobLogger.error('Orphan schedule sweep failed', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * Create the queue with the wanted policy, or report that it already differs
 *
 * pg-boss `create_queue` is `INSERT … ON CONFLICT DO NOTHING`, so a queue
 * created by an earlier version keeps its old policy and `createQueue` is a
 * silent no-op. `updateQueue` cannot change a policy either. Comparing against
 * `getQueue` is the only way an already-deployed app ever gets the fix.
 *
 * Recreating the queue drops its job rows, so that only happens under
 * `clearOnStart` (development). Otherwise the mismatch is logged and boot
 * continues — a queue that does not deduplicate is a degraded queue, not a
 * broken one.
 */
async function ensureQueue(boss: PgBoss, queueName: string, policy: JobQueuePolicy): Promise<void>
{
    await boss.createQueue(queueName, { policy });

    // null = queue missing (nothing to compare); pg-boss defaults it to 'standard'
    const existing = await boss.getQueue(queueName);
    if (!existing || existing.policy === policy)
    {
        return;
    }

    if (shouldClearOnStart())
    {
        await boss.deleteQueue(queueName);
        await boss.createQueue(queueName, { policy });
        jobLogger.info(`[Queue:${queueName}] policy ${existing.policy} → ${policy} (recreated: clearOnStart)`);

        return;
    }

    jobLogger.error(
        `[Queue:${queueName}] policy mismatch: the queue exists as "${existing.policy}" but its jobs ` +
        `require "${policy}". Delete the queue in a quiet window ` +
        `(getBoss().deleteQueue('${queueName}') drops its job rows) or set clearOnStart in development; ` +
        'until then singletonKey/runOnce on this queue do not deduplicate',
    );
}

/**
 * Build the once-per-queue ensure used by a single registerJob() call
 *
 * registerJob touches its queue up to three times (worker, cron, runOnce) and
 * all three want the same policy, so the queue is ensured on first use only —
 * otherwise the same mismatch would be created and logged three times over.
 */
function createQueueEnsurer(boss: PgBoss, policy: JobQueuePolicy): (queueName: string) => Promise<void>
{
    const ensured = new Set<string>();

    return async (queueName: string) =>
    {
        if (ensured.has(queueName))
        {
            return;
        }

        ensured.add(queueName);

        await ensureQueue(boss, queueName, policy);
    };
}

/**
 * Execute a single job handler with logging
 */
async function executeJobHandler(
    job: JobDef<any>,
    pgBossJob: PgBoss.Job<any>,
): Promise<void>
{
    jobLogger.debug(`[Job:${job.name}] Executing...`, { jobId: pgBossJob.id });

    const startTime = Date.now();

    try
    {
        if (job.inputSchema)
        {
            await (job.handler as (input: unknown) => Promise<void>)(pgBossJob.data);
        }
        else
        {
            await (job.handler as () => Promise<void>)();
        }

        const duration = Date.now() - startTime;
        jobLogger.info(`[Job:${job.name}] Completed in ${duration}ms`, {
            jobId: pgBossJob.id,
            duration,
        });
    }
    catch (error)
    {
        const duration = Date.now() - startTime;
        jobLogger.error(`[Job:${job.name}] Failed after ${duration}ms`, {
            jobId: pgBossJob.id,
            duration,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

/**
 * Register worker handler for a job
 *
 * When batchSize > 1, jobs are processed in parallel.
 * Failed jobs are individually marked via boss.fail() so pg-boss can retry them.
 * Successful jobs are auto-completed when the handler callback resolves.
 */
async function registerWorker(
    boss: PgBoss,
    job: JobDef<any>,
    queueName: string,
    ensureQueueOnce: (queueName: string) => Promise<void>,
): Promise<void>
{
    // Ensure queue exists before registering worker
    await ensureQueueOnce(queueName);

    const batchSize = job.options?.batchSize ?? 1;
    const pollingIntervalSeconds = job.options?.pollingIntervalSeconds ?? env.JOB_POLLING_INTERVAL_SECONDS;

    await boss.work(
        queueName,
        { batchSize, pollingIntervalSeconds },
        async (pgBossJobs) =>
        {
            if (batchSize <= 1)
            {
                // Single job — throw on error for pg-boss retry
                await executeJobHandler(job, pgBossJobs[0]);

                return;
            }

            // Batch — parallel execution with individual failure handling
            const results = await Promise.allSettled(
                pgBossJobs.map((pgBossJob) => executeJobHandler(job, pgBossJob)),
            );

            // Collect failed job IDs and mark them individually.
            // boss.fail() sets state = 'failed'; the subsequent auto-complete
            // from work() only affects jobs still in 'active' state, so
            // already-failed jobs are not overwritten.
            const failedIds: string[] = [];

            for (let i = 0; i < results.length; i++)
            {
                if (results[i].status === 'rejected')
                {
                    failedIds.push(pgBossJobs[i].id);
                }
            }

            if (failedIds.length > 0)
            {
                await boss.fail(queueName, failedIds);
            }

            // Callback resolves → pg-boss auto-completes remaining 'active' jobs
        },
    );
}

/**
 * Connect event to pg-boss queue
 */
function connectEventToQueue(
    boss: PgBoss,
    job: JobDef<any>,
    queueName: string,
): void
{
    if (!job._subscribedEventDef)
    {
        return;
    }

    const eventDef = job._subscribedEventDef as EventDef<any>;
    eventDef._registerJobQueue(queueName, async (queue, payload) =>
    {
        await boss.send(queue, payload as object, getDefaultJobOptions(job.options));
    });

    jobLogger.debug(`[Job:${job.name}] Connected to event: ${job.subscribedEvent}`);
}

/**
 * Register cron schedule for a job
 */
async function registerCronSchedule(
    boss: PgBoss,
    job: JobDef<any>,
    ensureQueueOnce: (queueName: string) => Promise<void>,
): Promise<void>
{
    if (!job.cronExpression)
    {
        return;
    }

    jobLogger.debug(`[Job:${job.name}] Scheduling cron: ${job.cronExpression}`);

    // Ensure queue exists for cron jobs (uses job.name as queue)
    await ensureQueueOnce(job.name);

    await boss.schedule(
        job.name,
        job.cronExpression,
        {},
        getDefaultJobOptions(job.options),
    );

    jobLogger.info(`[Job:${job.name}] Cron scheduled: ${job.cronExpression}`);
}

/**
 * Queue a runOnce job
 */
async function queueRunOnceJob(
    boss: PgBoss,
    job: JobDef<any>,
    ensureQueueOnce: (queueName: string) => Promise<void>,
): Promise<void>
{
    if (!job.runOnce)
    {
        return;
    }

    jobLogger.debug(`[Job:${job.name}] Queuing runOnce job`);

    // Ensure queue exists for runOnce jobs (uses job.name as queue)
    await ensureQueueOnce(job.name);

    await boss.send(
        job.name,
        {},
        {
            ...getDefaultJobOptions(job.options),
            singletonKey: `runOnce:${job.name}`,
        },
    );

    jobLogger.info(`[Job:${job.name}] runOnce job queued`);
}

/**
 * Register a single job with pg-boss
 */
async function registerJob(job: JobDef<any>): Promise<void>
{
    const boss = getBoss();
    if (!boss)
    {
        throw new Error('pg-boss not initialized');
    }

    const queueName = job.subscribedEvent
        ? getEventQueueName(job.subscribedEvent)
        : job.name;

    jobLogger.debug(`Registering job: ${job.name}`, {
        queueName,
        subscribedEvent: job.subscribedEvent,
    });

    const ensureQueueOnce = createQueueEnsurer(boss, resolveQueuePolicy(job));

    await registerWorker(boss, job, queueName, ensureQueueOnce);
    connectEventToQueue(boss, job, queueName);
    await registerCronSchedule(boss, job, ensureQueueOnce);
    await queueRunOnceJob(boss, job, ensureQueueOnce);

    jobLogger.debug(`Job registered: ${job.name}`);
}
