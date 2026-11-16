/**
 * @spfn/auth - Recording an authenticated key's use
 *
 * The one bookkeeping step the three authenticated paths — `authenticate`,
 * `optionalAuth` and the clientProofV1 profile — take after admitting a key.
 *
 * @module server/middleware/record-key-use
 */

import type { Context } from 'hono';
import { authLogger, keysRepository } from '@spfn/auth/server';

import type { UserPublicKey } from '../entities/user-public-keys';
import type { User } from '../entities/users';
import { readContextClientIdentity } from '../client-proof/version-middleware';
import { attestedClientIp, deviceProvenance } from '../lib/device-provenance';
import { awaitsWebBinding, bindWebKeyService } from '../services/key.service';

/**
 * Record this request's use of the key it was signed with, fire-and-forget.
 *
 * One throttled statement (`keysRepository.updateLastUsedById`) writes when the
 * key was used, what the client said about itself, the address only where
 * proxy-guard attested it (`attestedClientIp`), and whether the request came
 * through the trusted proxy (`via_web_proxy`).
 *
 * The key is bound from its state, read on the rows this request's admission
 * already holds: a web key, unbound, on an account whose binding is on
 * (`awaitsWebBinding`) — no extra query when that does not hold. The bind
 * re-checks the state under the account lock (`bindWebKeyService`), so one that
 * fails — a lock timeout, a busy account, the process exiting — is simply tried
 * again at the key's next use.
 *
 * Never awaited and never fails the request: it is the audit trail, the
 * concurrent-use signal and a binding that applies from the key's next expiry,
 * none of which is worth a 500 or a slower answer.
 */
export function recordKeyUse(
    c: Context,
    key: Pick<UserPublicKey, 'id' | 'userId' | 'keyId' | 'binding' | 'viaWebProxy'>,
    account: Pick<User, 'sessionBinding'>,
): void
{
    const webProxy = deviceProvenance(c).webProxy === true;

    keysRepository.updateLastUsedById(key.id, readContextClientIdentity(c), attestedClientIp(c), webProxy)
        .catch((err: unknown) => authLogger.middleware.error('Failed to record key use', err));

    if (awaitsWebBinding(key, account, webProxy))
    {
        bindWebKeyService(key.userId, key.keyId, webProxy)
            .catch((err: unknown) => authLogger.middleware.error('Failed to bind a web key; tried again at its next use', err));
    }
}
