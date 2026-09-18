/**
 * @spfn/auth - OAuth 2.1 Stale Client Purge Job
 *
 * `POST /_auth/oauth2/register` is unauthenticated — it has to be, since a CLI
 * has nothing to authenticate with until a user approves it — so the table fills
 * with rows from installs that were abandoned at the consent screen, and with
 * whatever anybody else felt like writing. This sweep deletes the ones that were
 * never approved and are more than a day old.
 *
 * A client with a grant against it is never touched, whatever its age. That is
 * somebody's connected CLI, and the grant is what says so.
 *
 * Registration is NOT automatic, for the reason `deletion-purge.ts` sets out at
 * length: `createAuthLifecycle()`'s `afterInfrastructure` hook runs before
 * `registerJobs` in `@spfn/core`'s startup, so the lifecycle cannot register a
 * job itself. Applications register `authJobRouter`, which carries this one
 * beside the deletion purge and the link mailer.
 */

import { job } from '@spfn/core/job';
import { purgeStaleOAuth2ClientsService } from '../services/oauth2-client.service';
import { authLogger } from '../logger';

/** Daily at 05:00, an hour after the deletion purge so the two do not overlap. */
export const DEFAULT_OAUTH2_CLIENT_PURGE_CRON = '0 5 * * *';

/**
 * Build the `auth.oauth2.client-purge` job with a given cron schedule.
 *
 * @param cronExpression - Defaults to daily at 05:00
 */
export function createOAuth2ClientPurgeJob(
    cronExpression: string = DEFAULT_OAUTH2_CLIENT_PURGE_CRON,
)
{
    return job('auth.oauth2.client-purge')
        .cron(cronExpression)
        .options({ retryLimit: 1 })
        .handler(async () =>
        {
            const { deleted } = await purgeStaleOAuth2ClientsService();

            if (deleted > 0)
            {
                authLogger.service.info('[auth.oauth2.client-purge] sweep complete', { deleted });
            }
        });
}
