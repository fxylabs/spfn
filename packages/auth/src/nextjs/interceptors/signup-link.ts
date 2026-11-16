/**
 * Verified-Email Signup Interceptor
 *
 * Carries the password-setup session between the two browser-facing steps of the
 * verified-email signup, so the secret that authorizes password setup lives in an
 * HttpOnly cookie and never in page script.
 *
 * On the confirm response it moves `setupSecret` out of the body and into the
 * cookie. On the password request it puts the cookie back into the body, the same
 * way `loginRegisterInterceptor` injects a device key. Both interceptors match
 * `/_auth/signup/password` and both run — matching rules execute as a chain in
 * registration order, they do not compete — so the password request arrives with
 * the setup secret and a freshly generated key.
 */

import type { InterceptorRule } from '@spfn/core/nextjs/server';
import { COOKIE_NAMES } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { packageCookie } from '../cookie-writer';
import { writeCookie } from './session-decision';

/**
 * Setup-session cookie lifetime, in seconds.
 *
 * Deliberately a little longer than the server-side setup session: the server
 * decides when the session dies, and a cookie that expired first would turn an
 * expired-session refusal into a missing-cookie one, which reads as a different
 * bug to whoever is looking.
 */
const SETUP_COOKIE_TTL_SECONDS = 60 * 60;

/** The setup cookie, through the one cookie writer. */
function setupCookie(value: string, maxAge: number)
{
    return packageCookie(COOKIE_NAMES.SIGNUP_SETUP, value, maxAge);
}

export const signupLinkInterceptor: InterceptorRule = {
    pathPattern: /^\/_auth\/signup\/(email\/confirm|password)$/,
    method: 'POST',

    request: async (ctx, next) =>
    {
        if (ctx.path === '/_auth/signup/password')
        {
            const cookie = ctx.cookies.get(COOKIE_NAMES.SIGNUP_SETUP);

            if (cookie)
            {
                if (!ctx.body)
                {
                    ctx.body = {};
                }

                ctx.body.setupSecret = cookie;
            }
        }

        await next();
    },

    response: async (ctx, next) =>
    {
        if (!ctx.response.ok)
        {
            // A refusal here is often the user's to fix — a password that fails
            // the strength policy, an app policy that rejected the signup. The
            // setup session survives those on the server, so the cookie has to
            // survive them too, or the retry has nothing to present.
            await next();

            return;
        }

        if (ctx.path === '/_auth/signup/email/confirm')
        {
            const secret = ctx.response.body?.setupSecret;

            if (!secret)
            {
                authLogger.interceptor.oauth?.error?.('Signup confirm response carried no setup secret');
                await next();

                return;
            }

            writeCookie(ctx, setupCookie(secret, SETUP_COOKIE_TTL_SECONDS));

            // The browser must never see it — an HttpOnly cookie that page
            // script can also read out of the JSON body is not HttpOnly.
            delete ctx.response.body.setupSecret;
        }

        if (ctx.path === '/_auth/signup/password')
        {
            // Spent. Clearing it stops a stale cookie from being presented to a
            // session the server has already marked used.
            writeCookie(ctx, setupCookie('', 0));
        }

        await next();
    },
};
