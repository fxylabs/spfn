// src/server/sign-in-policy.ts
import type { SignInAttempt, SignInGuardOptions, User } from '@spfn/auth/server';
import { signInAttemptsRepository, signInHistoryRepository } from './repositories/sign-in-history.repository';
// The app's own record of the temporary passwords it issued.
import { temporaryPasswordsRepository } from './repositories/temporary-passwords.repository';

const LIMIT = 5;

/** An account's own email and phone, the ones it has. */
export function accountIdentifiers(user: User | null): string[]
{
    return [user?.email, user?.phone].filter((value): value is string => Boolean(value));
}

/**
 * The counts an attempt is judged by: the identifier it names, whether or not an account holds it;
 * on a channel that names none, the account's own email and phone.
 */
function countedIdentifiers({ identifier, user }: SignInAttempt): string[]
{
    if (identifier)
    {
        return [identifier.email ? identifier.email.trim().toLowerCase() : identifier.phone!];
    }

    return accountIdentifiers(user);
}

export const signInPolicy: SignInGuardOptions = {
    admit: async (attempt, call) =>
    {
        const identifiers = countedIdentifiers(attempt);

        if (identifiers.length === 0)
        {
            return undefined;
        }

        // Counted before the comparison; every other call only reads the count.
        const attempts = call === 'before-proof'
            ? await signInAttemptsRepository.add(identifiers)
            : await signInAttemptsRepository.count(identifiers);

        if (attempts > LIMIT)
        {
            return { refuse: { code: 'LOCKED' } };
        }

        // An expiring temporary password: the app recorded its expiry when it issued it
        // (with passwordChangeRequired), in a table of its own.
        const { user, channel } = attempt;

        if (channel === 'password' && user?.passwordChangeRequired
            && await temporaryPasswordsRepository.hasExpired(user.id))
        {
            return { refuse: { code: 'TEMPORARY_PASSWORD_EXPIRED' } };
        }

        return undefined;
    },
    settled: async (outcome) =>
    {
        await signInHistoryRepository.record(outcome);

        if (outcome.result === 'succeeded')
        {
            await signInAttemptsRepository.clear(countedIdentifiers(outcome));
        }
    },
};
