/**
 * Session Renewal Interceptor
 *
 * One job: put the expiring key's id into the body of both renewal calls.
 *
 * The browser cannot do it. `COOKIE_NAMES.SESSION_KEY_ID` is HttpOnly at every
 * write site, so page script cannot read it, and the readable companion — the
 * CSRF cookie — carries the HMAC and deliberately not the key id. So
 * `renewSession()` sends `{ response }` and nothing else, exactly as
 * `signInWithPasskey()` does, and the value the route needs is injected here from
 * the cookie the browser is already sending.
 *
 * That also settles the enumeration question the renewal routes would otherwise
 * raise: through the proxy, a caller cannot choose which key id to renew. It
 * settles it for the ordinary path only — the routes are public and a caller
 * reaching them directly can send any value, which is why the service treats
 * `expiredKeyId` as unauthenticated input and answers one refusal to everything.
 *
 * The *new* key pair is not this file's business. `renew/verify` is on
 * `loginRegisterInterceptor`'s path list, so the pair is generated and the
 * session sealed there, under the field names every other sign-in path uses.
 */

import type { InterceptorRule } from '@spfn/core/nextjs/server';
import { COOKIE_NAMES } from '../../server/lib/config';

/** The two public renewal paths, as one pattern the proxy layers agree on. */
export const SESSION_RENEW_PATH_PATTERN = /^\/_auth\/session\/renew\/(options|verify)$/;

export const sessionRenewInterceptor: InterceptorRule =
    {
        pathPattern: SESSION_RENEW_PATH_PATTERN,
        method: 'POST',

        request: async (ctx, next) =>
        {
            const expiredKeyId = ctx.cookies.get(COOKIE_NAMES.SESSION_KEY_ID);

            if (expiredKeyId)
            {
                ctx.body = { ...ctx.body, expiredKeyId };
            }

            await next();
        },
    };
