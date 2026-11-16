/**
 * @spfn/auth - Sign-out Authentication Middleware
 *
 * What stands in front of `POST /_auth/logout`.
 *
 * A bound session's key expires within hours, so "came back the next day and
 * pressed sign out" meets an expired key — and `authenticate` refuses one. The
 * key would then stay active, renewable for its whole grace by whoever can use
 * a passkey at that browser (au3-A4). So this door admits, besides everything
 * `authenticate` admits, the one key renewal admits past its expiry: a bound
 * key inside its grace, asked of `admitPrincipal` exactly as renewal asks it
 * (a `renewal` credential). The route then revokes it like any other.
 *
 * Every other request — a live key, an application profile, a key past its
 * grace, no credential — is `authenticate`'s, and answered as `authenticate`
 * answers it: a dead key gets the answer a dead key gets everywhere.
 *
 * One difference from `authenticate`: a bound key's browser family is not
 * compared. A thief who ends the owner's session does no harm, and the owner
 * ending it from a browser whose user-agent changed family must work — so the
 * Bearer path runs with no request to compare against (`authenticateBearer`).
 *
 * @module server/middleware/authenticate-for-sign-out
 */

import type { Context } from 'hono';
import { defineMiddleware } from '@spfn/core/route';

import { CLIENT_PROOF_HEADERS } from '../client-proof/admission';
import { keyLiveness } from '../lib/key-liveness';
import { registerEnrolmentGate } from '../lib/enrolment-routes';
import {
    admissionRefusalError,
    admitPrincipal,
    admitsForRenewal,
    authContextFor,
    type Admission,
} from '../services/admission.service';
import { admitBearerKey, authenticate, authenticateBearer } from './authenticate';

/**
 * Sign-out authentication middleware
 *
 * Auto-skips the global `auth` middleware, which it runs itself for every
 * request that is not an expired bound session's.
 *
 * @example
 * ```typescript
 * export const logout = route.post('/_auth/logout')
 *   .use([authenticateForSignOut])
 *   .handler(async (c) => logoutService({ userId: Number(getAuth(c).userId), keyId: getAuth(c).keyId }));
 * ```
 */
export const authenticateForSignOut = defineMiddleware('authForSignOut', async (c, next) =>
{
    const expired = await expiredBoundSession(c);

    if (expired === null)
    {
        // A profile's credential is no web key, so never bound: `authenticate` answers it.
        return presentsProfile(c) ? await authenticate.handler(c, next) : await authenticateBearer(c, next, null);
    }

    if ('refused' in expired)
    {
        throw admissionRefusalError(expired.refused);
    }

    c.set('auth', authContextFor(expired.admitted, 'bearer'));

    await next();

    return undefined;
}, { skips: ['auth'] });

// It runs `authenticate` on the enrolment routes it guards, so the route's
// enrolment marker has to answer to it as it answers to `authenticate` (#309).
registerEnrolmentGate(authenticateForSignOut.handler);

/**
 * The admission of a Bearer key that has expired but is still renewable —
 * signature checked, then `admitPrincipal` with a `renewal` credential — or
 * null when the request is not one. A request whose signature did not verify
 * is not one: `authenticate` answers it, as it answers any forged request.
 */
async function expiredBoundSession(c: Context): Promise<Admission | null>
{
    if (presentsProfile(c))
    {
        return null;
    }

    const outcome = await admitBearerKey(c);

    if ('refused' in outcome || keyLiveness(outcome.key) !== 'expired' || !admitsForRenewal(outcome.key))
    {
        return null;
    }

    return await admitPrincipal({
        userId: outcome.key.userId,
        credential: { kind: 'renewal', keyId: outcome.key.keyId },
        route: null,
        presentedOn: null,
    });
}

/** Whether the request names an auth profile rather than carrying a Bearer key. */
function presentsProfile(c: Context): boolean
{
    return c.req.header(CLIENT_PROOF_HEADERS.profile) !== undefined;
}
