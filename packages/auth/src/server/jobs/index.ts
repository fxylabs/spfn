/**
 * @spfn/auth - Jobs
 *
 * One router carries every job the package owns, because an app may register
 * only one of them: two routers holding the same job name double-register that
 * name against pg-boss instead of overriding it.
 */

import { defineJobRouter } from '@spfn/core/job';
import { createAuthDeletionPurgeJob } from './deletion-purge';
import { createOAuth2ClientPurgeJob } from './oauth2-client-purge';
import { createRevokeAllTokenPurgeJob } from './revoke-all-token-purge';
import { createMfaSweepJob } from './mfa-sweep';
import { linkMailJob } from './link-mail';

export { createAuthDeletionPurgeJob } from './deletion-purge';
export { createOAuth2ClientPurgeJob, DEFAULT_OAUTH2_CLIENT_PURGE_CRON } from './oauth2-client-purge';
export { createRevokeAllTokenPurgeJob, DEFAULT_REVOKE_ALL_TOKEN_PURGE_CRON } from './revoke-all-token-purge';
export { createMfaSweepJob, DEFAULT_MFA_SWEEP_CRON } from './mfa-sweep';
export { linkMailJob, linkMailPayloadSchema } from './link-mail';
export type { LinkMailPayload } from './link-mail';

/**
 * Build the auth job router: the account-deletion purge sweep, the OAuth 2.1
 * stale-client sweep, the sign-out-everywhere link sweep, the abandoned
 * second-factor enrolment sweep, and the link-mail sender.
 *
 * The cron is a parameter because `job(...).cron(expression)` bakes the string in
 * at module-import time, which always happens before `createAuthLifecycle()` runs
 * in the app's own module — so the static `authJobRouter` export below cannot
 * pick up a `deletion.purgeCron` given to the lifecycle. Build the router here,
 * after that call, when the schedule is not the default.
 *
 * @param options.purgeCron - Deletion purge schedule; defaults to daily at 04:00
 * @param options.oauth2ClientPurgeCron - Stale OAuth client sweep; defaults to daily at 05:00
 * @param options.revokeAllTokenPurgeCron - Sign-out-everywhere link sweep; defaults to daily at 06:00
 * @param options.mfaSweepCron - Abandoned second-factor enrolment sweep; defaults to daily at 07:00
 */
export function createAuthJobRouter(options?: {
    purgeCron?: string;
    oauth2ClientPurgeCron?: string;
    revokeAllTokenPurgeCron?: string;
    mfaSweepCron?: string;
})
{
    return defineJobRouter({
        deletionPurge: createAuthDeletionPurgeJob(options?.purgeCron),
        oauth2ClientPurge: createOAuth2ClientPurgeJob(options?.oauth2ClientPurgeCron),
        revokeAllTokenPurge: createRevokeAllTokenPurgeJob(options?.revokeAllTokenPurgeCron),
        mfaSweep: createMfaSweepJob(options?.mfaSweepCron),
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
