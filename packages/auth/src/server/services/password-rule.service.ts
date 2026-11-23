/**
 * @spfn/auth - Password Rule
 *
 * Where the application's `password: { validate }` is asked: on every path
 * that writes a password hash, before the hash is computed and before any
 * transaction opens — the rule may wait on anything (a breached-password
 * lookup), and nothing locked or open should wait with it. A path that must
 * claim something reads it unlocked to name the subject, asks, and carries the
 * `AdmittedPassword` into the transaction that claims and hashes. The hash
 * `usersRepository` writes is an `AdmittedPasswordHash`, and the only ways to
 * make one are here — from a password the rule accepted, or by re-encoding the
 * password a sign-in has just proven — so a writer that skips the rule does
 * not compile.
 *
 * A refusal is a 400 `ValidationError` whose `fields` carry the app's messages
 * on the password field, the shape and message (`Invalid request body`, from
 * core's `invalidInputMessage`) a TypeBox failure of the same body has, but
 * without `value`: nothing about the password is answered, logged or
 * published. A throw is `PasswordRuleFailedError` (500), which keeps nothing
 * of what was thrown but its class and SQLSTATE (`identifyHookError`).
 *
 * Without a rule, `admitNewPassword` asks nothing and builds no subject.
 */

import { ValidationError } from '@spfn/core/errors';
import { invalidInputMessage, REQUEST_BODY } from '@spfn/core/route';
import { PasswordRuleFailedError } from '@spfn/auth/errors';

import { hashPassword } from '../helpers';
import { identifyHookError } from '../lib/hook-error';
import {
    passwordRule,
    type AdmittedPassword,
    type AdmittedPasswordHash,
    type PasswordRuleSubject,
} from '../lib/password-rule';

/**
 * Ask the rule about a new password.
 *
 * `subject` is a function so that a path which must read the account to name
 * it (`change`) reads it only when there is a rule to ask.
 *
 * @param field - the body field the password came in, as a JSON pointer (`/newPassword`)
 * @throws ValidationError when the rule refuses: one field error per message, on `field`
 * @throws PasswordRuleFailedError when the rule throws
 * @throws Error when the rule answers something other than nothing or an array of strings
 */
export async function admitNewPassword(
    password: string,
    field: string,
    subject: () => PasswordRuleSubject | Promise<PasswordRuleSubject>,
): Promise<AdmittedPassword>
{
    const validate = passwordRule()?.validate;

    if (validate)
    {
        const asked = await subject();

        assertAccepted(await Promise.resolve()
            .then(() => validate(password, asked))
            .catch((error: unknown) => Promise.reject(new PasswordRuleFailedError({
                channel: asked.channel,
                ...identifyHookError(error),
            }))), field);
    }

    return password as AdmittedPassword;
}

function assertAccepted(answer: unknown, field: string): void
{
    if (answer === undefined || answer === null)
    {
        return;
    }

    if (!Array.isArray(answer) || answer.some(message => typeof message !== 'string'))
    {
        throw new Error('password.validate must answer nothing, or an array of messages (strings).');
    }

    if (answer.length > 0)
    {
        throw new ValidationError({
            message: invalidInputMessage(REQUEST_BODY),
            fields: answer.map((message: string) => ({ path: field, message })),
        });
    }
}

/** Hash a password the rule accepted: the slow step, so each path decides where it runs. */
export async function hashAdmittedPassword(password: AdmittedPassword): Promise<AdmittedPasswordHash>
{
    return await hashPassword(password) as AdmittedPasswordHash;
}

/**
 * Re-encode the password a sign-in has just proven against the stored hash. It
 * is the account's current password, not a new one, so the rule is not asked:
 * refusing would not change the password, only keep it under the legacy hash.
 */
export async function reencodeProvenPassword(password: string): Promise<AdmittedPasswordHash>
{
    return await hashPassword(password) as AdmittedPasswordHash;
}

/**
 * The rule, then the hash: what the app's own code calls to write a password
 * through `usersRepository` or `updateUserService` — an operator setting a
 * temporary password, an import. `subject.channel` defaults to `operator`.
 * Call it before opening a transaction, as the package's own paths ask the
 * rule: the rule may wait on anything, and the transaction would wait with it.
 *
 * @throws ValidationError when the rule refuses, the messages on `/password`
 * @throws PasswordRuleFailedError when the rule throws
 *
 * @example
 * ```typescript
 * await updateUserService(user.id, {
 *     passwordHash: await hashNewPassword(temporaryPassword, { userId: user.id, email: user.email }),
 *     passwordChangeRequired: true,
 * });
 * ```
 */
export async function hashNewPassword(
    password: string,
    subject: Partial<PasswordRuleSubject> = {},
): Promise<AdmittedPasswordHash>
{
    return await hashAdmittedPassword(await admitNewPassword(password, '/password', () => ({
        channel: subject.channel ?? 'operator',
        userId: subject.userId ?? null,
        email: subject.email ?? null,
        phone: subject.phone ?? null,
    })));
}
