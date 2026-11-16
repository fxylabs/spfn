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
import { admitBearerKey, authenticate } from './authenticate';

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
        return await authenticate.handler(c, next);
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
 * null when the request is not one.
 */
async function expiredBoundSession(c: Context): Promise<Admission | null>
{
    if (c.req.header(CLIENT_PROOF_HEADERS.profile) !== undefined)
    {
        return null;
    }

    const outcome = await admitBearerKey(c, admitsForRenewal);

    if ('refused' in outcome || keyLiveness(outcome.key) !== 'expired')
    {
        return null;
    }

    return await admitPrincipal({
        userId: outcome.key.userId,
        credential: { kind: 'renewal', keyId: outcome.key.keyId },
        route: null,
    });
}
