/**
 * OAuth Handlers for Next.js
 *
 * Helper functions to create OAuth callback route handlers
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers.js';
import { sealSession } from '../server/lib/session';
import { deriveCsrfToken } from '../server/lib/csrf';
import { COOKIE_NAMES, getSessionTtl } from '../server/lib/config';
import { pendingCookieFor } from '../server/lib/oauth/start-cookies';
import { env } from '@spfn/core/config';
import { logger } from '@spfn/core/logger';
import { unsealPendingSession, type PendingSessionData } from './session-helpers';
import { isSafeReturnPath } from '../lib/return-path';
import { bindingSessionFields } from './interceptors/session-binding';
import { resolveMfaConfirmPath } from './mfa-confirm-path';
import { callbackQueryReason, type OAuthErrorReason } from '../lib/oauth-error-reason';

export interface OAuthCallbackOptions
{
    /**
     * Default redirect URL if returnUrl is not provided
     * @default '/'
     */
    defaultRedirectUrl?: string;

    /**
     * Error redirect URL. Every redirect to it carries `error` (text) and
     * `reason` (an `OAuthErrorReason` code).
     * @default '/auth/error'
     */
    errorRedirectUrl?: string;

    /**
     * App page that asks for the second factor, when the callback carries a
     * step-up challenge instead of a session (#95).
     *
     * An override for `SPFN_AUTH_MFA_CONFIRM_PATH`, which is where every other
     * app-page path in this package lives; the env var is the one to set, and
     * this exists for an app mounting two handlers on different screens. The
     * handler redirects to it with `?challenge=` and `?returnUrl=`, reduced to a
     * path on this origin.
     *
     * @default env SPFN_AUTH_MFA_CONFIRM_PATH, then '/auth/mfa'
     */
    mfaPath?: string;
}

/**
 * The query's `returnUrl`, or the handler's default when it would leave the app.
 *
 * `new URL('https://evil.example.com', request.url)` resolves to the absolute URL,
 * not to a path under the app, so an unchecked value here redirects the browser
 * off-origin after a successful login. Only the destination is replaced — the
 * login stands and the session cookies are still set.
 */
function safeReturnUrl(requested: string | null, defaultRedirect: string): string
{
    return requested && isSafeReturnPath(requested) ? requested : defaultRedirect;
}

/**
 * The two binding values the backend put on the callback URL, in the shape the
 * sealing helper reads a sign-in response in.
 *
 * A malformed number comes out as `NaN`, which the helper's `typeof` check
 * accepts — so it is filtered here instead, and a query that cannot be read
 * seals an unbound session rather than one whose expiry is unusable.
 */
function bindingFromQuery(searchParams: URLSearchParams): { sessionBinding?: string; keyExpiresAtMillis?: number }
{
    const expiresAt = Number(searchParams.get('keyExpiresAtMillis'));

    if (searchParams.get('sessionBinding') !== 'passkey' || !Number.isFinite(expiresAt))
    {
        return {};
    }

    return { sessionBinding: 'passkey', keyExpiresAtMillis: expiresAt };
}

/**
 * Send the browser to the second-factor page, carrying the challenge (#95).
 *
 * No session is sealed and no cookie is touched. The OAuth pending cookie stays
 * where it is — it holds the private half of the key the challenge would
 * activate, and `mfaVerifyInterceptor` reads it when the page posts the proof.
 *
 * The challenge rides the query, as `userId` and `keyId` used to. Nothing else
 * is authorized by it: it spends at `POST /_auth/mfa/verify` and at no other
 * route, it is single use, it dies in ten minutes, and the request logger records
 * `pathname` only — so unlike #94's revoke-all link this is not a bearer
 * credential riding a URL.
 */
function mfaRedirect(
    request: NextRequest,
    challenge: string,
    returnUrl: string,
    configured?: string,
): NextResponse
{
    const path = resolveMfaConfirmPath(configured);
    const target = new URL(path, request.url);

    target.searchParams.set('challenge', challenge);
    target.searchParams.set('returnUrl', returnUrl);

    logger.debug('OAuth callback needs a second factor', { path });

    return NextResponse.redirect(target);
}

/** The error page, with the text and the reason code on its query. */
function errorRedirect(request: NextRequest, errorUrl: string, error: string, reason: OAuthErrorReason): NextResponse
{
    const target = new URL(errorUrl, request.url);

    target.searchParams.set('error', error);
    target.searchParams.set('reason', reason);

    return NextResponse.redirect(target);
}

/** Why a pending session could not be had for `keyId`, or the session itself. */
type PendingLookup =
    | { ok: true; pending: PendingSessionData; cookieName: string }
    | { ok: false; error: string; reason: OAuthErrorReason };

/**
 * This start's pending session, found by the callback's keyId (#126) — its own
 * cookie, else a legacy fixed-name one. A missing cookie is `expired`; one that
 * does not unseal, or holds another key, is `invalid_state`.
 */
