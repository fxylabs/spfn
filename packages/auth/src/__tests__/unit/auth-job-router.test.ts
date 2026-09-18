/**
 * The auth job router (case table R).
 *
 * An app registers exactly one auth router — two routers carrying the same job
 * name double-register that name against pg-boss instead of overriding it. So
 * every job the package owns has to come out of the same router, and the
 * deprecated `createAuthDeletionJobRouter` has to keep behaving like the one it
 * was renamed from, custom cron included.
 */

import { describe, expect, it } from 'vitest';
import { collectJobs } from '@spfn/core/job';

import { authJobRouter, createAuthDeletionJobRouter, createAuthJobRouter } from '@/server/jobs';

/** Job names a router registers, in declaration order. */
function jobNamesOf(router: Parameters<typeof collectJobs>[0]): string[]
{
    return collectJobs(router).map((job) => job.name);
}

describe('auth job router (case table R)', () =>
{
    it('row R1: authJobRouter collects every job the package owns', () =>
    {
        expect(jobNamesOf(authJobRouter)).toEqual([
            'auth.deletion.purge',
            'auth.oauth2.client-purge',
            'auth.revoke-all-token-purge',
            'auth.mfa.sweep',
            'auth.link-mail',
        ]);
    });

    it('row R1: the default router keeps the documented purge crons', () =>
    {
        const [purge, clientPurge, revokeAllPurge, mfaSweep] = collectJobs(authJobRouter);

        expect(purge.cronExpression).toBe('0 4 * * *');
        expect(purge.name).toBe('auth.deletion.purge');
        expect(clientPurge.cronExpression).toBe('0 5 * * *');
        expect(clientPurge.name).toBe('auth.oauth2.client-purge');
        // An hour apart from the other two, so the three sweeps do not overlap.
        expect(revokeAllPurge.cronExpression).toBe('0 6 * * *');
        expect(revokeAllPurge.name).toBe('auth.revoke-all-token-purge');
        // And an hour after that, keeping the spacing the other three set.
        expect(mfaSweep.cronExpression).toBe('0 7 * * *');
        expect(mfaSweep.name).toBe('auth.mfa.sweep');
    });

    it('row R2: the deprecated alias still takes purgeCron and still carries every job', () =>
    {
        const jobs = collectJobs(createAuthDeletionJobRouter({ purgeCron: '0 3 * * *' }));

        expect(jobs.map((job) => job.name)).toEqual([
            'auth.deletion.purge',
            'auth.oauth2.client-purge',
            'auth.revoke-all-token-purge',
            'auth.mfa.sweep',
            'auth.link-mail',
        ]);
        expect(jobs[0].cronExpression).toBe('0 3 * * *');
    });

    it('row R2: the alias is the renamed function, not a copy of it', () =>
    {
        expect(createAuthDeletionJobRouter).toBe(createAuthJobRouter);
    });

    it('row R2: link mail is not a cron job — it runs when a request enqueues it', () =>
    {
        const [, , , , linkMail] = collectJobs(createAuthJobRouter());

        expect(linkMail.name).toBe('auth.link-mail');
        expect(linkMail.cronExpression).toBeUndefined();
    });
});
