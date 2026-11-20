/**
 * Sign-In Guard
 *
 * The application's say over who signs in, and its record of every attempt —
 * `createAuthLifecycle({ signIn: { admit, settled } })`, set once and read at
 * request time, as `second-factor-policy.ts` is.
 *
 * With nothing stated there is no guard (`signInGuard()` answers null), and
 * every reader skips its step: no extra query, lock or transaction on any path.
 *
 * Where it is asked, and why there, is `services/sign-in-guard.service.ts`.
 */

import type { DeviceRegistrationChannel } from '../events';
import type { User } from '../entities/users';

/**
 * Every door a sign-in comes through: the device-registration channels except
 * `renewal` — a renewal continues a session, it does not start one — and
 * `deletion-cancel`, the one public route besides sign-in that checks a
 * password for an identifier. `rotation` is not a sign-in either, and is not a
 * device-registration channel to begin with.
 */
export type SignInChannel = Exclude<DeviceRegistrationChannel, 'renewal'> | 'deletion-cancel';

/** Which proof the attempt is at: the first factor, or the second-factor step of a 202. */
export type SignInStage = 'credential' | 'second-factor';

/**
 * Why an attempt failed. Closed: a new reason is a new member, never a string
 * the app has to guess at.
 *
 * - `credential` — the password was wrong, or no account holds the identifier;
 *   or a passkey assertion failed for a known credential
 * - `secondFactor` — a wrong second-factor proof at `mfa/verify`; or a right
 *   one the attempt could no longer spend: the proof or the challenge spent by
 *   another request first, the challenge expired, or its key generation ended
 * - `refused` — `admit` refused it
 * - `accountDisabled` / `pendingDeletion` — the package refused the account;
 *   on `password` and `deletion-cancel`, told only for the right password
 *   (a wrong one is `credential`), though both are answered alike
 * - `secondFactorLocked` — the account's second-factor budget is spent
 *
 * A counter, a delay or any answer the app derives from `settled` must treat
 * `accountDisabled` and `pendingDeletion` exactly as `credential`: they exist
 * so the app can tell the owner, out of band. Count failures by `stage`, not
 * by reason — a counter of `credential` alone fires after wrong passwords and
 * never after the right one, and tells a caller which was which.
 */
export type SignInFailureReason =
    | 'credential'
    | 'secondFactor'
    | 'refused'
    | 'accountDisabled'
    | 'pendingDeletion'
    | 'secondFactorLocked';

/** What a person typed to name the account, on the channels that take one. */
export interface SignInIdentifier
{
    email?: string;
    phone?: string;
}

/** One sign-in attempt, as `admit` and `settled` see it. */
export interface SignInAttempt
{
    /**
     * The account, or null when the identifier names none — and in a refusal
     * told after the rollback, null for an account the refused attempt would
     * have created.
     */
    user: User | null;
    channel: SignInChannel;
    stage: SignInStage;
    /** On `password` and `deletion-cancel`: the email or phone the request named. */
    identifier?: SignInIdentifier;
    /** The request's client address (`deviceProvenance`). Display material: decide nothing by it. */
    ip?: string;
    /** The request's `user-agent`, truncated. Display material. */
    userAgent?: string;
    /** Whether proxy-guard recognised the trusted Next.js proxy — the one attested fact here. */
    webProxy: boolean;
}

/** How an attempt ended, as `settled` is told. */
export type SignInOutcome = SignInAttempt & (
    | {
        /** `succeeded`: a session exists. `challenged`: a 202, waiting for its second factor. */
        result: 'succeeded' | 'challenged';
        /** The key the session runs on — inactive while `challenged`. */
        keyId: string;
    }
    | {
        result: 'failed';
        reason: SignInFailureReason;
        /** The key the attempt presented, where the attempt had one. */
        keyId?: string;
    }
);

