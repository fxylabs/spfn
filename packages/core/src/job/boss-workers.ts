/**
 * The workers a pg-boss instance runs in this process
 *
 * Core runs them itself. pg-boss 11's own worker cannot tell when its last
 * fetch has settled — `offWork` only asks it to stop — so a fetch already in
 * flight could still take a job after a shutdown said fetching had stopped
 * (#359). The instance `initBoss()` creates therefore has its `work`,
 * `offWork` and `notifyWorker` replaced once, where it is made: `work()`
 * starts core's fetch loop on pg-boss's public `fetch` / `complete` / `fail`,
 * which keeps what pg-boss's worker does (see `runLoop`) and holds its
 * current fetch as a promise `stopWorkers` awaits.
 *
 * Every worker started on the instance `getBoss()` returns — by registerJobs()
 * or by the app — is a core loop, and core knows the jobs each one runs. A
 * PgBoss the app constructs itself is not touched: its workers are pg-boss's
 * own, and a shutdown neither stops nor fails them.
 *
 * The record lives on the instance, so it belongs to that instance alone: a
 * newer instance (a second startServer() in one process) has its own.
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import type PgBoss from 'pg-boss';

const WORKERS_KEY = Symbol.for('spfn:boss-workers');

/** pg-boss's shortest polling interval and its default (attorney.js) */
const MIN_POLLING_INTERVAL = 500;
const DEFAULT_POLLING_INTERVAL = 2000;

/** A wait between polls shorter than this is skipped, as pg-boss's worker does */
const SHORTEST_PAUSE = 100;

/** What pg-boss's stop writes as the output of a job it fails; core writes the same */
const STOPPED_WHILE_ACTIVE = 'pg-boss shut down while active';

type Handler = (jobs: PgBoss.Job[]) => unknown;

/**
 * `complete` / `fail` as pg-boss 11.1.2 runs them: ids and data together, as
 * its own worker calls them — its types list data only with a single id
 */
type SettleJobs = (name: string, ids: string[], data?: unknown) => Promise<unknown>;

interface FetchOptions
{
    batchSize: number;
    includeMetadata: boolean;
    priority: boolean;
}

interface Loop
{
    id: string;
    queue: string;
    interval: number;
    fetchOptions: FetchOptions;
    handler: Handler;
    stopping: boolean;

    /** Set by `notifyWorker`: the next wait between polls is skipped */
    notified: boolean;

    /** The fetch in flight; null between fetches */
    fetching: Promise<PgBoss.Job[]> | null;

    /** Ends the wait between polls early; null when the loop is not waiting */
    wake: (() => void) | null;
}

interface BossWorkers
{
    /** false once stopWorkers() ran: a `work` call is refused from then on */
    fetching: boolean;

    /** Worker id → its loop, until the loop has ended */
    loops: Map<string, Loop>;

    /** Job id → its queue, for every job core is waiting on a handler for */
    running: Map<string, { queue: string }>;

    /** One per batch of jobs, until the batch is completed or failed */
    batches: Set<Promise<void>>;
}

export interface RunningJob
{
    id: string;
    queue: string;
}

export interface StoppedWorkers
{
    /** Workers this call stopped */
    stopped: number;

    /** Fetches still in flight when the wait ended */
    inFlight: number;
}

/**
 * Make `boss` run its workers on core's fetch loop
 *
 * After `stopWorkers(boss)`, `boss.work()` rejects: the instance is shutting
 * down and must not fetch again.
 */
export function recordWorkers(boss: PgBoss): void
{
    const record: BossWorkers = { fetching: true, loops: new Map(), running: new Map(), batches: new Set() };
    const notifyWorker = boss.notifyWorker.bind(boss);

    (boss as any)[WORKERS_KEY] = record;
    (boss as any).work = async (name: string, ...args: unknown[]) => startLoop(boss, record, name, args);
    (boss as any).offWork = async (value: string | { id: string }) => stopLoops(record, value);
    (boss as any).notifyWorker = (id: string) =>
        record.loops.has(id) ? notify(record.loops.get(id)!) : notifyWorker(id);
}

/**
 * Stop every worker started on `boss`, and wait up to `fetchWait` ms for the
 * fetches they have in flight; sending is untouched
 *
 * Handlers are not waited for. A fetch settled within the wait has taken its
 * jobs before this returned; one still in flight may take jobs later, and
 * they start on this instance.
 */
export async function stopWorkers(boss: PgBoss, fetchWait: number): Promise<StoppedWorkers>
{
    const record = recordOf(boss);
    record.fetching = false;

    const loops = [...record.loops.values()];
    const stopped = loops.filter((loop) => !loop.stopping).length;
    loops.forEach(stop);

    await settleWithin(loops.map((loop) => loop.fetching), fetchWait);

    return { stopped, inFlight: loops.filter((loop) => loop.fetching !== null).length };
}

