/**
 * Job Builder
 *
 * Fluent API for defining jobs, similar to route builder pattern
 */

import type { Static, TSchema } from '@sinclair/typebox';
import type { CompensateHandler, JobDef, JobHandler, JobOptions, JobSendOptions } from './types';
import type { EventDef, InferEventPayload } from '@spfn/core/event';
import { logger } from '@spfn/core/logger';
import { getBoss } from './boss';
import { resolveQueuePolicy, type QueuePolicySource } from './queue-policy';
import { toPgBossRetryOptions } from './retry-options';

const jobLogger = logger.child('@spfn/core:job');

// Job names whose ignored singletonKey has already been reported. A send-time
// key is usually inside a loop, so warning per call would flood the log.
const warnedIgnoredSingletonKeys = new Set<string>();

/**
 * Reset the singletonKey warn-once state
 *
 * @internal test-only
 */
export function resetSingletonKeyWarnings(): void
{
    warnedIgnoredSingletonKeys.clear();
}

/**
 * Warn once when a send-time singletonKey lands on a `standard` queue
 *
 * pg-boss stores the key and never conflicts on it there, so the send is
 * accepted and the deduplication the caller asked for silently does not
 * happen. The policy lives on the definition, not on the send, so the fix is
 * on the definition too.
 */
function warnIfSingletonKeyIgnored(name: string, source: QueuePolicySource): void
{
    if (resolveQueuePolicy(source) !== 'standard' || warnedIgnoredSingletonKeys.has(name))
    {
        return;
    }

    warnedIgnoredSingletonKeys.add(name);

    jobLogger.warn(
        `[Job:${name}] singletonKey ignored: queue policy is "standard"; ` +
        "set .options({ policy: 'exclusive' }) (or another non-standard policy) to deduplicate",
    );
}

/**
 * Build pg-boss options from job defaults and send options
 */
function buildPgBossOptions(
    defaults?: JobOptions,
    sendOptions?: JobSendOptions,
): Record<string, unknown>
{
    const options: Record<string, unknown> = { ...toPgBossRetryOptions(defaults) };

    // Send options (per-job invocation)
    if (sendOptions?.startAfter)
    {
        options.startAfter = sendOptions.startAfter;
    }
    if (sendOptions?.singletonKey)
    {
        options.singletonKey = sendOptions.singletonKey;
    }
    if (sendOptions?.priority !== undefined)
    {
        options.priority = sendOptions.priority;
    }

    // Default options (from job definition)
    if (defaults?.expireInSeconds !== undefined)
    {
        options.expireInSeconds = defaults.expireInSeconds;
    }
    if (defaults?.priority !== undefined && sendOptions?.priority === undefined)
    {
        options.priority = defaults.priority;
    }
    if (defaults?.singletonKey && !sendOptions?.singletonKey)
    {
        options.singletonKey = defaults.singletonKey;
    }
    if (defaults?.retentionSeconds !== undefined)
    {
        options.retentionSeconds = defaults.retentionSeconds;
    }

    return options;
}

/**
 * Job builder class with fluent API
 */
export class JobBuilder<TInput = void, TOutput = void>
{
    private readonly _name: string;
    private _inputSchema?: TSchema;
    private _outputSchema?: TSchema;
    private _cronExpression?: string;
    private _runOnce?: boolean;
    private _subscribedEvent?: string;
    private _subscribedEventDef?: EventDef<any>;
    private _options?: JobOptions;
    private _handler?: JobHandler<TInput, TOutput>;
    private _compensate?: CompensateHandler<TInput, TOutput>;

    constructor(name: string)
    {
        this._name = name;
    }

    /**
     * Define input schema with TypeBox
     */
    input<TSchema extends import('@sinclair/typebox').TSchema>(
        schema: TSchema,
    ): JobBuilder<Static<TSchema>, TOutput>
    {
        const builder = new JobBuilder<Static<TSchema>, TOutput>(this._name);
        builder._inputSchema = schema;
        builder._outputSchema = this._outputSchema;
        builder._cronExpression = this._cronExpression;
        builder._runOnce = this._runOnce;
        builder._subscribedEvent = this._subscribedEvent;
        builder._options = this._options;

        return builder;
    }

    /**
     * Define output schema with TypeBox (for workflow integration)
     */
    output<TSchema extends import('@sinclair/typebox').TSchema>(
        schema: TSchema,
    ): JobBuilder<TInput, Static<TSchema>>
    {
        const builder = new JobBuilder<TInput, Static<TSchema>>(this._name);
        builder._inputSchema = this._inputSchema;
        builder._outputSchema = schema;
        builder._cronExpression = this._cronExpression;
        builder._runOnce = this._runOnce;
        builder._subscribedEvent = this._subscribedEvent;
        builder._options = this._options;

        return builder;
    }

    /**
     * Subscribe to an event (decoupled triggering)
     *
     * @example
     * ```typescript
     * const userCreated = defineEvent('user.created', Type.Object({
     *     userId: Type.String(),
     * }));
     *
     * const sendWelcomeEmail = job('send-welcome-email')
     *     .on(userCreated)
     *     .handler(async (payload) => {
     *         // payload is typed as { userId: string }
     *     });
     * ```
     */
    on<TEvent extends EventDef<any>>(
        event: TEvent,
    ): JobBuilder<InferEventPayload<TEvent>, TOutput>
    {
        const builder = new JobBuilder<InferEventPayload<TEvent>, TOutput>(this._name);
        builder._inputSchema = event.schema;
        builder._outputSchema = this._outputSchema;
        builder._subscribedEvent = event.name;
        builder._subscribedEventDef = event;
        builder._cronExpression = this._cronExpression;
        builder._runOnce = this._runOnce;
        builder._options = this._options;

        return builder;
    }

