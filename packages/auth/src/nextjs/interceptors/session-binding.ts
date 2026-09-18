/**
 * Session Binding Interceptor
 *
 * The cookie half of #97.
 *
 * Two things live here. `bindingSessionFields` is what every sealing site copies
 * into `SessionData`, so that the five of them cannot drift: the backend is the
 * only party that knows an account opted in, it says so in the sign-in response,
 * and this turns that answer plus the inbound `user-agent` into the three fields
 * the proxy later reads.
 *
 * `sessionBindingInterceptor` is the other half: turning binding on mutates a key
 * row, and without this the cookie in the browser would go on saying nothing
 * about it. The proxy re-seals only within the last day of the *cookie's* life,
 * so for the rest of the week it would believe the session unbound, and the first
 * time the (now short-lived) key expired the backend's 401 would clear the
 * cookies — signing the person out on the day they turned the protection on,
 * which is the failure the feature exists to prevent. Turning it off has the
 * mirror problem: the cookie would keep an expiry that no longer applies.
 */

import type { InterceptorRule } from '@spfn/core/nextjs/server';
import { sealSession, unsealSession, type SessionData } from '../../server/lib/session';
import { uaFamily } from '../../server/lib/ua-family';
import { getSessionTtl, COOKIE_NAMES } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { cookieSecure } from './cookie-options';
import { pushCsrfCookie } from './csrf';

/** The binding half of a `LoginResult`, as it arrives on the wire. */
export interface BindingResponseFields
{
    sessionBinding?: unknown;
    keyExpiresAtMillis?: unknown;
}

/**
 * The three fields a sealing site adds to `SessionData`, or nothing at all.
 *
 * Nothing at all is the important half. An unbound session is sealed with the
 * same four fields it has always been sealed with — no `uaFamily`, no empty
 * `binding` — so a deployment where nobody opted in produces byte-identical
 * cookies to the one before this change, and every branch downstream that asks
 * "is this bound" answers by the absence.
 *
 * `uaFamily` is recorded here, from the request that started the session, because
 * the proxy is the only hop that sees the browser's own `user-agent`: a server
 * component calling the RPC proxy sends none, and the backend would be comparing
 * a family it never received.
 *
 * @param body - the response body of the sign-in, whatever shape it came in
 * @param userAgent - the inbound `user-agent`, absent when the caller sent none
 */
export function bindingSessionFields(
    body: BindingResponseFields | null | undefined,
    userAgent: string | null | undefined,
): Partial<SessionData>
{
    if (body?.sessionBinding !== 'passkey' || typeof body.keyExpiresAtMillis !== 'number')
    {
        return {};
    }

    return {
        binding: 'passkey',
        keyExpiresAt: body.keyExpiresAtMillis,
        ...(userAgent ? { uaFamily: uaFamily(userAgent) } : {}),
    };
}

/**
 * Session Binding Interceptor
 *
 * Response: re-seal the session cookie from the 200 the binding route answered.
 *
 * Registered after `generalAuthInterceptor` so that its cookie is the later one
 * in `setCookies` — the response phases run in registration order, and the last
 * write of a name is the one the browser keeps. `general-auth` re-seals on this
 * path only in the rare window where the cookie is nearly expired, and that
 * re-seal carries the *old* fields.
 */
export const sessionBindingInterceptor: InterceptorRule =
    {
        pathPattern: '/_auth/session/binding',
        method: 'POST',

        response: async (ctx, next) =>
        {
            const sessionCookie = ctx.cookies.get(COOKIE_NAMES.SESSION);

            if (ctx.response.status !== 200 || !sessionCookie)
            {
                await next();

                return;
            }

            try
            {
                const session = await unsealSession(sessionCookie);
                await pushResealed(ctx.setCookies, applyBinding(session, ctx.response.body, ctx.request.headers));
            }
            catch (error)
            {
                // The setting is already written and the response already says so;
                // a cookie that could not be re-sealed heals at the next refresh.
                // Failing the request here would report failure for a change that
                // happened.
                authLogger.interceptor.general.error('Failed to re-seal the session after a binding change', error as Error);
            }

            await next();
        },
    };

/** The session as it should now read, given what the route answered. */
function applyBinding(
    session: SessionData,
    body: BindingResponseFields | null | undefined,
    requestHeaders: Record<string, string>,
): SessionData
{
    const { binding, keyExpiresAt, uaFamily: sealedFamily, ...unbound } = session;

    if (body?.sessionBinding !== 'passkey')
    {
        return unbound;
    }

    // The family the session already carried wins over the family of this
    // request: re-deriving it would silently re-anchor the check to whatever
    // browser turned the setting on, and this response is not a sign-in.
    const fields = bindingSessionFields(body, requestHeaders['user-agent']);

    return { ...unbound, ...fields, ...(sealedFamily ? { uaFamily: sealedFamily } : {}) };
}

/** Write the session, key-id and CSRF cookies the way every other seal site does. */
async function pushResealed(
    setCookies: Parameters<typeof pushCsrfCookie>[0],
    session: SessionData,
): Promise<void>
{
    const ttl = getSessionTtl();
    const options = {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'lax' as const,
        maxAge: ttl,
        path: '/',
    };

    setCookies.push({ name: COOKIE_NAMES.SESSION, value: await sealSession(session, ttl), options });
    setCookies.push({ name: COOKIE_NAMES.SESSION_KEY_ID, value: session.keyId, options });
    await pushCsrfCookie(setCookies, session.keyId, ttl);
}
