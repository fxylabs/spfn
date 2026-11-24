/**
 * Password-Change Guard
 *
 * The application's seat inside a password change —
 * `createAuthLifecycle({ passwordChange: { admit, changed } })`, set once and
 * read at request time, as `sign-in-guard.ts` is.
 *
 * With nothing stated there is no guard (`passwordChangeGuard()` answers null),
 * and the change runs as it did: no call, query or lock more.
 *
 * Where it is asked, and why there, is `services/password-change-guard.service.ts`.
 */

import type { User } from '../entities/users';

import { optionKeys, readOptions } from '@spfn/core/options';

/**
 * How the person set the password:
 *
 * - `change` — `PUT /_auth/password`, from a session that proved itself
 *   (`changePasswordService`), a first password on an account that had none
 *   included;
 * - `reset` — a completed reset link (`completePasswordResetService`): whoever
 *   holds the mailbox, with no session.
 *
 * Both clear `passwordChangeRequired`, so a guard that skipped either would
 * let a flagged account through the other.
 */
export type PasswordChangeChannel = 'change' | 'reset';

/** One password change, as `admit` and `changed` see it. */
export interface PasswordChangeAttempt
{
    /** The account as read under its lock, before the new password is written. */
    user: User;
    /** Whether this change answers `passwordChangeRequired`: the account carried the flag. */
    required: boolean;
    channel: PasswordChangeChannel;
}

/**
 * `admit`'s answer: nothing to let the change through, or the refusal and its
 * code for the client — the shape `SIGN_IN_REFUSAL_CODE` states. Any other
 * answer is refused as a malformed one: 500, nothing written.
 */
export type PasswordChangeAdmission = void | undefined | { refuse: { code: string } };

/**
 * `createAuthLifecycle({ passwordChange })`. Both optional.
 *
 * Both run in the change's transaction, under the account's lock, and an app
 * repository extending `BaseRepository` joins it: a write there commits with
 * the change or rolls back with it. Database work only, and fast — every other
 * writer of the account waits on it. Never open a `requiresNew` transaction
 * that touches the account, and never lock a second account. The README's
 * "The password-change guard" has the table.
 */
export interface PasswordChangeGuardOptions
{
    /**
     * Whether this change may be made, before the new password is written.
     * A refusal is 403 `PasswordChangeRefusedError` with the code; a throw is
     * 500 `PasswordChangeHookFailedError`. Either way nothing is written.
     */
    admit?: (attempt: PasswordChangeAttempt) => PasswordChangeAdmission | Promise<PasswordChangeAdmission>;
    /**
     * The change is written, every session it ends is ended: the app's own
     * rows follow it. A throw rolls the change back and answers 500
     * `PasswordChangeHookFailedError`.
     */
    changed?: (attempt: PasswordChangeAttempt) => void | Promise<void>;
}

const OPTION_KEYS = optionKeys<PasswordChangeGuardOptions>({ admit: true, changed: true });

let guard: PasswordChangeGuardOptions | null = null;

/** Why boot must be refused, once two calls stated different guards. */
let contradiction: string | null = null;

/**
 * Set the guard. Called synchronously from `createAuthLifecycle()`, so it is
 * in force before any handler can run.
 *
 * The rule `configureSignIn` follows: a call that states nothing leaves the
 * guard as it is, and a call that states different functions than an earlier
 * call — compared by identity — is a contradiction refused at boot by
 * `assertPasswordChangeGuardConsistent`, the first statement staying in force.
 *
 * @throws Error on an unknown key, or a value that is not a function
 */
export function configurePasswordChange(options: PasswordChangeGuardOptions | undefined): void
{
    if (options === undefined)
    {
        return;
    }

    const read = readGuard(options);

    if (guard === null)
    {
        guard = read;

        return;
    }

    const differing = OPTION_KEYS.filter(key => guard![key] !== read[key]);

    if (differing.length > 0 && contradiction === null)
    {
        contradiction = `createAuthLifecycle() was given different passwordChange options in two calls: ${differing.join(', ')}. `
            + 'State them once, or the same functions in every call. Until then the first ones stay in force.';
    }
}

/** `options` read once, by `readOptions`: the snapshot is what is checked, compared and kept (#477). */
function readGuard(options: PasswordChangeGuardOptions): PasswordChangeGuardOptions
{
    const read = readOptions<PasswordChangeGuardOptions>('passwordChange', options, OPTION_KEYS);

    for (const key of OPTION_KEYS)
    {
        const value: unknown = read[key];

        if (value !== undefined && typeof value !== 'function')
        {
            throw new Error(`passwordChange.${key} must be a function, received ${String(value)}.`);
        }
    }

    return { admit: read.admit, changed: read.changed };
}

/**
 * Refuse boot when two `createAuthLifecycle()` calls stated different guards.
 * Called from `afterInfrastructure`, beside `assertSignInGuardConsistent`.
 */
export function assertPasswordChangeGuardConsistent(): void
{
    if (contradiction !== null)
    {
        throw new Error(contradiction);
    }
}

/** The guard the application stated, or null — and with null, nothing is asked or told. */
export function passwordChangeGuard(): PasswordChangeGuardOptions | null
{
    return guard;
}

/** Test-only: no guard, no contradiction. */
export function resetPasswordChangeGuardForTests(): void
{
    guard = null;
    contradiction = null;
}
