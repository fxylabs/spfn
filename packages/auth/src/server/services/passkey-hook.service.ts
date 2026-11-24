/**
 * @spfn/auth - Passkey Hook
 *
 * Where the application's `passkey: { enrolled, revoked }` is told: inside the
 * transaction that writes or revokes the passkey row, after that write and
 * before the commit, under the account lock the act already holds — on every
 * path that does either, once per passkey:
 *
 * - `enrolled` — `keepPasskey` (`passkey.service.ts`), every registration,
 *   first set-up and adding a passkey: path `register`;
 * - `revoked` — `revokePasskeyService` (`reason: 'user'`, path `revoke`) and
 *   `resetSecondFactorService` (`reason: 'operator'`, path `reset`), once for
 *   each passkey the reset revokes.
 *
 * A throw from either is `PasskeyHookFailedError`, which keeps nothing of the
 * hook's error but its class and SQLSTATE (`identifyHookError`), the
 * `passwordChange` rule. It propagates out of the transaction and rolls it
 * back.
 *
 * Without a hook every function here returns at once.
 */

import { PasskeyHookFailedError } from '@spfn/auth/errors';

import type { PasskeyEnrolledPayload } from '../events';
import { identifyHookError } from '../lib/hook-error';
import { passkeyHook, type PasskeyRevocation } from '../lib/passkey-hook';

/**
 * Tell `enrolled`, in the registration's transaction, once everything it writes is written.
 *
 * @throws PasskeyHookFailedError when `enrolled` throws
 */
export async function reportPasskeyEnrolled(passkey: PasskeyEnrolledPayload): Promise<void>
{
    const enrolled = passkeyHook()?.enrolled;

    if (enrolled)
    {
        await runHook('enrolled', 'register', enrolled, passkey);
    }
}

/**
 * Tell `revoked`, in the revocation's transaction, once the passkey is revoked.
 *
 * @throws PasskeyHookFailedError when `revoked` throws
 */
export async function reportPasskeyRevoked(passkey: PasskeyRevocation): Promise<void>
{
    const revoked = passkeyHook()?.revoked;

    if (revoked)
    {
        await runHook('revoked', passkey.reason === 'user' ? 'revoke' : 'reset', revoked, passkey);
    }
}

/**
 * Run a hook on a copy of `passkey` — the payload the after-commit event is
 * also handed, which a hook's change must not reach; what it throws comes back
 * as `PasskeyHookFailedError`, by identifiers only.
 */
function runHook<T extends { userId: string }>(
    hook: 'enrolled' | 'revoked',
    path: 'register' | 'revoke' | 'reset',
    fn: (passkey: T) => void | Promise<void>,
    passkey: T,
): Promise<void>
{
    return Promise.resolve({ ...passkey })
        .then(fn)
        .catch((error: unknown) => Promise.reject(new PasskeyHookFailedError({
            hook,
            path,
            userId: Number(passkey.userId),
            ...identifyHookError(error),
        })));
}
