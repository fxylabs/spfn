/**
 * @spfn/auth - Key Liveness
 *
 * The one answer to "can this device key still sign for its account", asked by
 * every surface that admits a key and by the registration that decides whether
 * a key is being replaced.
 *
 * A key is live while it is active, has not expired, and belongs to the
 * account's current key generation. The generation is part of it rather than a
 * check beside it: a global revocation moves the account's generation in the
 * statement that revokes its keys, so a key of an ended generation *is* a
 * revoked key — one a rotation racing the revocation wrote after its snapshot —
 * and every surface answers it exactly as it answers a revoked one.
 *
 * Expiry is told apart from revocation because the surfaces answer them
 * differently: `authenticate` says `KeyExpiredError`, and renewal admits a bound
 * key past its expiry for its grace window. Nothing admits a revoked key.
 */

import type { UserPublicKey } from '../entities/user-public-keys';

/** A key row read together with its account's current key generation. */
export type KeyWithAccountEpoch = UserPublicKey & { accountKeyEpoch: number };

export type KeyLiveness = 'live' | 'expired' | 'revoked';

/**
 * Whether a key is live, and if not, which of the two ways it stopped.
 *
 * Revocation is decided first: a revoked key that has also expired is revoked,
 * so no surface tells a caller more about a dead key than that it is dead.
 */
export function keyLiveness(key: KeyWithAccountEpoch): KeyLiveness
{
    if (!key.isActive || key.keyEpoch !== key.accountKeyEpoch)
    {
        return 'revoked';
    }

    return key.expiresAt !== null && Date.now() > key.expiresAt.getTime() ? 'expired' : 'live';
}
