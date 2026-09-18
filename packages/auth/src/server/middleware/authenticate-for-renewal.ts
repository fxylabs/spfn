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

import { getBoundKeyRenewGraceMs } from '../lib/config';
import { usersRepository, userProfilesRepository } from '../repositories';
import type { UserPublicKey } from '../entities/user-public-keys';
import { admitBearerKey, bearerAuthContext } from './authenticate';

/**
 * Whether a key may sign a renewal — the one clause that differs from `authenticate`.
 *
 * Bound, and within its grace. Early renewal is allowed, because a browser that
 * asks a minute before its key runs out should not have to wait for the failure
 * first; late renewal is allowed for the grace window, so a laptop closed over a
 * long weekend comes back to one prompt instead of a sign-in. Past it there is
 * nothing to continue, and an unbound key was never in this ceremony at all.
 */
export function admitsForRenewal(key: UserPublicKey): boolean
{
    return key.binding === 'passkey'
        && key.expiresAt !== null
        && Date.now() < key.expiresAt.getTime() + getBoundKeyRenewGraceMs();
}

/**
 * Renewal authentication middleware
 *
 * Auto-skips the global `auth` middleware, the way `optionalAuth` does: a route
 * that carries this one must not also be asked for a live key.
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
    // `admitsForRenewal` is asked twice, and both times for the same reason. The
    // first is the expiry clause the shared step consults only for a key that has
    // already run out; the second covers a key that has *not* — an unbound
    // session presenting a live key is refused here rather than admitted into a
    // ceremony that exists for bound ones.
    const outcome = await admitBearerKey(c, admitsForRenewal);

    if ('refused' in outcome || !admitsForRenewal(outcome.key))
    {
        throw new SessionRenewalRefusedError();
    }

    const resolved = await activeAccount(outcome.key.userId);

    if (!resolved)
    {
        throw new SessionRenewalRefusedError();
    }

    c.set('auth', bearerAuthContext(outcome.key.keyId, resolved));

    await next();

    return undefined;
}, { skips: ['auth'] });

/**
 * The account behind the key, or nothing.
 *
 * `resolveAuthenticatedUser` is deliberately not used: it tells a caller which
 * status refused them — suspended, pending deletion — and on this path every
 * refusal has to read the same. The reads are the ones it makes.
 */
async function activeAccount(userId: number)
{
    const [result, locale] = await Promise.all([
        usersRepository.findByIdWithRole(userId),
        userProfilesRepository.findLocaleByUserId(userId),
    ]);

    if (!result || result.user.status !== 'active')
    {
        return null;
    }

    return { user: result.user, role: result.role?.name ?? null, locale };
}
