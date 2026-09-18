/**
 * @spfn/auth - Revoke-All Link Token Purge Job
 *
 * `key_revoke_all_tokens` gains a row every time an app issues a
 * sign-out-everywhere link, and a row that can no longer answer anything is
 * only storage. This sweep deletes them.
 *
 * Two ages, because the two states stop mattering at different times. An expired
 * row is kept a week, so a support question about a link that was mailed can
 * still be answered from the table. A spent or superseded one is kept a day: the
 * refusal it produces is already indistinguishable from the one an unknown token
 * gets, so after that it is bookkeeping.
 *
 * Registration is NOT automatic, for the reason `deletion-purge.ts` sets out at
 * length: `createAuthLifecycle()`'s `afterInfrastructure` hook runs before
 * `registerJobs` in `@spfn/core`'s startup, so the lifecycle cannot register a
 * job itself. Applications register `authJobRouter`, which carries this one
 * beside the deletion purge, the stale-client sweep and the link mailer.
 */

import { job } from '@spfn/core/job';
import { purgeRevokeAllTokensService } from '../services/revoke-all-link.service';
import { authLogger } from '../logger';

/** Daily at 06:00, an hour after the stale-client sweep so the three do not overlap. */
export const DEFAULT_REVOKE_ALL_TOKEN_PURGE_CRON = '0 6 * * *';

/**
 * Build the `auth.revoke-all-token-purge` job with a given cron schedule.
 *
 * @param cronExpression - Defaults to daily at 06:00
 */
export function createRevokeAllTokenPurgeJob(
    cronExpression: string = DEFAULT_REVOKE_ALL_TOKEN_PURGE_CRON,
)
{
    return job('auth.revoke-all-token-purge')
        .cron(cronExpression)
        .options({ retryLimit: 1 })
        .handler(async () =>
        {
            const { deleted } = await purgeRevokeAllTokensService();

            if (deleted > 0)
            {
                authLogger.service.info('[auth.revoke-all-token-purge] sweep complete', { deleted });
            }
        });
}
