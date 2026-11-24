// src/server/services/sign-in-lock.service.ts
import { runInTransaction } from '@spfn/core/db';
import { usersRepository } from '@spfn/auth/server';
import { signInAttemptsRepository } from '../repositories/sign-in-history.repository';
import { accountIdentifiers } from '../sign-in-policy';

/**
 * An administrator's lift, called from an ops or admin route behind `requireOpsScope` (or a role
 * check). It takes the account's lock before it clears the account's counts, as every sign-in that
 * adds to them holds it: the two take turns, and never take the counts' rows in different orders.
 */
export async function liftSignInLock(userId: number): Promise<void>
{
    await runInTransaction(async () =>
    {
        const user = await usersRepository.lockAccount(userId);

        if (user)
        {
            await signInAttemptsRepository.clear(accountIdentifiers(user));
        }
    });
}
