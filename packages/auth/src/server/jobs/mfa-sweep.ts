/**
 * @spfn/auth - Second Factor Sweep Job
 *
 * `POST /_auth/mfa/totp/enroll` mints a secret and parks it unconfirmed, and
 * most people who abandon an enrolment abandon it at the "scan this" screen.
 * Those rows gate nothing, but a TOTP secret sitting in a table doing nothing is
 * a credential nobody is watching, so this deletes the ones still unconfirmed a
 * day later.
 *
 * A confirmed row is never touched, whatever its age. That is somebody's second
 * factor.
 *
 * Registration is NOT automatic, for the reason `deletion-purge.ts` sets out at
 * length: `createAuthLifecycle()`'s `afterInfrastructure` hook runs before
 * `registerJobs` in `@spfn/core`'s startup, so the lifecycle cannot register a
 * job itself. Applications register `authJobRouter`, which carries this one
 * beside the other sweeps.
 */

import { job } from '@spfn/core/job';
import { sweepUnconfirmedMfaService } from '../services/mfa.service';
import { authLogger } from '../logger';

/** Daily at 07:00, an hour after the sign-out-everywhere link sweep. */
export const DEFAULT_MFA_SWEEP_CRON = '0 7 * * *';

/**
 * Build the `auth.mfa.sweep` job with a given cron schedule.
 *
 * @param cronExpression - Defaults to daily at 07:00
 */
export function createMfaSweepJob(cronExpression: string = DEFAULT_MFA_SWEEP_CRON)
{
    return job('auth.mfa.sweep')
        .cron(cronExpression)
        .options({ retryLimit: 1 })
        .handler(async () =>
        {
            const { deleted } = await sweepUnconfirmedMfaService();

            if (deleted > 0)
            {
                authLogger.service.info('[auth.mfa.sweep] sweep complete', { deleted });
            }
        });
}
