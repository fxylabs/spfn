/**
 * Passkey Hook
 *
 * The application's seat inside a passkey's enrolment and revocation —
 * `createAuthLifecycle({ passkey: { enrolled, revoked } })`, set once and read
 * at request time, as `password-change-guard.ts` is.
 *
 * With nothing stated there is no hook (`passkeyHook()` answers null), and
 * every path runs as it did: no call, query or lock more.
 *
 * Where it is told, and why there, is `services/passkey-hook.service.ts`.
 */

import type { PasskeyEnrolledPayload, PasskeyRevokedPayload } from '../events';

import { optionKeys, readOptions } from '@spfn/core/options';

/**
 * How the passkey was revoked, as `auth.passkey.revoked` says it:
 *
 * - `user` — its owner removed it (`POST /_auth/passkeys/revoke`);
 * - `operator` — the application's second-factor reset
 *   (`resetSecondFactorService`), once for each passkey it revokes.
 */
export type PasskeyRevocationReason = 'user' | 'operator';

/**
 * One revocation, as `revoked` sees it: `auth.passkey.revoked`'s payload, its
 * `reason` narrowed to the reasons there are. A function written for
 * `PasskeyRevokedPayload` is still one `revoked` takes.
 */
export type PasskeyRevocation = Omit<PasskeyRevokedPayload, 'reason'> & { reason: PasskeyRevocationReason };

/**
 * `createAuthLifecycle({ passkey })`. Both optional.
 *
 * Both run in the transaction that writes or revokes the passkey row, after
 * that write and before the commit, under the account's lock, and an app
 * repository extending `BaseRepository` joins it: a write there commits with
 * the passkey's change or rolls back with it. Database work only, and fast —
 * every other writer of the account waits on it. Never open a `requiresNew`
 * transaction that touches the account, and never lock a second account. The
 * README's "The passkey hook" has the table.
 */
export interface PasskeyHookOptions
{
    /**
     * A passkey is registered — first set-up and every passkey added — and
     * everything the registration writes is written. Handed
     * `auth.passkey.enrolled`'s payload. A throw rolls the registration back
     * and answers 500 `PasskeyHookFailedError`.
     */
    enrolled?: (passkey: PasskeyEnrolledPayload) => void | Promise<void>;
    /**
     * A passkey is revoked — by its owner, or by the operator's reset once for
     * each passkey it revokes. Handed `auth.passkey.revoked`'s payload. A throw
     * rolls the revocation back — the whole reset, on the operator's — and
     * answers 500 `PasskeyHookFailedError`.
     */
    revoked?: (passkey: PasskeyRevocation) => void | Promise<void>;
}

const OPTION_KEYS = optionKeys<PasskeyHookOptions>({ enrolled: true, revoked: true });

let hook: PasskeyHookOptions | null = null;

/** Why boot must be refused, once two calls stated different hooks. */
let contradiction: string | null = null;

/**
 * Set the hook. Called synchronously from `createAuthLifecycle()`, so it is
 * in force before any handler can run.
 *
 * The rule `configurePasswordChange` follows: a call that states nothing
 * leaves the hook as it is, and a call that states different functions than
 * an earlier call — compared by identity — is a contradiction refused at boot
 * by `assertPasskeyHookConsistent`, the first statement staying in force.
 *
 * @throws Error on an unknown key, or a value that is not a function
 */
export function configurePasskeyHook(options: PasskeyHookOptions | undefined): void
{
    if (options === undefined)
    {
        return;
    }

    const read = readHook(options);

    if (hook === null)
    {
        hook = read;

        return;
    }

    const differing = OPTION_KEYS.filter(key => hook![key] !== read[key]);

    if (differing.length > 0 && contradiction === null)
    {
        contradiction = `createAuthLifecycle() was given different passkey options in two calls: ${differing.join(', ')}. `
            + 'State them once, or the same functions in every call. Until then the first ones stay in force.';
    }
}

/** `options` read once, by `readOptions`: the snapshot is what is checked, compared and kept (#477). */
function readHook(options: PasskeyHookOptions): PasskeyHookOptions
{
    const read = readOptions<PasskeyHookOptions>('passkey', options, OPTION_KEYS);

    for (const key of OPTION_KEYS)
    {
        const value: unknown = read[key];

        if (value !== undefined && typeof value !== 'function')
        {
            throw new Error(`passkey.${key} must be a function, received ${String(value)}.`);
        }
    }

    return { enrolled: read.enrolled, revoked: read.revoked };
}

/**
 * Refuse boot when two `createAuthLifecycle()` calls stated different hooks.
 * Called from `afterInfrastructure`, beside `assertPasswordChangeGuardConsistent`.
 */
export function assertPasskeyHookConsistent(): void
{
    if (contradiction !== null)
    {
        throw new Error(contradiction);
    }
}

/** The hook the application stated, or null — and with null, nothing is told. */
export function passkeyHook(): PasskeyHookOptions | null
{
    return hook;
}

/** Test-only: no hook, no contradiction. */
export function resetPasskeyHookForTests(): void
{
    hook = null;
    contradiction = null;
}