/**
 * The shape a refusal's `code` must have: 1 to 64 characters, each a letter,
 * a digit, `_`, `-` or `.` — `ACCOUNT_LOCKED`, `temporary-password-expired`,
 * `policy.locked`. It reaches the client as `details.code`, a constant to
 * branch on: never a message, and never data interpolated into one.
 */
export const SIGN_IN_REFUSAL_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * `admit`'s answer: nothing to let the attempt through, or the refusal and its
 * code for the client. A `code` outside `SIGN_IN_REFUSAL_CODE` is refused like
 * any other malformed answer: 500, no session.
 */
export type SignInAdmission = void | undefined | { refuse: { code: string } };

/**
 * `createAuthLifecycle({ signIn })`. Both optional.
 *
 * Every call but one runs in a transaction of the package's, holding the
 * account's lock, and an app repository extending `BaseRepository` joins it:
 * `admit` and `succeeded`/`challenged` in the session's transaction, a
 * failure in one of its own. The exception is `admit`'s first call on
 * `password`, `deletion-cancel` and `mfa/verify`, before the credential is
 * compared: outside any transaction, so a write there commits at once.
 * Database work only, and fast — every other writer of the account waits on
 * it. Never lock a second account. The README's "Where each call runs" has
 * the table.
 */
export interface SignInGuardOptions
{
    /** Whether this attempt may go on. Throwing refuses it with a 500. */
    admit?: (attempt: SignInAttempt) => SignInAdmission | Promise<SignInAdmission>;
    /** How the attempt ended. Throwing on a failure answers 500; on a success, rolls the session back. */
    settled?: (outcome: SignInOutcome) => void | Promise<void>;
}

const OPTION_KEYS = ['admit', 'settled'] as const;

let guard: SignInGuardOptions | null = null;

/** Why boot must be refused, once two calls stated different guards. */
let contradiction: string | null = null;

/**
 * Set the guard. Called synchronously from `createAuthLifecycle()`, so it is
 * in force before any handler can run.
 *
 * The rule `configureSecondFactor` follows: a call that states nothing leaves
 * the guard as it is, and a call that states different functions than an
 * earlier call — compared by identity — is a contradiction refused at boot by
 * `assertSignInGuardConsistent`, the first statement staying in force meanwhile.
 *
 * @throws Error on an unknown key, or a value that is not a function
 */
export function configureSignIn(options: SignInGuardOptions | undefined): void
{
    if (options === undefined)
    {
        return;
    }

    assertGuardShape(options);

    if (guard === null)
    {
        guard = { admit: options.admit, settled: options.settled };

        return;
    }

    const differing = OPTION_KEYS.filter(key => guard![key] !== options[key]);

    if (differing.length > 0 && contradiction === null)
    {
        contradiction = `createAuthLifecycle() was given different signIn options in two calls: ${differing.join(', ')}. `
            + 'State them once, or the same functions in every call. Until then the first ones stay in force.';
    }
}

function assertGuardShape(options: SignInGuardOptions): void
{
    const unknown = Object.keys(options).filter(key => !(OPTION_KEYS as readonly string[]).includes(key));

    if (unknown.length > 0)
    {
        throw new Error(`signIn.${unknown[0]} is not an option. Known options: ${OPTION_KEYS.join(', ')}.`);
    }

    for (const key of OPTION_KEYS)
    {
        const value: unknown = options[key];

        if (value !== undefined && typeof value !== 'function')
        {
            throw new Error(`signIn.${key} must be a function, received ${String(value)}.`);
        }
    }
}

/**
 * Refuse boot when two `createAuthLifecycle()` calls stated different guards.
 * Called from `afterInfrastructure`, beside `assertSecondFactorPolicy`.
 */
export function assertSignInGuardConsistent(): void
{
    if (contradiction !== null)
    {
        throw new Error(contradiction);
    }
}

/** The guard the application stated, or null — and with null, nothing is asked or told. */
export function signInGuard(): SignInGuardOptions | null
{
    return guard;
}

/** Test-only: no guard, no contradiction. */
export function resetSignInGuardForTests(): void
{
    guard = null;
    contradiction = null;
}
