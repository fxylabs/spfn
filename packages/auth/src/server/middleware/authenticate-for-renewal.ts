/**
 * @spfn/auth - Renewal Authentication Middleware
 *
 * What stands in front of the two `session/renew/*` routes.
 *
 * The key a renewal is about is the one that stopped working, so `authenticate`
 * cannot guard these routes — it refuses an expired key, which is every caller
 * here. But "cannot be authenticated by the ordinary middleware" is not the same
 * as "unauthenticated": the private half of that key is still sealed in the
 * session cookie, and the proxy still signs a JWT with it. So this middleware
 * verifies exactly what `authenticate` verifies — the same header, the same key
 * lookup, the same signature check, the same active account — and differs in one
 * clause: a key whose `expiresAt` has passed is admitted while it is bound and
 * inside its renewal grace.
 *
 * That is what makes the key id a renewal acts on unforgeable. It arrives as the
 * `keyId` of a JWT this key signed, not as a field of a body anybody can write,
 * so naming someone else's key id buys nothing without their private key.
 *
 * Every refusal is the same refusal. No credential, a bad signature, a key
 * nobody registered, an unbound key, a revoked key, one past its grace, an
 * account that is not active — all `SessionRenewalRefusedError`, with one body.
 * Anything finer would answer "is this key id live" to whoever asked, and the
 * cookie-copying adversary holds exactly one key id and would want it confirmed.
 *
 * @module server/middleware/authenticate-for-renewal
 */

import { defineMiddleware } from '@spfn/core/route';
import { SessionRenewalRefusedError } from '@spfn/auth/errors';

import { admitPrincipal, admitsForRenewal, authContextFor } from '../services/admission.service';
import { admitBearerKey } from './authenticate';

/**
 * Renewal authentication middleware
 *
 * Auto-skips the global `auth` middleware, the way `optionalAuth` does: a route
 * that carries this one must not also be asked for a live key.
 *
 * The signature is checked by the Bearer step every middleware shares, which
 * lets an expired key through only when `admitsForRenewal` would; whether the
 * person may renew — the account active on the primary, the key bound and
 * inside its grace — is `admitPrincipal`'s, with a `renewal` credential. Every
 * refusal of either is the one `SessionRenewalRefusedError`.
 *
 * @example
 * ```typescript
 * export const sessionRenewOptions = route.post('/_auth/session/renew/options')
 *   .use([authenticateForRenewal])
 *   .handler(async (c) => startSessionRenewService({ expiredKeyId: getAuth(c).keyId }));
 * ```
 */
export const authenticateForRenewal = defineMiddleware('authForRenewal', async (c, next) =>
{
    const outcome = await admitBearerKey(c, admitsForRenewal);

    if ('refused' in outcome)
    {
        throw new SessionRenewalRefusedError();
    }

    const admission = await admitPrincipal({
        userId: outcome.key.userId,
        credential: { kind: 'renewal', keyId: outcome.key.keyId },
        route: null,
    });

    if ('refused' in admission)
    {
        throw new SessionRenewalRefusedError();
    }

    c.set('auth', authContextFor(admission.admitted, 'bearer'));

    await next();

    return undefined;
}, { skips: ['auth'] });
