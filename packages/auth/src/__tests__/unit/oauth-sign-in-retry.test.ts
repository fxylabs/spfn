/**
 * retryContendedSignIn — which failures mean "the premise was stale" (PR #314 review round 2)
 *
 * A unique violation on one of the sign-in's premise constraints, named by the
 * driver error, runs the attempt once more; a second answers the typed 409.
 * Any other constraint, an error whose message merely names one, and a refusal
 * are answered as they are, on the first attempt. The rows that race a real
 * database are in integration/oauth-sign-in-race.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../server/repositories', () => ({
    usersRepository: {},
    socialAccountsRepository: {},
    userProfilesRepository: {},
}));

import { retryContendedSignIn } from '../../server/services/oauth.service';
import { AccountDisabledError, OAuthSignInContendedError } from '@spfn/auth/errors';

/** What postgres.js raises for a unique violation, wrapped as drizzle hands it on. */
function uniqueViolation(constraint: string): Error
{
    const driverError = Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
        code: '23505',
        constraint_name: constraint,
    });

    return new Error('Failed query: insert into "spfn_auth"."users" ...', { cause: driverError });
}

describe('retryContendedSignIn', () =>
{
    it('runs again after a violation of users_email_unique, and answers the second attempt', async () =>
    {
        const attempt = vi.fn()
            .mockRejectedValueOnce(uniqueViolation('users_email_unique'))
            .mockResolvedValueOnce('signed in');

        await expect(retryContendedSignIn('google', attempt)).resolves.toBe('signed in');
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it('answers a second premise violation with OAuthSignInContendedError', async () =>
    {
        const attempt = vi.fn()
            .mockRejectedValueOnce(uniqueViolation('provider_user_unique_idx'))
            .mockRejectedValueOnce(uniqueViolation('users_email_unique'));

        const signIn = retryContendedSignIn('google', attempt);

        await expect(signIn).rejects.toBeInstanceOf(OAuthSignInContendedError);
        await expect(signIn).rejects.toMatchObject({ details: { provider: 'google' } });
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it('reads the constraint where pg names it, as well as postgres.js', async () =>
    {
        const driverError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
            code: '23505',
            constraint: 'users_email_unique',
        });
        const attempt = vi.fn()
            .mockRejectedValueOnce(new Error('Failed query: insert into "spfn_auth"."users" ...', { cause: driverError }))
            .mockResolvedValueOnce('signed in');

        await expect(retryContendedSignIn('google', attempt)).resolves.toBe('signed in');
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    it('lets a violation of any other constraint through, unretried', async () =>
    {
        const violation = uniqueViolation('user_public_keys_key_id_unique');
        const attempt = vi.fn().mockRejectedValue(violation);

        await expect(retryContendedSignIn('google', attempt)).rejects.toBe(violation);
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('reads the constraint name, not the message', async () =>
    {
        const lookalike = new Error('duplicate key value violates unique constraint "users_email_unique"');
        const attempt = vi.fn().mockRejectedValue(lookalike);

        await expect(retryContendedSignIn('google', attempt)).rejects.toBe(lookalike);
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    it('never runs a refusal again', async () =>
    {
        const refusal = new AccountDisabledError({ status: 'suspended' });
        const attempt = vi.fn().mockRejectedValue(refusal);

        await expect(retryContendedSignIn('google', attempt)).rejects.toBe(refusal);
        expect(attempt).toHaveBeenCalledTimes(1);
    });
});
