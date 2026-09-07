/**
 * @spfn/auth - Jobs
 *
 * One router carries every job the package owns, because an app may register
 * only one of them: two routers holding the same job name double-register that
 * name against pg-boss instead of overriding it.
 */

import { defineJobRouter } from '@spfn/core/job';
import { createAuthDeletionPurgeJob } from './deletion-purge';
import { linkMailJob } from './link-mail';

export { createAuthDeletionPurgeJob } from './deletion-purge';
export { linkMailJob, linkMailPayloadSchema } from './link-mail';
export type { LinkMailPayload } from './link-mail';

/**
 * Build the auth job router: the account-deletion purge sweep and the link-mail
 * sender.
 *
 * The cron is a parameter because `job(...).cron(expression)` bakes the string in
 * at module-import time, which always happens before `createAuthLifecycle()` runs
 * in the app's own module — so the static `authJobRouter` export below cannot
 * pick up a `deletion.purgeCron` given to the lifecycle. Build the router here,
 * after that call, when the schedule is not the default.
 *
 * @param options.purgeCron - Deletion purge schedule; defaults to daily at 04:00
 */
export function createAuthJobRouter(options?: { purgeCron?: string })
{
    return defineJobRouter({
        deletionPurge: createAuthDeletionPurgeJob(options?.purgeCron),
        linkMail: linkMailJob,
    });
}

/**
 * Default job router — the default purge cron (`0 4 * * *`). Register with
 * `.jobs(authJobRouter)` in `server.config.ts`.
 */
export const authJobRouter = createAuthJobRouter();

/**
 * @deprecated Renamed to `createAuthJobRouter` — the router has carried more than
 * the deletion purge since `auth.link-mail` joined it. Same arguments, same
 * result; register only one auth router either way.
 */
export const createAuthDeletionJobRouter = createAuthJobRouter;
