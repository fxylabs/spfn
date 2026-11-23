/**
 * @spfn/auth - Password-Change Guard
 *
 * Where the application's `passwordChange: { admit, changed }` is asked and
 * told: inside the transaction that writes the new password, under the account
 * lock, on both paths that set a password a person chose and clear
 * `passwordChangeRequired` — `changePasswordService` (`channel: 'change'`) and
 * `completePasswordResetService` (`'reset'`).
 *
 * `admit` is asked once the account is locked and before anything is written;
 * `changed` is told once everything the change writes is written. A refusal is
 * `PasswordChangeRefusedError`; a throw from either is
 * `PasswordChangeHookFailedError`, which keeps nothing of the hook's error but
 * its class and SQLSTATE (`identifyHookError`), the `onPurge` rule. Both
 * propagate out of the transaction and roll it back.
 *
 * Without a guard every function here returns at once.
 */

import { PasswordChangeHookFailedError, PasswordChangeRefusedError } from '@spfn/auth/errors';

import { identifyHookError } from '../lib/hook-error';
import { SIGN_IN_REFUSAL_CODE } from '../lib/sign-in-guard';
import { passwordChangeGuard, type PasswordChangeAttempt } from '../lib/password-change-guard';

/**
 * Ask `admit`. Called under the account lock, before the new password is written.
 *
 * @throws PasswordChangeRefusedError when `admit` refuses the change
 * @throws PasswordChangeHookFailedError when `admit` throws
 * @throws Error when `admit` answers something that is neither nothing nor a
 *   refusal whose code has the shape `SIGN_IN_REFUSAL_CODE` states
 */
export async function assertPasswordChangeAdmits(attempt: PasswordChangeAttempt): Promise<void>
{
    const admit = passwordChangeGuard()?.admit;

    if (!admit)
    {
        return;
    }

    const answer: unknown = await runHook('admit', admit, attempt);

    if (answer === undefined || answer === null)
    {
        return;
    }

    const code = (answer as { refuse?: { code?: unknown } }).refuse?.code;

    if (typeof code !== 'string' || !SIGN_IN_REFUSAL_CODE.test(code))
    {
        throw new Error('passwordChange.admit must answer nothing, or { refuse: { code } } with a code of 1 to 64 letters, '
            + 'digits, `_`, `-` or `.`.');
    }

    throw new PasswordChangeRefusedError({ details: { code } });
}

/**
 * Tell `changed`, in the change's transaction, once everything it writes is written.
 *
 * @throws PasswordChangeHookFailedError when `changed` throws
 */
export async function reportPasswordChanged(attempt: PasswordChangeAttempt): Promise<void>
{
    const changed = passwordChangeGuard()?.changed;

    if (changed)
    {
        await runHook('changed', changed, attempt);
    }
}

/** Run a hook; what it throws comes back as `PasswordChangeHookFailedError`, by identifiers only. */
function runHook<T>(
    hook: 'admit' | 'changed',
    fn: (attempt: PasswordChangeAttempt) => T | Promise<T>,
    attempt: PasswordChangeAttempt,
): Promise<T>
{
    return Promise.resolve(attempt)
        .then(fn)
        .catch((error: unknown) => Promise.reject(new PasswordChangeHookFailedError({
            hook,
            userId: attempt.user.id,
            ...identifyHookError(error),
        })));
}
