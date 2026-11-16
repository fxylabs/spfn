/**
 * One-Time Token Service
 *
 * Issues and redeems one-time tokens for direct API access.
 *
 * A token stands in for the device key that asked for it: it is issued tagged
 * with that key, and it is good only while the key is. A token whose key was
 * revoked — a logout, a sign-out-everywhere, a password change, a suspension —
 * is refused at use, and a stream opened with it is closed when the key is
 * revoked (`closeConnectionsByKey`), on every instance.
 */

import { ForbiddenError } from '@spfn/core/errors';

import { getOneTimeTokenManager } from '../lib/one-time-token';

export interface IssueOneTimeTokenResult
{
    token: string;
    expiresAt: string;
}

/** What a redeemed token was issued to: the account, and the device key that asked for it. */
export interface RedeemedOneTimeToken
{
    userId: number;
    issuedByKeyId: string;
}

/**
 * Issue a one-time token for the authenticated user, bound to the device key
 * the request was signed with.
 *
 * @param userId - Authenticated user's ID
 * @param keyId - The device key the caller signed with (`signingKeyOf`). Null
 *   for a principal that signed with none — an application's own auth
 *   profile — which is refused: a token bound to no key would outlive every
 *   revocation.
 * @returns Token string and ISO expiration timestamp
 * @throws ForbiddenError when the caller signed with no device key
 */
export async function issueOneTimeTokenService(userId: string, keyId: string | null): Promise<IssueOneTimeTokenResult>
{
    if (keyId === null)
    {
        throw new ForbiddenError({ message: 'A one-time token is bound to a device key, and this request was signed with none' });
    }

    const manager = getOneTimeTokenManager();
    const token = await manager.issue(userId, { keyId, keyHolder: userId });

    // Read the TTL off the manager rather than assuming the default: an app that
    // configured a different one would otherwise be told the wrong expiry.
    const expiresAt = new Date(Date.now() + manager.ttlMs).toISOString();

    return { token, expiresAt };
}

/**
 * Take a one-time token out of the store and answer what it was issued to.
 *
 * Only the store half: whether the person may be let in — the issuing key
 * still live, the account active, the second-factor policy — is the
 * admission's (`admitPrincipal` with a `oneTimeToken` credential), which
 * `oneTimeTokenAuth` asks next. The token is spent either way. A token issued
 * with no key names no credential the admission could judge, and is refused;
 * so is one with no key holder recorded beside the key, because the person is
 * who the issuer recorded and never a parse of the subject.
 *
 * @returns null if invalid, expired, consumed, or issued with no key or no key holder
 */
export async function redeemOneTimeTokenService(token: string): Promise<RedeemedOneTimeToken | null>
{
    const data = await getOneTimeTokenManager().take(token);

    return data?.keyId && data.keyHolder ? { userId: Number(data.keyHolder), issuedByKeyId: data.keyId } : null;
}

/**
 * Verify and consume a one-time token
 *
 * The token's issuing key is checked (the manager's `verifyKey`). This answers
 * whose token it was; it admits nobody — a door that turns the answer into a
 * principal admits it with `admitPrincipal`, as `oneTimeTokenAuth` does.
 *
 * @param token - The one-time token to verify
 * @returns userId if valid, null if invalid/expired/consumed
 */
export async function verifyOneTimeTokenService(token: string): Promise<string | null>
{
    const manager = getOneTimeTokenManager();

    return await manager.verify(token);
}
