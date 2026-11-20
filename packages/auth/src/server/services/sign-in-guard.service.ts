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
 * Every attempt it can name an account or a credential for is told to
 * `settled`, failed ones included, in a transaction of its own that commits
 * before the answer:
 *
 * - a wrong credential checked before any transaction (`password`,
 *   `deletion-cancel`, the proof at `mfa/verify`) is told, under the account
 *   lock, and `admit` asked again there (`recordSignInFailure`), so an attempt
 *   that crossed the app's limit is answered with the refusal;
 * - a refusal — by `admit`, or by the package of an account that is not
 *   active — and a passkey assertion that fails for a known credential are
 *   told once the transaction they were decided in, and every one around it,
 *   has rolled back (`reportRefusal`): the session's own writes are gone, the
 *   report is not. `admit` is not asked again.
 *
 * No password is hashed while the lock is held.
 *
 * Without a guard every function here returns at once: nothing is queried,
 * locked or opened.
 */

import { getTransactionContext, onAfterRollback, runInTransaction } from '@spfn/core/db';
import { SignInRefusedError } from '@spfn/auth/errors';

import { usersRepository } from '../repositories';
import type { AdmissionRefusal } from '../lib/admission-refusal';
import type { User } from '../entities/users';
import {
    SIGN_IN_REFUSAL_CODE,
    signInGuard,
    type SignInAttempt,
    type SignInChannel,
    type SignInFailureReason,
    type SignInIdentifier,
    type SignInOutcome,
    type SignInStage,
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
 *   whose code has the shape `SIGN_IN_REFUSAL_CODE` states
 */
export async function admitSignIn(attempt: SignInAttempt): Promise<SignInRefusal | null>
{
    const answer: unknown = await signInGuard()?.admit?.(attempt);

    if (answer === undefined || answer === null)
    {
        return null;
    }

    const code = (answer as { refuse?: { code?: unknown } }).refuse?.code;

    if (typeof code !== 'string' || !SIGN_IN_REFUSAL_CODE.test(code))
    {
        throw new Error('signIn.admit must answer nothing, or { refuse: { code } } with a code of 1 to 64 letters, '
            + 'digits, `_`, `-` or `.`.');
    }

    return { code };
}

/**
 * Ask `admit`, and report a refusal (`reportRefusal`) before throwing it.
 *
 * @throws SignInRefusedError when `admit` refuses the attempt
 */
export async function assertSignInAdmits(attempt: SignInAttempt, keyId?: string): Promise<void>
{
    const refusal = await admitSignIn(attempt);

    if (refusal)
    {
        await reportRefusal(attempt, 'refused', keyId);

        throw new SignInRefusedError({ code: refusal.code });
    }
}

/** Tell `settled` how an attempt ended, in the caller's transaction. */
export async function reportSignIn(outcome: SignInOutcome): Promise<void>
{
    await signInGuard()?.settled?.(outcome);
}

/** The request an attempt came on: what every channel knows before it knows the account. */
export interface SignInRequest
{
    ip?: string;
    userAgent?: string;
    webProxy?: boolean;
}

/** The attempt `user` makes on `channel` from `request`, or null without a guard: nothing to ask or tell. */
export function signInAttempt(
    user: User | null,
    channel: SignInChannel,
    request: SignInRequest,
    more: { stage?: SignInStage; identifier?: SignInIdentifier } = {},
): SignInAttempt | null
{
    return signInGuard() && {
        user,
        channel,
        stage: more.stage ?? 'credential',
        identifier: more.identifier,
        ip: request.ip,
        userAgent: request.userAgent,
        webProxy: request.webProxy === true,
    };
}

/**
 * A failure recorded in a transaction of its own, under the account's lock
 * when there is an account, and committed before the caller answers; then
 * `admit` asked again of the account as it stands now. An unknown identifier
 * has no row to lock: an app counting per identifier makes its write one
 * statement.
 *
 * @returns the refusal `admit` answers once the failure is recorded, or null
 */
export async function recordSignInFailure(
    attempt: SignInAttempt,
    reason: SignInFailureReason,
    keyId?: string,
): Promise<SignInRefusal | null>
{
    return await underAccountLock(attempt, async (locked) =>
    {
        await reportSignIn({ ...locked, result: 'failed', reason, keyId });

        return await admitSignIn(locked);
    });
}

/**
 * A sign-in refused — by `admit`, or by the package for an account that is
 * not active — or a credential that failed inside the transaction that would
 * have started the session, told to `settled` as `failed` with `reason`.
 *
 * Inside a transaction it is told once that transaction and every one around
 * it has rolled back: core runs the outermost transaction's `onAfterRollback`
 * callbacks before its error leaves `runInTransaction` or `Transactional()`, so
 * the report commits before the refusal is answered, on a connection of its
 * own, and nothing of the refused session is in it. The account is read again
 * under its lock there: an account the rolled-back transaction created (a
 * refused registration) is `user: null`. A `settled` that throws there is
 * logged by core, and the refusal stands. Outside any transaction it is told
 * at once, and a throw answers 500.
 *
 * `admit` is not asked again: the attempt is already refused.
 *
 * @param attempt null without a guard: nothing is told
 */
export async function reportRefusal(attempt: SignInAttempt | null, reason: SignInFailureReason, keyId?: string): Promise<void>
{
    if (!attempt)
    {
        return;
    }

    const report = () => underAccountLock(attempt, locked => reportSignIn({ ...locked, result: 'failed', reason, keyId }));

    if (getTransactionContext())
    {
        afterOutermostRollback(report);

        return;
    }

    await report();
}

/**
 * `reportRefusal` for an account the package refused (`accountRefusal`): an
 * account that is disabled or pending deletion. Any other refusal is not the
 * account's, and is not told.
 */
export async function reportAccountRefusal(attempt: SignInAttempt | null, refusal: AdmissionRefusal | null, keyId?: string): Promise<void>
{
    if (refusal?.reason === 'accountDisabled' || refusal?.reason === 'pendingDeletion')
    {
        await reportRefusal(attempt, refusal.reason, keyId);
    }
}

/**
 * A credential check that failed, reported (`reportRefusal`) and rethrown: the
 * `.catch` of a check made inside the session's transaction.
 */
export async function reportedFailure(error: unknown, attempt: SignInAttempt | null, reason: SignInFailureReason, keyId?: string): Promise<never>
{
    await reportRefusal(attempt, reason, keyId);

    throw error;
}

/**
 * Run `work` once the outermost transaction has rolled back. A savepoint's
 * `onAfterRollback` callback runs in its parent's context, and one it
 * registers there belongs to the parent: the callback climbs a frame each time
 * until no transaction is left. If a caller caught the refusal and its
 * transaction committed, nothing is told — the refusal was not the answer.
 */
function afterOutermostRollback(work: () => Promise<unknown>): void
{
    onAfterRollback(async () =>
    {
        if (getTransactionContext())
        {
            afterOutermostRollback(work);

            return;
        }

        await work();
    });
}

/** `work` in a transaction of its own, with the attempt's account as of its lock. */
async function underAccountLock<T>(attempt: SignInAttempt, work: (locked: SignInAttempt) => Promise<T>): Promise<T>
{
    return await runInTransaction(async () =>
    {
        const user = attempt.user && await usersRepository.lockAccount(attempt.user.id);

        return await work({ ...attempt, user });
    }, { context: 'auth:sign-in-failure' });
}

/**
 * The answer to a credential check that did not pass — a wrong password, an
 * unknown identifier, or an account `admit` refused before the comparison —
 * once the failure is recorded. A refused account is answered the refusal
 * whatever the password was, reported as `refused`; any other failure is
 * recorded as `credential` and answered the refusal only when `admit`, asked
 * again after recording it, now refuses.
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

    if (refusal)
    {
        await reportRefusal(attempt, 'refused', keyId);

        return new SignInRefusedError({ code: refusal.code });
    }

    const latest = await recordSignInFailure(attempt, 'credential', keyId);

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
