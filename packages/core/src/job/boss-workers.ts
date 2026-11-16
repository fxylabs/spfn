/**
 * The workers a pg-boss instance runs in this process
 *
 * pg-boss 11 offers no public way to list its workers, nor to stop them
 * without also stopping sends (`stop()` does both). So the instance
 * `initBoss()` creates records them itself: its `work` and `offWork` are
 * wrapped once, where the instance is made, and every worker started on the
 * instance `getBoss()` returns — by registerJobs() or by the app — is known
 * here. The wrapped handler also records the jobs pg-boss is waiting on it
 * for, which is what a shutdown reports when pg-boss stops under them.
 *
 * The record lives on the instance, so it belongs to that instance alone: a
 * newer instance (a second startServer() in one process) has its own.
 */

import type PgBoss from 'pg-boss';

const WORKERS_KEY = Symbol.for('spfn:boss-workers');

type Work = (name: string, ...args: unknown[]) => Promise<string>;

type OffWork = (value: string | { id: string }) => Promise<void>;

type Handler = (jobs: PgBoss.Job[]) => Promise<unknown>;

interface BossWorkers
{
    /** false once stopFetching() ran: a `work` call is refused from then on */
    fetching: boolean;

    /** Worker id → queue name, for every worker started and not yet stopped */
    workers: Map<string, string>;

    /** `work` calls that have not returned their worker id yet */
    starting: Set<Promise<string>>;

    /** Job id → its queue, for every job pg-boss is waiting on a handler for */
    running: Map<string, { queue: string }>;

    offWork: OffWork;
}

export interface RunningJob
{
    id: string;
    queue: string;
}

/**
 * Make `boss` record the workers started on it and the jobs they run
 *
 * After `stopWorkers(boss)`, `boss.work()` rejects: the instance is shutting
 * down and must not fetch again.
 */
export function recordWorkers(boss: PgBoss): void
{
    const work = boss.work.bind(boss) as Work;
    const record: BossWorkers = {
        fetching: true,
        workers: new Map(),
        starting: new Set(),
        running: new Map(),
        offWork: boss.offWork.bind(boss) as OffWork,
    };

    (boss as any)[WORKERS_KEY] = record;
    (boss as any).work = (name: string, ...args: unknown[]) => startWorker(record, work, name, args);
    (boss as any).offWork = (value: string | { id: string }) => stopWorker(record, value);
}

/**
 * Stop every worker started on `boss`; sending is untouched
 *
 * A `work` call still starting is waited for, so its worker is stopped too.
 *
 * @returns the number of workers stopped
 */
export async function stopWorkers(boss: PgBoss): Promise<number>
{
    const record = recordOf(boss);
    record.fetching = false;

    await Promise.allSettled(record.starting);

    const ids = [...record.workers.keys()];
    await Promise.all(ids.map((id) => stopWorker(record, { id })));

    return ids.length;
}

/**
 * The jobs pg-boss is waiting on a handler started on `boss` for — not
 * those past their expiration, which pg-boss already failed
 */
export function runningJobs(boss: PgBoss): RunningJob[]
{
    return Array.from(recordOf(boss).running, ([id, { queue }]) => ({ id, queue }));
}

function recordOf(boss: PgBoss): BossWorkers
{
    return (boss as any)[WORKERS_KEY];
}

async function startWorker(record: BossWorkers, work: Work, name: string, args: unknown[]): Promise<string>
{
    if (!record.fetching)
    {
        throw new Error(
            `pg-boss work('${name}') refused: this instance has stopped fetching for a shutdown. ` +
            'Start workers before the shutdown begins; a live instance runs the queue.',
        );
    }

    const handler = args[args.length - 1] as Handler;
    const starting = work(name, ...args.slice(0, -1), recordRunning(record, name, handler));
    record.starting.add(starting);

    try
    {
        const id = await starting;
        record.workers.set(id, name);

        return id;
    }
    finally
    {
        record.starting.delete(starting);
    }
}

async function stopWorker(record: BossWorkers, value: string | { id: string }): Promise<void>
{
    await record.offWork(value);

    for (const [id, queue] of record.workers)
    {
        if (typeof value === 'string' ? queue === value : id === value.id)
        {
            record.workers.delete(id);
        }
    }
}

/**
 * Record the jobs `handler` runs for as long as pg-boss waits for them
 *
 * pg-boss 11.1.2 bounds a handler by its jobs' expiration (`resolveWithinSeconds`
 * over the batch's largest `expireInSeconds`, at least 1 s); past it, pg-boss
 * fails the jobs and forgets them, though the handler may run on. So a job's
 * entry ends at that same bound or when the handler settles, whichever is
 * first — a retry fetched meanwhile has its own entry, which this one leaves.
 */
function recordRunning(record: BossWorkers, queue: string, handler: Handler): Handler
{
    return async (jobs) =>
    {
        const entry = { queue };
        jobs.forEach((job) => record.running.set(job.id, entry));

        const forget = () => jobs
            .filter((job) => record.running.get(job.id) === entry)
            .forEach((job) => record.running.delete(job.id));
        const expiry = setTimeout(forget, pgBossHandlerBound(jobs));
        expiry.unref();

        try
        {
            return await handler(jobs);
        }
        finally
        {
            clearTimeout(expiry);
            forget();
        }
    };
}

/** How long pg-boss waits for a handler of `jobs`, as its `work()` computes it (manager.js) */
function pgBossHandlerBound(jobs: PgBoss.Job[]): number
{
    const maxExpiration = jobs.reduce((max, job) => Math.max(max, job.expireInSeconds), 0);

    return Math.max(1, maxExpiration) * 1000;
}
