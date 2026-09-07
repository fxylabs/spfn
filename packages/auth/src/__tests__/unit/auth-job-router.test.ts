/**
 * The auth job router (case table R).
 *
 * An app registers exactly one auth router — two routers carrying the same job
 * name double-register that name against pg-boss instead of overriding it. So
 * both jobs the package owns have to come out of the same router, and the
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
    it('row R1: authJobRouter collects the purge sweep and the link mailer', () =>
    {
        expect(jobNamesOf(authJobRouter)).toEqual(['auth.deletion.purge', 'auth.link-mail']);
    });

    it('row R1: the default router keeps the documented purge cron', () =>
    {
        const [purge] = collectJobs(authJobRouter);

        expect(purge.cronExpression).toBe('0 4 * * *');
        expect(purge.name).toBe('auth.deletion.purge');
    });

    it('row R2: the deprecated alias still takes purgeCron and still carries both jobs', () =>
    {
        const jobs = collectJobs(createAuthDeletionJobRouter({ purgeCron: '0 3 * * *' }));

        expect(jobs.map((job) => job.name)).toEqual(['auth.deletion.purge', 'auth.link-mail']);
        expect(jobs[0].cronExpression).toBe('0 3 * * *');
    });

    it('row R2: the alias is the renamed function, not a copy of it', () =>
    {
        expect(createAuthDeletionJobRouter).toBe(createAuthJobRouter);
    });

    it('row R2: link mail is not a cron job — it runs when a request enqueues it', () =>
    {
        const [, linkMail] = collectJobs(createAuthJobRouter());

        expect(linkMail.name).toBe('auth.link-mail');
        expect(linkMail.cronExpression).toBeUndefined();
    });
});
