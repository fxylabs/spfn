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
import type { KeyReach } from '../types';

import { optionKeys, readOptions } from '@spfn/core/options';

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
    /**
     * The request's client address (`deviceProvenance`). Display material,
     * unless the deployment makes it an address the caller cannot choose:
     * through the signed Next.js proxy it is the address the proxy attests (a
     * browser's); with `SERVER_TRUSTED_PROXY_HOPS=n` it is the `X-Forwarded-For`
     * entry n hops from the right — the caller's only where the server cannot
     * be reached around those proxies; with no declaration, or a shorter
     * chain, it is the TCP peer. Decide by it only in such a deployment.
     */
    ip?: string;
    /** The request's `user-agent`, truncated. Display material. */
    userAgent?: string;
    /** Whether proxy-guard recognised the trusted Next.js proxy — the one attested fact here. */
    webProxy: boolean;
    /**
     * What the key this sign-in registers is held to (`KEY_REACH`): set on a
     * `device-link` attempt whose issuer narrowed the link — a terminal's key —
     * and absent on every other attempt.
     */
    reach?: KeyReach;
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

export { SIGN_IN_REFUSAL_CODE } from '../../lib/sign-in-refusal-code';

/**
 * `admit`'s answer: nothing to let the attempt through, or the refusal and its
 * code for the client. A `code` outside `SIGN_IN_REFUSAL_CODE` is refused like
 * any other malformed answer: 500, no session.
 */
export type SignInAdmission = void | undefined | { refuse: { code: string } };

/**
 * Which of `admit`'s calls this is, so an app can count each attempt once.
 *
 * - `before-proof` — the first call on `password`, `deletion-cancel` and
 *   `mfa/verify`, before the credential or the proof is compared: the one
 *   place to count an attempt. Every attempt of these three passes it, and
 *   concurrent attempts on one account take turns at it
 * - `deciding` — where the key is written; at `mfa/verify`, where it is
 *   activated. On every other channel it is the only call
 * - `after-failure` — asked again once a wrong credential or proof is recorded
 */
export type SignInAdmitCall = 'before-proof' | 'deciding' | 'after-failure';

/**
 * `createAuthLifecycle({ signIn })`. Both optional.
 *
 * Every call runs in a transaction of the package's, holding the account's
 * lock (for `user: null`, the same lock statement, which finds no row), and
 * an app repository extending `BaseRepository` joins it through the
 * transaction context: the deciding
 * `admit` and `succeeded`/`challenged` in the session's transaction, a failure
 * in one of its own, and the `before-proof` `admit` in one of its own that
 * commits before the credential is compared — whatever it answers, so an
 * attempt counted there stays counted, and concurrent attempts on one account
 * take turns at the count: an app that refuses past N compares at most N
 * credentials of the account. A throw rolls that transaction back. Database
 * work only, and fast — every other writer of the account waits on it; no
 * network call, no mail. Never lock a second account. The README's "Where
 * each call runs" has the table.
 */
export interface SignInGuardOptions
{
    /** Whether this attempt may go on. Throwing refuses it with a 500. */
    admit?: (attempt: SignInAttempt, call: SignInAdmitCall) => SignInAdmission | Promise<SignInAdmission>;
    /** How the attempt ended. Throwing on a failure answers 500; on a success, rolls the session back. */
    settled?: (outcome: SignInOutcome) => void | Promise<void>;
}

const OPTION_KEYS = optionKeys<SignInGuardOptions>({ admit: true, settled: true });

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

    const read = readGuard(options);

    if (guard === null)
    {
        guard = read;

        return;
    }

    const differing = OPTION_KEYS.filter(key => guard![key] !== read[key]);

    if (differing.length > 0 && contradiction === null)
    {
        contradiction = `createAuthLifecycle() was given different signIn options in two calls: ${differing.join(', ')}. `
            + 'State them once, or the same functions in every call. Until then the first ones stay in force.';
    }
}

/** `options` read once, by `readOptions`: the snapshot is what is checked, compared and kept (#477). */
function readGuard(options: SignInGuardOptions): SignInGuardOptions
{
    const read = readOptions<SignInGuardOptions>('signIn', options, OPTION_KEYS);

    for (const key of OPTION_KEYS)
    {
        const value: unknown = read[key];

        if (value !== undefined && typeof value !== 'function')
        {
            throw new Error(`signIn.${key} must be a function, received ${String(value)}.`);
        }
    }

    return { admit: read.admit, settled: read.settled };
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
