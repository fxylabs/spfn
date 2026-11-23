/**
 * Job Module
 *
 * pg-boss based background job system
 *
 * @example
 * ```typescript
 * import { job, defineJobRouter } from '@spfn/core/job';
 * import { defineEvent } from '@spfn/core/event';
 * import { Type } from '@sinclair/typebox';
 *
 * // Define a job with typed input
 * export const sendWelcomeEmail = job('send-welcome-email')
 *     .input(Type.Object({
 *         userId: Type.String(),
 *     }))
 *     .options({ retryLimit: 3 })
 *     .handler(async (input) => {
 *         const user = await userRepo.findById(input.userId);
 *         await emailService.send(user.email, 'Welcome!');
 *     });
 *
 * // Define a cron job
 * export const dailyReport = job('daily-report')
 *     .cron('0 9 * * *')
 *     .handler(async () => {
 *         await reportService.generateDaily();
 *     });
 *
 * // Define a job that runs once on server start
 * export const initCache = job('init-cache')
 *     .runOnce()
 *     .handler(async () => {
 *         await cache.warmup();
 *     });
 *
 * // Event-based triggering (decoupled)
 * export const userCreated = defineEvent('user.created', Type.Object({
 *     userId: Type.String(),
 * }));
 *
 * export const onUserCreated = job('on-user-created')
 *     .on(userCreated)  // Subscribe to event
 *     .handler(async (payload) => {
 *         // payload is typed as { userId: string }
 *         await notifyTeam(payload.userId);
 *     });
 *
 * // Create job router
 * export const jobRouter = defineJobRouter({
 *     sendWelcomeEmail,
 *     dailyReport,
 *     initCache,
 *     onUserCreated,
 * });
 *
 * // Register in server config
 * defineServerConfig()
 *     .routes(appRouter)
 *     .jobs(jobRouter)
 *     .build();
 *
 * // Trigger a job directly
 * await sendWelcomeEmail.send({ userId: '123' });
 *
 * // Emit event (triggers all subscribed jobs)
 * await userCreated.emit({ userId: '123' });
 * ```
 */

// Types
export type {
    JobDef,
    JobRouter,
    JobRouterEntry,
    JobOptions,
    JobQueuePolicy,
    JobSendOptions,
    JobHandler,
    CompensateHandler,
    InferJobInput,
    InferJobOutput,
} from './types';

// Builder
export { job } from './job-builder';

// Router
export { defineJobRouter, mergeJobRouters, isJobDef, isJobRouter, collectJobs } from './job-router';

// Queue policy
export { resolveQueuePolicy } from './queue-policy';

// Boss (pg-boss wrapper)
export {
    initBoss,
    getBoss,
    stopBoss,
    stopFetching,
    isBossRunning,
    shouldClearOnStart,
    type BossOptions,
    type BossConfig,
} from './boss';

// Registration
export { registerJobs } from './register-jobs';

// Queue schema: its version, install and migration SQL, and catalog state
export {
    JobQueueSchemaError,
    QUEUE_SCHEMA_VERSION,
    QueueSchemaChangedError,
    QueueSchemaNameError,
    QueueSchemaVersionError,
    queueInstallSql,
    queueMigrationSql,
    readQueueSchemaState,
    type QueueSchemaState,
    type QueueSchemaStep,
} from './queue-schema';
export { isQueueSchemaRace } from './queue-schema-race';

// Boot rule: how pg-boss starts on the queue schema, or why it does not
export {
    ownsQueue,
    queueStart,
    type QueueStart,
} from './queue-start';
