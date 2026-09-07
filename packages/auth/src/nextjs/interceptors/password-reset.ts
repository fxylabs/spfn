/**
 * Password Reset Interceptor
 *
 * Carries the password-setup session between the two browser-facing steps of a
 * password reset, so the secret that authorizes setting a new password lives in
 * an HttpOnly cookie and never in page script.
 *
 * On the confirm response it moves `setupSecret` out of the body and into the
 * cookie. On the complete request it puts the cookie back into the body, the
 * same way `loginRegisterInterceptor` injects a device key. Both interceptors
 * match `/_auth/password/reset/complete` and both run — matching rules execute
 * as a chain in registration order, they do not compete — so the request arrives
 * with the setup secret and a freshly generated key.
 *
 * A cookie of its own rather than the signup one: the two secrets address
 * different tables, and a browser that abandoned a signup mid-flow must not
 * present its leftover secret to a reset.
 */

import type { InterceptorRule } from '@spfn/core/nextjs/server';
import { COOKIE_NAMES } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { cookieSecure } from './cookie-options';

/**
 * Setup-session cookie lifetime, in seconds.
 *
 * Deliberately a little longer than the server-side setup session: the server
 * decides when the session dies, and a cookie that expired first would turn an
 * expired-session refusal into a missing-cookie one, which reads as a different
 * bug to whoever is looking.
 */
const SETUP_COOKIE_TTL_SECONDS = 60 * 60;

/**
 * Cookie carrying the password-setup session.
 */
function setupCookie(value: string, maxAge: number)
{
    return {
        name: COOKIE_NAMES.PASSWORD_RESET_SETUP,
        value,
        options: {
            httpOnly: true,
            secure: cookieSecure,
            sameSite: 'lax' as const,
            maxAge,
            path: '/',
        },
    };
}

export const passwordResetInterceptor: InterceptorRule = {
    pathPattern: /^\/_auth\/password\/reset\/(confirm|complete)$/,
    method: 'POST',

    request: async (ctx, next) =>
    {
        if (ctx.path === '/_auth/password/reset/complete')
        {
            const cookie = ctx.cookies.get(COOKIE_NAMES.PASSWORD_RESET_SETUP);

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
            // the strength policy. The setup session survives those on the
            // server, so the cookie has to survive them too, or the retry has
            // nothing to present.
            await next();

            return;
        }

        if (ctx.path === '/_auth/password/reset/confirm')
        {
            const secret = ctx.response.body?.setupSecret;

            if (!secret)
            {
                authLogger.interceptor.oauth?.error?.('Password reset confirm response carried no setup secret');
                await next();

                return;
            }

            ctx.setCookies.push(setupCookie(secret, SETUP_COOKIE_TTL_SECONDS));

            // The browser must never see it — an HttpOnly cookie that page
            // script can also read out of the JSON body is not HttpOnly.
            delete ctx.response.body.setupSecret;
        }

        if (ctx.path === '/_auth/password/reset/complete')
        {
            // Spent. Clearing it stops a stale cookie from being presented to a
            // session the server has already marked used.
            ctx.setCookies.push(setupCookie('', 0));
        }

        await next();
    },
};
