/**
 * General Authentication Interceptor
 *
 * Handles authentication for all API requests except the unauthenticated ones
 * - Session validation, and the one retry a request-token refusal earns
 * - JWT generation and signing
 * - What the backend's answer means for the session, proposed to the session
 *   decision (`session-decision.ts`), which is the only writer of its cookies
 */

import type { InterceptorRule, RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import { SessionRenewalRequiredError } from '@spfn/auth/errors';
import { readSealedSession, shouldRefreshSession, type SessionData } from '../../server/lib/session';
import { COOKIE_NAMES } from '../../server/lib/config';
import { isRenewableExpiry, isSessionEndingCode } from '../../server/lib/admission-refusal';
import { authLogger } from '../../server/logger';
import { refuseInvalidCsrf } from './csrf';
import { errorCodeOf, refusalEnvelope } from './error-envelope';
import { SESSION_RENEW_PATH_PATTERN } from './session-renew';
import { signedRequestHeaders } from './request-token';
import { clear, refresh } from './session-decision';

/**
 * The routes that authenticate nobody: a sign-in, a code, an existence check,
 * and the two halves of a second-factor step-up and of a browser device login —
 * the key those activate is inactive until they succeed, so there is nothing to
 * sign them with. A session cookie the browser still holds is not read on them.
 *
 * Nothing is on this list to protect a fresh session from this rule any more: a
 * new session is decided over whatever this rule proposes (`session-decision.ts`).
 */
const UNAUTHENTICATED_PATHS = [
    /^\/_auth\/login$/,
    /^\/_auth\/register$/,
    /^\/_auth\/codes$/,
    /^\/_auth\/codes\/verify$/,
    /^\/_auth\/exists$/,
    /^\/_auth\/mfa\/verify$/,
    /^\/_auth\/mfa\/verify\/options$/,
    // Only the browser's `/web` parking routes: the mobile `redeem` and `start`
    // carry the caller's own key and are left as they always were.
    /^\/_auth\/device\/link\/redeem\/web$/,
    /^\/_auth\/device\/link\/poll$/,
    /^\/_auth\/device\/start\/web$/,
    /^\/_auth\/device\/poll$/,
];

function requiresAuth(path: string): boolean
{
    return !UNAUTHENTICATED_PATHS.some(pattern => pattern.test(path));
}

/**
 * Read the session cookie and sign the request with its key.
 *
 * An unreadable cookie — whichever way it is unreadable — is proposed for
 * clearing and the request goes on anonymous; a session near its end is marked
 * for re-sealing. Whether a bound session is presented from the browser it
 * started in is not decided here: the backend compares the request's
 * `user-agent`, which this proxy forwards, with the key row's family, and its
 * `SessionContextChangedError` is a key refusal like any other (`judgeAnswer`).
 */
async function authenticateFromCookie(ctx: RequestInterceptorContext, sessionCookie: string): Promise<boolean>
{
    const read = await readSealedSession(sessionCookie);

    if ('failure' in read)
    {
        authLogger.interceptor.general.warn('Session cookie unreadable, clearing it', { failure: read.failure });
        clear(ctx, read.failure);

        return true;
    }

    const session = read.session;
    ctx.metadata.inboundSession = session;

    // The request is authenticated from the session cookie — the one fact only
    // this layer knows, and the whole reason the CSRF check lives here.
    // Refusals stop before the backend is called.
    if (await refuseInvalidCsrf(ctx, session.keyId))
    {
        return false;
    }

    ctx.metadata.refreshSession = await shouldRefreshSession(sessionCookie, 24);
    Object.assign(ctx.headers, signedRequestHeaders(session));

    ctx.metadata.userId = session.userId;
    ctx.metadata.keyId = session.keyId;
    ctx.metadata.sessionValid = true;

    return true;
}

/**
 * Retry once, signed afresh, when the backend refused the request token itself.
 *
 * A first-party token is signed for each request, so `TokenExpiredError` here
 * means clock trouble between the two hosts rather than anything about the
 * session. One retry; a second refusal is passed through as it came.
 */
async function retryExpiredToken(ctx: ResponseInterceptorContext): Promise<void>
{
    const session: SessionData = ctx.metadata.inboundSession;

    if (errorCodeOf(ctx.response.body) !== 'TokenExpiredError' || !ctx.callBackend)
    {
        return;
    }

    authLogger.interceptor.general.warn('Request token refused as expired — retrying once, signed afresh');

    const retried = await ctx.callBackend({ headers: signedRequestHeaders(session) }).catch((error) =>
    {
        authLogger.interceptor.general.error('Retry of a refused request token failed', error as Error);

        return null;
    });

    if (retried)
    {
        ctx.response = { ...retried };
    }
}

/**
 * What the backend's answer means for the session the request was signed with.
 *
 * Decided by the error code, never by the status alone: only the key-refused
 * family (`isSessionEndingCode`) ends the session — `SessionContextChangedError`,
 * a bound key presented from another browser family, among them. An expired key
 * the backend says renewal still admits (`isRenewableExpiry`) is the exception —
 * renewable, not finished — and is answered with the renewal prompt, cookies
 * kept. That is the key row's fact, read off the refusal: the cookie holds no
 * copy of the binding, and a key bound after it was sealed (at its first use, or
 * by the owner turning binding on elsewhere) is asked to renew all the same.
 * The renewal paths themselves never clear: their refusals
 * are answered by the renewal ceremony, and clearing there would end the session
 * the person was in the middle of repairing.
 */
function judgeAnswer(ctx: ResponseInterceptorContext): void
{
    const code = errorCodeOf(ctx.response.body);

    if (isRenewableExpiry(ctx.response.body))
    {
        ctx.response.body = refusalEnvelope(new SessionRenewalRequiredError()).body;

        return;
    }

    if (!ctx.response.ok && isSessionEndingCode(code) && !SESSION_RENEW_PATH_PATTERN.test(ctx.path))
    {
        authLogger.interceptor.general.warn('Backend refused the session key, clearing the session', { code });
        clear(ctx, 'key-refused');

        return;
    }

    if (ctx.metadata.refreshSession && ctx.response.status === 200)
    {
        refresh(ctx, ctx.metadata.inboundSession);
    }
}

/**
 * Whether this sign-out's answer ends everything this package keeps in the
 * browser, whatever state the session cookie was in: the backend revoked its
 * key (2xx), or answered 401 to the session this request presented — its
 * cookie unsealed and signed the request (`sessionValid`). That 401 is
 * deliberate: a key past its grace, or revoked elsewhere, answers 401 to the
 * sign-out, and keeping its cookies would leave a browser that cannot sign
 * out — nor is a renewal prompt the answer to a sign-out.
 *
 * A 401 to a sign-out that presented no session says nothing about the
 * browser's: a cross-site form POST arrives without the `SameSite=Lax` cookie,
 * and clearing on its 401 would sign the victim out with the key left live.
 * A 5xx or a network failure keeps the cookies — the key may still be live —
 * and the user retries.
 */
function signedOut(ctx: ResponseInterceptorContext): boolean
{
    return ctx.response.ok || (ctx.response.status === 401 && ctx.metadata.sessionValid === true);
}

/**
 * General Authentication Interceptor
 *
 * Applies to all paths except the unauthenticated ones
 * - Validates the session cookie and signs the request with its key
 * - Proposes what the answer means for the session
 */
export const generalAuthInterceptor: InterceptorRule =
    {
        pathPattern: '*',  // Match all paths, filter by requiresAuth()
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],

        request: async (ctx, next) =>
        {
            const sessionCookie = ctx.cookies.get(COOKIE_NAMES.SESSION);

            if (!requiresAuth(ctx.path) || !sessionCookie)
            {
                await next();

                return;
            }

            if (await authenticateFromCookie(ctx, sessionCookie))
            {
                await next();
            }
        },

        response: async (ctx, next) =>
        {
            if (ctx.metadata.sessionValid)
            {
                await retryExpiredToken(ctx);
            }

            if (ctx.path === '/_auth/logout' && signedOut(ctx))
            {
                clear(ctx, 'signed-out');
            }
            else if (ctx.metadata.sessionValid)
            {
                judgeAnswer(ctx);
            }

            await next();
        },
    };