/**
 * Wait up to `wait` ms for the handlers core runs on `boss` — including any a
 * fetch still in flight hands jobs to meanwhile
 */
export async function waitForHandlers(boss: PgBoss, wait: number): Promise<void>
{
    const record = recordOf(boss);
    const deadline = Date.now() + wait;

    while (record.batches.size > 0 && Date.now() < deadline)
    {
        await settleWithin([...record.batches], deadline - Date.now());
    }
}

/**
 * Fail every job core is still waiting on a handler for, as pg-boss's stop
 * fails the jobs its own workers hold: retried if attempts remain
 *
 * @returns the jobs failed
 */
export async function failRunningJobs(boss: PgBoss): Promise<RunningJob[]>
{
    const jobs = runningJobs(boss);
    const queues = new Set(jobs.map((job) => job.queue));

    await Promise.all([...queues].map((queue) => (boss.fail as SettleJobs)(
        queue,
        jobs.filter((job) => job.queue === queue).map((job) => job.id),
        { value: STOPPED_WHILE_ACTIVE },
    )));

    return jobs;
}

/**
 * The jobs core is waiting on a handler started on `boss` for — not those
 * past their bound, which the loop already failed
 */
export function runningJobs(boss: PgBoss): RunningJob[]
{
    return Array.from(recordOf(boss).running, ([id, { queue }]) => ({ id, queue }));
}

function recordOf(boss: PgBoss): BossWorkers
{
    return (boss as any)[WORKERS_KEY];
}

/**
 * `work(name, [options,] handler)`, checked as pg-boss checks it
 *
 * @returns the worker id
 */
function startLoop(boss: PgBoss, record: BossWorkers, name: string, args: unknown[]): string
{
    if (!record.fetching)
    {
        throw new Error(
            `pg-boss work('${name}') refused: this instance has stopped fetching for a shutdown. ` +
            'Start workers before the shutdown begins; a live instance runs the queue.',
        );
    }

    const loop = createLoop(name, args);
    record.loops.set(loop.id, loop);
    void runLoop(boss, record, loop);

    return loop.id;
}

function createLoop(name: string, args: unknown[]): Loop
{
    const { options, handler } = checkWorkArgs(name, args);

    return {
        id: randomUUID(),
        queue: name,
        interval: 'pollingIntervalSeconds' in options ? options.pollingIntervalSeconds! * 1000 : DEFAULT_POLLING_INTERVAL,
        fetchOptions: {
            batchSize: options.batchSize || 1,
            includeMetadata: options.includeMetadata ?? false,
            priority: options.priority ?? true,
        },
        handler,
        stopping: false,
        notified: false,
        fetching: null,
        wake: null,
    };
}

/** pg-boss's own checks of `work()`'s arguments, with its messages (attorney.js) */
function checkWorkArgs(name: string, args: unknown[]): { options: PgBoss.WorkOptions; handler: Handler }
{
    const handler = args[args.length - 1] as Handler;
    const options = (args.length > 1 ? args[0] ?? {} : {}) as PgBoss.WorkOptions;

    assert(name, 'missing job name');
    assert(typeof handler === 'function', 'expected callback to be a function');
    assert(typeof options === 'object', 'expected config to be an object');
    assert(!('pollingIntervalSeconds' in options) || options.pollingIntervalSeconds! >= MIN_POLLING_INTERVAL / 1000,
        `configuration assert: pollingIntervalSeconds must be at least every ${MIN_POLLING_INTERVAL}ms`);
    assert(!('batchSize' in options) || (Number.isInteger(options.batchSize) && options.batchSize! >= 1),
        'batchSize must be an integer > 0');
    assert(!('includeMetadata' in options) || typeof options.includeMetadata === 'boolean',
        'includeMetadata must be a boolean');
    assert(!('priority' in options) || typeof options.priority === 'boolean', 'priority must be a boolean');

    return { options, handler };
}

/**
 * pg-boss's worker loop: fetch, run the batch, wait out the polling interval
 * — skipped when notified, or when the fetch and batch took nearly all of it
 */
async function runLoop(boss: PgBoss, record: BossWorkers, loop: Loop): Promise<void>
{
    while (!loop.stopping)
    {
        const started = Date.now();
        loop.notified = false;

        await poll(boss, record, loop);
        await pause(loop, loop.interval - (Date.now() - started));
    }

    record.loops.delete(loop.id);
}

/**
 * One fetch and, when it took jobs, their batch; a failure is emitted as
 * pg-boss's worker emits it, and the loop goes on
 */