async function lookUpPending(keyId: string): Promise<PendingLookup>
{
    const jar = (await cookies()).getAll().map(({ name, value }) => [name, value] as const);
    const cookie = pendingCookieFor(jar, keyId);

    if (!cookie)
    {
        return { ok: false, error: 'OAuth session expired. Please try again.', reason: 'expired' };
    }

    const pending = await unsealPendingSession(cookie.value).catch(() => null);

    if (pending?.keyId !== keyId)
    {
        return { ok: false, error: 'Session mismatch. Please try again.', reason: 'invalid_state' };
    }

    return { ok: true, pending, cookieName: cookie.name };
}

/**
 * Seal the session and answer with the redirect that installs it.
 *
 * The binding fields ride the callback query, put there by the backend that
 * registered the key: this handler runs before any route call, so the redirect
 * is the only thing that can tell it the key is short-lived. Nothing is
 * authorized by them — the key row expires when it says it does whatever the
 * query claims — but a cookie that did not carry them would take the unbound
 * branch at the first expiry and sign the person out instead of renewing.
 *
 * Only this start's pending cookie is cleared; other starts in flight keep theirs.
 */
async function sessionRedirect(
    request: NextRequest,
    session: { userId: string; returnUrl: string; found: Extract<PendingLookup, { ok: true }> },
): Promise<NextResponse>
{
    const { pending, cookieName } = session.found;
    const ttl = getSessionTtl();
    const sessionToken = await sealSession({
        userId: session.userId,
        privateKey: pending.privateKey,
        keyId: pending.keyId,
        algorithm: pending.algorithm,
        ...bindingSessionFields(bindingFromQuery(request.nextUrl.searchParams), request.headers.get('user-agent')),
    }, ttl);
    const response = NextResponse.redirect(new URL(session.returnUrl, request.url));
    const options = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax' as const, maxAge: ttl, path: '/' };

    response.cookies.set(COOKIE_NAMES.SESSION, sessionToken, options);
    response.cookies.set(COOKIE_NAMES.SESSION_KEY_ID, pending.keyId, options);
    // Readable CSRF cookie — the client mirrors it into x-spfn-csrf
    response.cookies.set(COOKIE_NAMES.CSRF, await deriveCsrfToken(pending.keyId), { ...options, httpOnly: false });
    response.cookies.delete(cookieName);

    logger.debug('OAuth callback completed', { userId: session.userId, keyId: pending.keyId });

    return response;
}

/**
 * Create OAuth callback handler for Next.js API Route
 *
 * Handles the final step of OAuth flow:
 * 1. Gets userId, keyId from query params (set by backend)
 * 2. Gets privateKey from this start's pending session cookie, found by keyId
 * 3. Creates full session and saves to cookie
 * 4. Redirects to returnUrl
 *
 * When the account has a second factor and this device is new to it (#95) the
 * backend sends `mfaChallenge` in place of `userId`. No session is sealed; the
 * browser goes to `SPFN_AUTH_MFA_CONFIRM_PATH` with the challenge, and the
 * session is sealed by `mfaVerifyInterceptor` once the page proves it.
 *
 * Every failure redirects to `errorRedirectUrl` with `error` and a `reason`
 * code (#126): `cancelled`, `failed`, `expired` or `invalid_state`.
 *
 * @example
 * ```typescript
 * // /api/auth/callback/route.ts
 * import { createOAuthCallbackHandler } from '@spfn/auth/nextjs/server';
 * export const GET = createOAuthCallbackHandler();
 * ```
 */
export function createOAuthCallbackHandler(options?: OAuthCallbackOptions)
{
    const defaultRedirect = options?.defaultRedirectUrl || '/';
    const errorUrl = options?.errorRedirectUrl || '/auth/error';

    return async (request: NextRequest): Promise<NextResponse> =>
    {
        const searchParams = request.nextUrl.searchParams;
        const userId = searchParams.get('userId');
        const keyId = searchParams.get('keyId');
        const returnUrl = safeReturnUrl(searchParams.get('returnUrl'), defaultRedirect);
        const error = searchParams.get('error');
        const mfaChallenge = searchParams.get('mfaChallenge');

        // Handle error from backend
        if (error)
        {
            return errorRedirect(request, errorUrl, error, callbackQueryReason(searchParams.get('reason'), error));
        }

        if (mfaChallenge)
        {
            return mfaRedirect(request, mfaChallenge, returnUrl, options?.mfaPath);
        }

        // Validate required params
        if (!userId || !keyId)
        {
            logger.error('OAuth callback missing required params', { userId: !!userId, keyId: !!keyId });

            return errorRedirect(request, errorUrl, 'Missing required parameters', 'failed');
        }

        return await finishCallback(request, { userId, keyId, returnUrl, errorUrl });
    };
}

/** The pending lookup, then the session — or the error page with the lookup's reason. */
async function finishCallback(
    request: NextRequest,
    input: { userId: string; keyId: string; returnUrl: string; errorUrl: string },
): Promise<NextResponse>
{
    try
    {
        const found = await lookUpPending(input.keyId);

        if (!found.ok)
        {
            logger.error('OAuth callback failed', { error: found.error });

            return errorRedirect(request, input.errorUrl, found.error, found.reason);
        }

        return await sessionRedirect(request, { userId: input.userId, returnUrl: input.returnUrl, found });
    }
    catch (error)
    {
        const err = error as Error;
        logger.error('OAuth callback failed', { error: err.message });

        return errorRedirect(request, input.errorUrl, err.message, 'failed');
    }
}
