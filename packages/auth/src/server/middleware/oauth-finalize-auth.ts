/**
 * The door of `POST /_auth/oauth/finalize`
 *
 * A finalize that completes a sign-in is the key's own request: the browser's
 * pending cookie holds the private half of the key the OAuth callback
 * registered, and the Next.js proxy signs the call with it. So it is admitted
 * like any signed request — by `authenticate`, the ordinary door — and the route
 * answers the principal it admitted, taking no key id from the body. Without
 * the signature, or signed by another key, nothing about the key's owner is
 * answered.
 *
 * The one branch that is not: a callback that carried a second-factor
 * challenge. Its key is still parked — inactive until `mfa/verify` proves the
 * factor — so there is nothing to admit, and the route only echoes back what
 * the page sent (the challenge, its key id, the return path). It discloses
 * nothing and authorizes nothing, and passes without a principal.
 *
 * A registered enrolment gate: `authenticate` called from here finds the
 * route's enrolment marker after this middleware, so an account the
 * second-factor policy holds to enrolment can still finalize the sign-in that
 * gives it its enrolment-only session, as a password sign-in can.
 */

import type { Context } from 'hono';
import { defineMiddleware } from '@spfn/core/route';

import { registerEnrolmentGate } from '../lib/enrolment-routes';
import { authenticate } from './authenticate';

export const oauthFinalizeAuth = defineMiddleware('oauthFinalizeAuth', async (c, next) =>
{
    if (await carriesMfaChallenge(c))
    {
        await next();

        return undefined;
    }

    return await authenticate.handler(c, next);
}, { skips: ['auth'] });

registerEnrolmentGate(oauthFinalizeAuth.handler);

/** Whether the body hands back a second-factor challenge — the 202 branch. */
async function carriesMfaChallenge(c: Context): Promise<boolean>
{
    const body: unknown = await c.req.json().catch(() => null);

    return typeof (body as { mfaChallenge?: unknown } | null)?.mfaChallenge === 'string';
}
