/**
 * Job System Types
 *
 * Type definitions for the pg-boss based job system
 */

import type { TSchema } from '@sinclair/typebox';

/**
 * pg-boss queue policy
 *
 * The policy decides which unique index pg-boss puts on
 * `(queue name, singletonKey)`, and therefore what `singletonKey` actually
 * deduplicates. A `standard` queue has no such index: the key is stored and
 * ignored.
 *
 * | policy | one job per `(queue, singletonKey)` among states… |
 * |---|---|
 * | `standard` | none — the key is ignored |
 * | `short` | `created` (queued, not yet picked up) |
 * | `singleton` | `active` (running) — many may queue, one runs at a time |
 * | `stately` | one per state among `created`, `retry`, `active` |
 * | `exclusive` | `created` + `retry` + `active` together |
 */
export type JobQueuePolicy = 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive';

/**
 * Job options passed to pg-boss
 */
export interface JobOptions
{
    /**
     * Maximum retry attempts
     * @default 3
     */
    retryLimit?: number;

    /**
     * Delay between retries in milliseconds
     * @default 1000
     */
    retryDelay?: number;

    /**
     * Exponential backoff between retries (retryDelay * 2^attempt). Defaults to
     * true so a failed cohort (e.g. on a provider 429) doesn't all retry at the
     * same fixed offset — a thundering herd. Set false for fixed retryDelay.
     * @default true
     */
    retryBackoff?: boolean;

    /**
     * Job expiration in seconds
     * @default 300 (5 minutes)
     */
    expireInSeconds?: number;

    /**
     * Job priority (higher = more important)
     * @default 0
     */
    priority?: number;

    /**
     * Deduplication key. What it deduplicates depends entirely on `policy`:
     * on a `standard` queue (the default for a plain job) pg-boss stores the
     * key and never conflicts on it, so nothing is deduplicated.
     *
     * Setting this without an explicit `policy` makes the queue `exclusive`.
     */
    singletonKey?: string;

    /**
     * pg-boss queue policy — what `singletonKey` deduplicates on this queue.
     *
     * | policy | one job per `(queue, singletonKey)` among states… |
     * |---|---|
     * | `standard` | none — the key is ignored |
     * | `short` | `created` |
     * | `singleton` | `active` |
     * | `stately` | one per state among `created`, `retry`, `active` |
     * | `exclusive` | `created` + `retry` + `active` together |
     *
     * Deduplication is scoped by queue name: different queues never
     * deduplicate against each other. `exclusive` with no `singletonKey`
     * collapses the whole queue to one pending job, which is why plain jobs
     * stay `standard`.
     *
     * @default 'exclusive' when the job is `.runOnce()` or sets `singletonKey`, otherwise 'standard'
     */
    policy?: JobQueuePolicy;

    /**
     * Keep completed jobs for this many seconds
     * @default 604800 (7 days)
     */
    retentionSeconds?: number;

    /**
     * Number of jobs to fetch per worker poll.
     * When > 1, jobs in each batch are processed in parallel.
     * Failed jobs are individually marked and retried by pg-boss.
     * @default 1
     */
    batchSize?: number;

    /**
     * How often this worker polls the DB for new jobs, in seconds. Lower =
     * faster pickup but more idle SELECT load; higher = less DB chatter but
     * slower pickup. Overrides the JOB_POLLING_INTERVAL_SECONDS default.
     * @default 2 (pg-boss default) or JOB_POLLING_INTERVAL_SECONDS
     */
    pollingIntervalSeconds?: number;
}

/**
 * Send options for individual job dispatch
 */
export interface JobSendOptions
{
    /**
     * Delay execution by this many seconds
     */
    startAfter?: number | Date;

    /**
     * Deduplication key for this specific job instance.
     *
     * Only takes effect when the job's queue has a non-standard `policy`: see
     * {@link JobOptions.policy}. On a `standard` queue pg-boss stores the key
     * and never conflicts on it, and the first such send logs a warning.
     */
    singletonKey?: string;

    /**
     * Priority override
     */
    priority?: number;
}

/**
 * Job handler function type
 *
 * The check is wrapped in a tuple — `[TInput] extends [void]`, not
 * `TInput extends void` — to stop the conditional from distributing. A bare
 * type parameter in the check position makes the conditional distributive, so a
 * union input `A | B | C` is evaluated per member and the results are unioned
 * into three function types whose parameters intersect to `never`: no caller
 * can then pass any member. The tuple makes the union one opaque type, which is
 * what a handler taking `A | B | C` needs. The same wrap is on `send`, `run`
 * and `sendBatch` below, for the same reason. Do not "simplify" it away.
 */
export type JobHandler<TInput, TOutput = void> = [TInput] extends [void]
    ? () => Promise<TOutput>
    : (input: TInput) => Promise<TOutput>;

/**
 * Compensate handler function type (for rollback)
 */
export type CompensateHandler<TInput, TOutput> = (
    input: TInput,
    output: TOutput,
) => Promise<void>;

/**
 * Job definition interface
 */
export interface JobDef<TInput = void, TOutput = void>
{
    /**
     * Unique job name
     */
    readonly name: string;

    /**
     * TypeBox input schema (optional)
     */
    readonly inputSchema?: TSchema;

    /**
     * TypeBox output schema (optional, for workflow integration)
     */
    readonly outputSchema?: TSchema;

    /**
     * Cron expression for scheduled jobs
     */
    readonly cronExpression?: string;

    /**
     * Run once on server start
     */
    readonly runOnce?: boolean;

    /**
     * Event name this job subscribes to
     */
    readonly subscribedEvent?: string;

    /**
     * Event definition this job subscribes to (internal use)
     */
    readonly _subscribedEventDef?: unknown;

    /**
     * Job options
     */
    readonly options?: JobOptions;

    /**
     * Job handler
     */
    readonly handler: JobHandler<TInput, TOutput>;

    /**
     * Compensate handler for rollback (optional, for workflow integration)
     */
    readonly compensate?: CompensateHandler<TInput, TOutput>;

    /**
     * Send job to queue (returns immediately, executes in background)
     */
    send: [TInput] extends [void]
        ? (options?: JobSendOptions) => Promise<string | null>
        : (input: TInput, options?: JobSendOptions) => Promise<string | null>;

    /**
     * Run job synchronously (for testing/debugging)
     */
    run: [TInput] extends [void]
        ? () => Promise<TOutput>
        : (input: TInput) => Promise<TOutput>;

    /**
     * Bulk insert jobs into the queue (pg-boss insert).
     * Much faster than calling send() in a loop.
     * Only available for jobs with input schema.
     */
    sendBatch: [TInput] extends [void]
        ? (options?: JobSendOptions) => Promise<void>
        : (inputs: TInput[], options?: JobSendOptions) => Promise<void>;

    /**
     * Type inference helpers
     */
    _input: TInput;
    _output: TOutput;
}

/**
 * Job router entry - can be a job or nested router
 */
export type JobRouterEntry = JobDef<any, any> | JobRouter<any>;

/**
 * Job router interface
 */
export interface JobRouter<TJobs extends Record<string, JobRouterEntry> = Record<string, JobRouterEntry>>
{
    readonly jobs: TJobs;
    readonly _jobs: TJobs;
}

/**
 * Infer input type from JobDef
 */
export type InferJobInput<TJob> = TJob extends JobDef<infer TInput, any>
    ? TInput
    : never;

/**
 * Infer output type from JobDef
 */
export type InferJobOutput<TJob> = TJob extends JobDef<any, infer TOutput>
    ? TOutput
    : never;
