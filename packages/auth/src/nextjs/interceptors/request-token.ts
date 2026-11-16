/**
 * The headers a request is signed with on behalf of a session.
 *
 * One request token per backend call, signed with the private key the session
 * cookie holds: `generalAuthInterceptor` signs every authenticated call with it,
 * signs again for the one retry a `TokenExpiredError` earns, and the session
 * decision signs the revocation of a key it could not write into a cookie —
 * which is the only party left that holds that key — and `oauth/finalize` is
 * signed by the key its pending cookie holds.
 */

import type { SessionData } from '../../server/lib/session';
import { generateClientToken } from '../../server/lib/crypto';

/** What signs: a session's key, or a pending one whose account is not known here yet. */
type SigningKey = Pick<SessionData, 'keyId' | 'privateKey' | 'algorithm'> & Partial<Pick<SessionData, 'userId'>>;

/**
 * `Authorization` and `X-Key-Id` for one call made as this session — or as the
 * key a pending sign-in holds.
 *
 * @param session - the session (or pending key) whose key signs
 */
export function signedRequestHeaders(session: SigningKey): Record<string, string>
{
    const token = generateClientToken(
        {
            userId: session.userId,
            keyId: session.keyId,
            timestamp: Date.now(),
        },
        session.privateKey,
        session.algorithm,
        { expiresIn: '15m' },
    );

    return {
        Authorization: `Bearer ${token}`,
        'X-Key-Id': session.keyId,
    };
}
