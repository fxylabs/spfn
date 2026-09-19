/**
 * @spfn/auth - What a sign-in answers with
 *
 * One module for the shape every path that starts a session returns, and for the
 * helper that fills in its binding half. It is here rather than in
 * `auth.service.ts` because three of its readers are upstream of that file —
 * `key.service` decides the second-factor step-up, `mfa.service` resolves it —
 * and a type living with one of its producers would put those services in a
 * cycle with each other.
 */

import { type SessionBindingType } from '../types';

/**
 * The second-factor challenge a stepped-up sign-in hands back (#95).
 *
 * `secret` is the 32 random bytes the challenge was minted from, and it is the
 * only form of it that ever leaves the server — the row is addressed by its
 * hash. It authorizes exactly one thing, `POST /_auth/mfa/verify` for this one
 * registration, and it is not a bearer credential for anything else.
 */
export interface MfaChallengeHandle
{
    secret: string;
    /** Epoch milliseconds the challenge stops verifying at. */
    expiresAtMillis: number;
}

/**
 * What a sign-in answers with, on every path that starts a session.
 *
 * **One type with a required discriminant, not a union.** A sign-in on an
 * account with a second factor and a device it has never seen answers 202 with
 * `mfaRequired: true` and a challenge instead of a session (#95), and the two
 * answers have to be one declared type: `authApi.login` infers its result from
 * this declaration, so a union would make every existing `result.userId` in
 * every consuming app stop compiling, and the mobile contract's grammar has no
 * union type either — `DeviceAuthPollResponse` was flattened the same way and
 * for the same reason. Narrow on `mfaRequired` before reading `userId`.
 *
 * `sessionBinding` and `keyExpiresAtMillis` are the carrier #97 needed. The
 * Next.js proxy generated the device key and sealed the cookie, but only the
 * backend knows whether the account asked for a bound session and when the key
 * it just registered runs out — so the sign-in says it here and the interceptor
 * copies both into `SessionData`. A response without them seals an unbound
 * session, which is what every account that did not opt in gets and what every
 * path predating that change keeps getting.
 */
export interface LoginResult
{
    /** true means no session was started: verify the challenge below first. */
    mfaRequired: boolean;
    /** Present exactly when `mfaRequired` is true. */
    challenge?: MfaChallengeHandle;
    userId?: string;
    publicId?: string;
    email?: string;
    phone?: string;
    passwordChangeRequired?: boolean;
    /** `'passkey'` when the key registered by this sign-in is bound. Absent otherwise. */
    sessionBinding?: SessionBindingType;
    /** Epoch milliseconds that key expires at. Only sent alongside `sessionBinding`. */
    keyExpiresAtMillis?: number;
}

/**
 * The binding half of a sign-in answer, as a type.
 *
 * Named because more than one result carries it: a password reset registers a
 * device key exactly as a sign-in does, so its answer has to say so too or the
 * proxy seals a cookie that does not know the key it holds is short-lived.
 */
export type LoginBindingFields = Pick<LoginResult, 'sessionBinding' | 'keyExpiresAtMillis'>;

/**
 * The two binding fields a `LoginResult` carries, or nothing.
 *
 * Nothing, and not `{ sessionBinding: 'none' }`: absence is how every consumer
 * already reads "unbound", from the sealing interceptor to a generated mobile
 * client, and a response that started naming the default would change the shape
 * of every sign-in this package has ever answered.
 */
export function loginBindingFields(
    registered: { binding: SessionBindingType; expiresAt: Date | null },
): LoginBindingFields
{
    if (registered.binding !== 'passkey' || !registered.expiresAt)
    {
        return {};
    }

    return { sessionBinding: 'passkey', keyExpiresAtMillis: registered.expiresAt.getTime() };
}
