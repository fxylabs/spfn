/**
 * @spfn/auth - Sign-In Guard
 *
 * Where the application's `signIn: { admit, settled }` is asked and told.
 *
 * `admit` decides at the two places a key becomes usable: the minting funnel
 * (`registerPublicKeyService` → `lockAdmittedAccount`), under the account lock
 * in the session's transaction, and the second-factor completion in
 * `mfa/verify`. A channel that checks a password for an identifier (`password`,
 * `deletion-cancel`) and `mfa/verify` also ask it once before the proof is
 * judged, so a refused account's credential is never compared.
 *
 * A failure is told to `settled` in a transaction of its own, under the
 * account lock, committed before the refusal is answered — the shape of
 * `refuseProof` in `mfa.service.ts`, which calls `settleFailure` from its own
 * — and `admit` is asked again there, so an attempt that crossed the app's
 * limit is answered with the refusal. No password is hashed while the lock is
 * held.
 *
 * Without a guard every function here returns at once: nothing is queried,
 * locked or opened.
 */

import { getTransactionContext, runInTransaction } from '@spfn/core/db';
import { SignInRefusedError } from '@spfn/auth/errors';

import { usersRepository } from '../repositories';
import {
    signInGuard,
    type SignInAttempt,
    type SignInFailureReason,
    type SignInOutcome,
} from '../lib/sign-in-guard';

/** A refusal `admit` answered, with the app's code for the client. */
export interface SignInRefusal
{
    code: string;
}

/**
 * Ask `admit`.
 *
 * @returns the refusal, or null without a guard or when the attempt may go on
 * @throws Error when `admit` throws, or answers something that is neither nothing nor a refusal
 */
export async function admitSignIn(attempt: SignInAttempt): Promise<SignInRefusal | null>
{
    const answer: unknown = await signInGuard()?.admit?.(attempt);

    if (answer === undefined || answer === null)
    {
        return null;
    }

    const code = (answer as { refuse?: { code?: unknown } }).refuse?.code;

    if (typeof code !== 'string' || code.length === 0)
    {
        throw new Error('signIn.admit must answer nothing, or { refuse: { code } } with a non-empty string code.');
    }

    return { code };
}

/** @throws SignInRefusedError when `admit` refuses the attempt */
export async function assertSignInAdmits(attempt: SignInAttempt): Promise<void>
{
    const refusal = await admitSignIn(attempt);

    if (refusal)
    {
        throw new SignInRefusedError({ code: refusal.code });
    }
}

/** Tell `settled` how an attempt ended, in the caller's transaction. */
export async function reportSignIn(outcome: SignInOutcome): Promise<void>
{
    await signInGuard()?.settled?.(outcome);
}

/**
 * A failure, told to `settled` under the account lock the caller's transaction
 * holds, then `admit` asked again of the account as it stands now.
 *
 * @returns the refusal `admit` answers now, or null
 */
export async function settleFailure(
    attempt: SignInAttempt,
    reason: SignInFailureReason,
    keyId?: string,
): Promise<SignInRefusal | null>
{
    await reportSignIn({ ...attempt, result: 'failed', reason, keyId });

    return await admitSignIn(attempt);
}

/**
 * A failure recorded in a transaction of its own, under the account's lock
 * when there is an account, and committed before the caller answers. An
 * unknown identifier has no row to lock: an app counting per identifier makes
 * its write one statement.
 *
 * @returns the refusal `admit` answers once the failure is recorded, or null
 */
export async function recordSignInFailure(
    attempt: SignInAttempt,
    reason: SignInFailureReason,
    keyId?: string,
): Promise<SignInRefusal | null>
{
    return await runInTransaction(async () =>
    {
        const user = attempt.user && await usersRepository.lockAccount(attempt.user.id);

        return await settleFailure({ ...attempt, user }, reason, keyId);
    }, { context: 'auth:sign-in-failure' });
}

/**
 * The answer to a credential check that did not pass — a wrong password, an
 * unknown identifier, or an account `admit` refused before the comparison —
 * once the failure is recorded. A refused account is answered the refusal
 * whatever the password was; any other failure is answered the refusal only
 * when `admit`, asked again after recording it, now refuses.
 *
 * @param attempt null without a guard: the answer is `wrong()`, and nothing is recorded
 */
export async function failedCredentialAnswer(
    attempt: SignInAttempt | null,
    refusal: SignInRefusal | null,
    wrong: () => Error,
    keyId?: string,
): Promise<Error>
{
    if (!attempt)
    {
        return wrong();
    }

    const latest = await recordSignInFailure(attempt, refusal ? 'refused' : 'credential', keyId) ?? refusal;

    return latest ? new SignInRefusedError({ code: latest.code }) : wrong();
}

/**
 * A service that records failures owns its transactions, as
 * `checkSecondFactorProof` does: inside a caller's, the failure `settled` was
 * told would roll back with the refusal. Asked only with a guard, so an app
 * without one calls these services as it always did.
 *
 * @throws Error when a guard is configured and the caller holds a transaction
 */
export function assertOwnsTransactions(service: string): void
{
    if (signInGuard() && getTransactionContext())
    {
        throw new Error(`${service} ran inside a transaction while signIn is configured: the failure it records `
            + 'would roll back with the refusal. Call it outside one; it opens its own.');
    }
}