async function poll(boss: PgBoss, record: BossWorkers, loop: Loop): Promise<void>
{
    try
    {
        // No await before this call: a loop is never between "not stopping" and a fetch it holds
        loop.fetching = boss.fetch<object>(loop.queue, loop.fetchOptions).finally(() =>
        {
            loop.fetching = null;
        });
        const jobs = await loop.fetching;

        if (jobs.length > 0)
        {
            await runBatch(boss, record, loop, jobs);
        }
    }
    catch (error)
    {
        emitError(boss, loop, error);
    }
}

/**
 * A batch counts as running until it is completed or failed, as pg-boss's
 * worker holds its jobs until then — so a stop that waits for it lets the
 * completion land before the pool closes
 */
async function runBatch(boss: PgBoss, record: BossWorkers, loop: Loop, jobs: PgBoss.Job[]): Promise<void>
{
    const batch = settleBatch(boss, record, loop, jobs);
    record.batches.add(batch);

    try
    {
        await batch;
    }
    finally
    {
        record.batches.delete(batch);
    }
}

/**
 * Run the handler within its bound, then complete the batch — with the
 * handler's result for a single job — or fail it with what the handler threw
 */
async function settleBatch(boss: PgBoss, record: BossWorkers, loop: Loop, jobs: PgBoss.Job[]): Promise<void>
{
    const ids = jobs.map((job) => job.id);

    try
    {
        const result = await runBounded(record, loop, jobs);
        await (boss.complete as SettleJobs)(loop.queue, ids, ids.length === 1 ? result : undefined);
    }
    catch (error)
    {
        await (boss.fail as SettleJobs)(loop.queue, ids, error);
    }
}

/**
 * The handler, raced against pg-boss's bound for it: the batch's largest
 * `expireInSeconds`, at least 1 s. Past the bound the batch is failed while
 * the handler may run on, so its jobs leave `running` then — a retry fetched
 * meanwhile has its own entry, which this one leaves.
 */
function runBounded(record: BossWorkers, loop: Loop, jobs: PgBoss.Job[]): Promise<unknown>
{
    const maxExpiration = jobs.reduce((max, job) => Math.max(max, job.expireInSeconds), 0);
    const entry = { queue: loop.queue };
    let bound: NodeJS.Timeout | undefined;

    jobs.forEach((job) => record.running.set(job.id, entry));

    return Promise.race([
        new Promise((resolve) => resolve(loop.handler(jobs))),
        new Promise((_, reject) =>
        {
            bound = setTimeout(() => reject(new Error(`handler execution exceeded ${maxExpiration}s`)),
                Math.max(1, maxExpiration) * 1000);
        }),
    ]).finally(() =>
    {
        clearTimeout(bound);
        jobs.filter((job) => record.running.get(job.id) === entry).forEach((job) => record.running.delete(job.id));
    });
}

function pause(loop: Loop, ms: number): Promise<void>
{
    if (loop.stopping || loop.notified || ms <= SHORTEST_PAUSE)
    {
        return Promise.resolve();
    }

    return new Promise((resolve) =>
    {
        const timer = setTimeout(() => loop.wake?.(), ms);

        loop.wake = () =>
        {
            clearTimeout(timer);
            loop.wake = null;
            resolve();
        };
    });
}

/** `offWork(name | { id })`: the loops it names stop after what they are doing; it does not wait for them */
function stopLoops(record: BossWorkers, value: string | { id: string }): void
{
    assert(value, 'Missing required argument');
    assert(typeof value === 'string' || (typeof value === 'object' && value.id),
        'Invalid argument. Expected string or object: { id }');

    [...record.loops.values()]
        .filter((loop) => typeof value === 'string' ? loop.queue === value : loop.id === value.id)
        .forEach(stop);
}

function stop(loop: Loop): void
{
    loop.stopping = true;
    loop.wake?.();
}

function notify(loop: Loop): void
{
    loop.notified = true;
    loop.wake?.();
}

/** As pg-boss's worker reports a failed poll: an `error` event naming the queue and the worker */
function emitError(boss: PgBoss, loop: Loop, error: unknown): void
{
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.message = `${failure.message} (Queue: ${loop.queue}, Worker: ${loop.id})`;

    boss.emit('error', { ...failure, message: failure.message, stack: failure.stack, queue: loop.queue, worker: loop.id });
}

/** Wait until every promise settled or `wait` ms passed */
async function settleWithin(promises: (Promise<unknown> | null)[], wait: number): Promise<void>
{
    let timer: NodeJS.Timeout | undefined;

    try
    {
        await Promise.race([
            Promise.allSettled(promises),
            new Promise((resolve) =>
            {
                timer = setTimeout(resolve, Math.max(0, wait));
            }),
        ]);
    }
    finally
    {
        clearTimeout(timer);
    }
}
