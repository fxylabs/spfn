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
 * judged (`admitBeforeProof`), under the account lock in a transaction of its
 * own that commits before the comparison: a refused account's credential is
 * never compared, and an attempt the app counts there is counted in turn with
 * every other attempt on the account.
 *
 * Every attempt it can name an account or a credential for is told to
 * `settled`, failed ones included, in a transaction of its own that commits
 * before the answer:
 *
 * - a wrong credential checked before any transaction (`password`,
 *   `deletion-cancel`, the proof at `mfa/verify`) is told, under the account
 *   lock, and `admit` asked again there (`recordSignInFailure`), so an attempt
 *   that crossed the app's limit is answered with the refusal; a right
 *   password for an account the package refuses is told and answered the same
 *   way, with the refusal's reason;
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

import { authLogger } from '../logger';
import { usersRepository } from '../repositories';
import type { AdmissionRefusal } from '../lib/admission-refusal';
import type { User } from '../entities/users';
import {
    SIGN_IN_REFUSAL_CODE,
    signInGuard,
    type SignInAdmitCall,
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
 * Ask `admit`, in the caller's transaction.
 *
 * @returns the refusal, or null without a guard or when the attempt may go on
 * @throws Error when `admit` throws, or answers something that is neither nothing nor a refusal
 *   whose code has the shape `SIGN_IN_REFUSAL_CODE` states
 */
export async function admitSignIn(attempt: SignInAttempt, call: SignInAdmitCall): Promise<SignInRefusal | null>
{
    const answer: unknown = await signInGuard()?.admit?.(attempt, call);

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

/** What `admitBeforeProof` answers: the attempt's account as of the lock, and `admit`'s refusal. */
export interface AdmittedBeforeProof
{
    user: User | null;
    refusal: SignInRefusal | null;
}

/**
 * `admit`'s first call, before the credential is compared: in a transaction
 * of its own, under the lock of the attempt's account (`underAccountLock`),
 * committed before this returns. Whatever `admit` wrote commits with its
 * answer, a refusal included, and concurrent attempts on one account take
 * turns here — so an app counting attempts compares no more than its limit.
 * The caller compares the account answered here — the one `admit` was asked
 * about — after the commit, with no lock and no connection held. A throw
 * rolls back what `admit` wrote. Without an `admit` nothing is opened, and the
 * account is the attempt's.
 *
 * @throws Error as `admitSignIn`; AccountBusyError when the lock stays held past its wait
 */
export async function admitBeforeProof(attempt: SignInAttempt): Promise<AdmittedBeforeProof>
{
    if (!signInGuard()?.admit)
    {
        return { user: attempt.user, refusal: null };
    }

    return await underAccountLock(
        attempt,
        async locked => ({ user: locked.user, refusal: await admitSignIn(locked, 'before-proof') }),
        'auth:sign-in-admit',
    );
}

/**
 * The deciding `admit`, in the caller's transaction under the account lock;
 * a refusal is reported (`reportRefusal`) before it is thrown.
 *
 * @throws SignInRefusedError when `admit` refuses the attempt
 */
export async function assertSignInAdmits(attempt: SignInAttempt, keyId?: string): Promise<void>
{
    const refusal = await admitSignIn(attempt, 'deciding');

    if (refusal)
    {
        await reportRefusal(attempt, 'refused', keyId);

        throw new SignInRefusedError({ details: { code: refusal.code } });
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
 * A failure recorded in a transaction of its own, under the lock of the
 * attempt's account (`underAccountLock`), and committed before the caller
 * answers; then `admit` asked again of the account as it stands now. An
 * unknown identifier sends the same lock statement and locks no row: an app
 * counting per identifier makes its write one statement.
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

        return await admitSignIn(locked, 'after-failure');
    }, 'auth:sign-in-failure');
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
 * refused registration) is `user: null`. A report that cannot be written
 * there — the account lock busy past its wait, or `settled` throwing — is
 * logged (`logLostReport`), and the refusal stands. Outside any transaction it
 * is told at once, and a throw answers 500.
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

    const report = () => underAccountLock(
        attempt,
        locked => reportSignIn({ ...locked, result: 'failed', reason, keyId }),
        'auth:sign-in-failure',
    );

    if (getTransactionContext())
    {
        afterOutermostRollback(() => report().catch(error => logLostReport(attempt, reason, keyId, error)));

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

/**
 * The trace of a refusal `settled` was not told: the attempt by channel,
 * stage, reason, account and key, and the error. Nothing the person typed and
 * no address — the line is for finding the attempt, not for replaying it.
 */
function logLostReport(attempt: SignInAttempt, reason: SignInFailureReason, keyId: string | undefined, error: unknown): void
{
    authLogger.service.error('A refused sign-in was not told to signIn.settled; the refusal was answered', error, {
        channel: attempt.channel,
        stage: attempt.stage,
        reason,
        userId: attempt.user ? String(attempt.user.id) : null,
        ...(keyId && { keyId }),
    });
}

/**
 * `work` in a transaction of its own, with the attempt's account as of its
 * lock (`lockedAccountOf`).
 */
async function underAccountLock<T>(
    attempt: SignInAttempt,
    work: (locked: SignInAttempt) => Promise<T>,
    context: string,
): Promise<T>
{
    return await runInTransaction(
        async () => await work({ ...attempt, user: await lockedAccountOf(attempt) }),
        { context },
    );
}

/**
 * Lock the attempt's account. An attempt on an identifier (`password`,
 * `deletion-cancel`) locks by it, the row its account was read by
 * (`lockAccountByEmailOrPhone`): an identifier that names no account sends the
 * statements a known one does, so the work tells neither apart. Any other
 * attempt came from an account it already holds — a challenge, a passkey, a
 * provider's subject — and locks it by id; with none, nothing is locked.
 */
async function lockedAccountOf(attempt: SignInAttempt): Promise<User | null>
{
    if (attempt.identifier)
    {
        return await usersRepository.lockAccountByEmailOrPhone(attempt.identifier.email, attempt.identifier.phone);
    }

    return attempt.user && await usersRepository.lockAccount(attempt.user.id);
}

/**
 * The answer to a credential check that did not pass — a wrong password, an
 * unknown identifier, an account `admit` refused before the comparison, or a
 * right password for an account the package refuses — once the failure is
 * recorded. A refused account is answered the refusal whatever the password
 * was, reported as `refused`; any other failure is recorded as `reason` and
 * answered the refusal only when `admit`, asked again after recording it, now
 * refuses. A right password for a disabled or pending account (`reason`
 * `accountDisabled`, `pendingDeletion`) is recorded and answered exactly as a
 * wrong one: only `settled` learns why.
 *
 * @param attempt null without a guard: the answer is `wrong()`, and nothing is recorded
 */
export async function failedCredentialAnswer(
    attempt: SignInAttempt | null,
    refusal: SignInRefusal | null,
    wrong: () => Error,
    { keyId, reason = 'credential' }: { keyId?: string; reason?: SignInFailureReason } = {},
): Promise<Error>
{
    if (!attempt)
    {
        return wrong();
    }

    if (refusal)
    {
        await reportRefusal(attempt, 'refused', keyId);

        return new SignInRefusedError({ details: { code: refusal.code } });
    }

    const latest = await recordSignInFailure(attempt, reason, keyId);

    return latest ? new SignInRefusedError({ details: { code: latest.code } }) : wrong();
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