    /**
     * Set cron expression for scheduled execution
     */
    cron(expression: string): this
    {
        this._cronExpression = expression;

        return this;
    }

    /**
     * Mark job to run once on server start
     */
    runOnce(): this
    {
        this._runOnce = true;

        return this;
    }

    /**
     * Set job options (retry, expiration, etc.)
     */
    options(options: JobOptions): this
    {
        this._options = options;

        return this;
    }

    /**
     * Set job timeout in milliseconds
     * (Converts to expireInSeconds for pg-boss)
     */
    timeout(ms: number): this
    {
        this._options = {
            ...this._options,
            expireInSeconds: Math.ceil(ms / 1000),
        };

        return this;
    }

    /**
     * Define compensate handler for rollback (workflow integration)
     */
    compensate(fn: CompensateHandler<TInput, TOutput>): this
    {
        this._compensate = fn;

        return this;
    }

    /**
     * Define the job handler and finalize the job definition
     */
    handler(fn: JobHandler<TInput, TOutput>): JobDef<TInput, TOutput>
    {
        this._handler = fn;

        const name = this._name;
        const inputSchema = this._inputSchema;
        const outputSchema = this._outputSchema;
        const cronExpression = this._cronExpression;
        const runOnce = this._runOnce;
        const subscribedEvent = this._subscribedEvent;
        const subscribedEventDef = this._subscribedEventDef;
        const options = this._options;
        const handler = this._handler;
        const compensate = this._compensate;

        // Create send function
        const send = async (
            inputOrOptions?: TInput | JobSendOptions,
            maybeOptions?: JobSendOptions,
        ): Promise<string | null> =>
        {
            const boss = getBoss();
            if (!boss)
            {
                throw new Error(
                    `[Job:${name}] pg-boss not initialized. ` +
                    'Ensure jobs are registered with defineServerConfig().jobs()',
                );
            }

            // Determine input and options based on whether job has input schema
            const [input, sendOptions] = inputSchema
                ? [inputOrOptions as TInput, maybeOptions]
                : [undefined, inputOrOptions as JobSendOptions | undefined];

            if (sendOptions?.singletonKey)
            {
                warnIfSingletonKeyIgnored(name, { runOnce, options });
            }

            return await boss.send(
                name,
                input ?? {},
                buildPgBossOptions(options, sendOptions),
            );
        };

        // Create run function (synchronous execution)
        const run = async (input?: TInput): Promise<TOutput> =>
        {
            if (inputSchema)
            {
                return await (handler as (input: TInput) => Promise<TOutput>)(input as TInput);
            }
            else
            {
                return await (handler as () => Promise<TOutput>)();
            }
        };

        // Create sendBatch function (bulk insert via pg-boss)
        const sendBatch = async (
            inputsOrOptions?: TInput[] | JobSendOptions,
            maybeOptions?: JobSendOptions,
        ): Promise<void> =>
        {
            const boss = getBoss();
            if (!boss)
            {
                throw new Error(
                    `[Job:${name}] pg-boss not initialized. ` +
                    'Ensure jobs are registered with defineServerConfig().jobs()',
                );
            }

            const [inputs, sendOptions] = inputSchema
                ? [inputsOrOptions as TInput[], maybeOptions]
                : [undefined, inputsOrOptions as JobSendOptions | undefined];

            if (sendOptions?.singletonKey)
            {
                warnIfSingletonKeyIgnored(name, { runOnce, options });
            }

            const pgBossOptions = buildPgBossOptions(options, sendOptions);

            const jobs = (inputs ?? [{}]).map((data) => ({
                name,
                ...pgBossOptions,
                data: data as object,
            }));

            await boss.insert(name, jobs);
        };

        return {
            name,
            inputSchema,
            outputSchema,
            cronExpression,
            runOnce,
            subscribedEvent,
            _subscribedEventDef: subscribedEventDef,
            options,
            handler,
            compensate,
            send: send as JobDef<TInput, TOutput>['send'],
            sendBatch: sendBatch as JobDef<TInput, TOutput>['sendBatch'],
            run: run as JobDef<TInput, TOutput>['run'],
            _input: undefined as unknown as TInput,
            _output: undefined as unknown as TOutput,
        };
    }
}

/**
 * Create a new job definition
 *
 * @example
 * ```typescript
 * // Simple job without input
 * export const cleanupJob = job('cleanup')
 *     .handler(async () => {
 *         await db.cleanup();
 *     });
 *
 * // Job with typed input
 * export const sendEmailJob = job('send-email')
 *     .input(Type.Object({
 *         to: Type.String(),
 *         subject: Type.String(),
 *         body: Type.String(),
 *     }))
 *     .handler(async (input) => {
 *         await emailService.send(input.to, input.subject, input.body);
 *     });
 *
 * // Cron job
 * export const dailyReportJob = job('daily-report')
 *     .cron('0 9 * * *')
 *     .handler(async () => {
 *         await reportService.generateDaily();
 *     });
 *
 * // Run once on server start
 * export const initCacheJob = job('init-cache')
 *     .runOnce()
 *     .handler(async () => {
 *         await cache.warmup();
 *     });
 *
 * // With options
 * export const importantJob = job('important-task')
 *     .input(Type.Object({ id: Type.String() }))
 *     .options({
 *         retryLimit: 5,
 *         retryDelay: 5000,
 *         priority: 10,
 *     })
 *     .handler(async (input) => {
 *         await processImportant(input.id);
 *     });
 * ```
 */
export function job(name: string): JobBuilder<void>
{
    return new JobBuilder(name);
}
