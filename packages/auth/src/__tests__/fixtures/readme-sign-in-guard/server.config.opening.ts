// The worked example below, shortened: its server.config.ts with the policy written in. An attempt
// is counted by the identifier it names, whether or not an account holds it — a guard that let
// `user: null` through would answer a locked account 403 and an unknown one 401.
import { createAuthLifecycle } from '@spfn/auth/server';
import { signInAttemptsRepository, signInHistoryRepository } from './src/server/repositories/sign-in-history.repository';
import { countedIdentifiers } from './src/server/sign-in-policy';

export const authLifecycle = createAuthLifecycle({
    signIn: {
        admit: async (attempt, call) =>
        {
            const identifiers = countedIdentifiers(attempt);

            if (identifiers.length === 0)
            {
                return undefined;
            }

            const attempts = call === 'before-proof'
                ? await signInAttemptsRepository.add(identifiers)
                : await signInAttemptsRepository.count(identifiers);

            return attempts > 5 ? { refuse: { code: 'LOCKED' } } : undefined;
        },
        settled: async (outcome) =>
        {
            await signInHistoryRepository.record(outcome);

            if (outcome.result === 'succeeded')
            {
                await signInAttemptsRepository.clear(countedIdentifiers(outcome));
            }
        },
    },
});
