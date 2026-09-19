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
import { env } from '@spfn/core/config';
import { env as authEnv } from '@spfn/auth/config';
import { logger } from '@spfn/core/logger';
import { unsealPendingSession } from './session-helpers';
import { isSafeReturnPath } from '../lib/return-path';
import { bindingSessionFields } from './interceptors/session-binding';

export interface OAuthCallbackOptions
{
    /**
     * Default redirect URL if returnUrl is not provided
     * @default '/'
     */
    defaultRedirectUrl?: string;

    /**
     * Error redirect URL
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
     * handler redirects to it with `?challenge=` and `?returnUrl=`.
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
    const path = configured || authEnv.SPFN_AUTH_MFA_CONFIRM_PATH || DEFAULT_MFA_CONFIRM_PATH;
    const target = new URL(path, request.url);

    target.searchParams.set('challenge', challenge);
    target.searchParams.set('returnUrl', returnUrl);

    logger.debug('OAuth callback needs a second factor', { path });

    return NextResponse.redirect(target);
}

/** Where the second-factor page lives when nothing says otherwise. */
const DEFAULT_MFA_CONFIRM_PATH = '/auth/mfa';

/**
 * Create OAuth callback handler for Next.js API Route
 *
 * Handles the final step of OAuth flow:
 * 1. Gets userId, keyId from query params (set by backend)
 * 2. Gets privateKey from pending session cookie
 * 3. Creates full session and saves to cookie
 * 4. Redirects to returnUrl
 *
 * When the account has a second factor and this device is new to it (#95) the
 * backend sends `mfaChallenge` in place of `userId` and `keyId`. No session is
 * sealed; the browser goes to `SPFN_AUTH_MFA_CONFIRM_PATH` with the challenge,
 * and the session is sealed by `mfaVerifyInterceptor` once the page proves it.
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
    const errorRedirect = options?.errorRedirectUrl || '/auth/error';

    return async (request: NextRequest): Promise<NextResponse> =>
    {
        const searchParams = request.nextUrl.searchParams;
        const userId = searchParams.get('userId');
        const keyId = searchParams.get('keyId');
        const returnUrl = safeReturnUrl(searchParams.get('returnUrl'), defaultRedirect);
        const error = searchParams.get('error');

        // Handle error from backend
        if (error)
        {
            const errorUrl = new URL(errorRedirect, request.url);
            errorUrl.searchParams.set('error', error);

            return NextResponse.redirect(errorUrl);
        }

        const mfaChallenge = searchParams.get('mfaChallenge');

        if (mfaChallenge)
        {
            return mfaRedirect(request, mfaChallenge, returnUrl, options?.mfaPath);
        }

        // Validate required params
        if (!userId || !keyId)
        {
            logger.error('OAuth callback missing required params', { userId: !!userId, keyId: !!keyId });
            const errorUrl = new URL(errorRedirect, request.url);
            errorUrl.searchParams.set('error', 'Missing required parameters');

            return NextResponse.redirect(errorUrl);
        }

        try
        {
            // Get pending session from cookie
            const cookieStore = await cookies();
            const pendingCookie = cookieStore.get(COOKIE_NAMES.OAUTH_PENDING);

            if (!pendingCookie)
            {
                throw new Error('OAuth session expired. Please try again.');
            }

            const pendingSession = await unsealPendingSession(pendingCookie.value);

            // Verify keyId matches
            if (pendingSession.keyId !== keyId)
            {
                throw new Error('Session mismatch. Please try again.');
            }

            // Create full session.
            //
            // The binding fields ride the callback query, put there by the
            // backend that registered the key: this handler runs before any
            // route call, so the redirect is the only thing that can tell it the
            // key is short-lived. Nothing is authorized by them — the key row
            // expires when it says it does whatever the query claims — but a
            // cookie that did not carry them would take the unbound branch at the
            // first expiry and sign the person out instead of renewing.
            const ttl = getSessionTtl();
            const sessionToken = await sealSession({
                userId,
                privateKey: pendingSession.privateKey,
                keyId: pendingSession.keyId,
                algorithm: pendingSession.algorithm,
                ...bindingSessionFields(bindingFromQuery(searchParams), request.headers.get('user-agent')),
            }, ttl);

            // Build redirect response
            const redirectUrl = new URL(returnUrl, request.url);
            const response = NextResponse.redirect(redirectUrl);

            // Set session cookie
            response.cookies.set(COOKIE_NAMES.SESSION, sessionToken, {
                httpOnly: true,
                secure: env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: ttl,
                path: '/',
            });

            // Set keyId cookie
            response.cookies.set(COOKIE_NAMES.SESSION_KEY_ID, keyId, {
                httpOnly: true,
                secure: env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: ttl,
                path: '/',
            });

            // Readable CSRF cookie — the client mirrors it into x-spfn-csrf
            response.cookies.set(COOKIE_NAMES.CSRF, await deriveCsrfToken(keyId), {
                httpOnly: false,
                secure: env.NODE_ENV === 'production',
                sameSite: 'lax',
                maxAge: ttl,
                path: '/',
            });

            // Clear pending session cookie
            response.cookies.delete(COOKIE_NAMES.OAUTH_PENDING);

            logger.debug('OAuth callback completed', { userId, keyId });

            return response;
        }
        catch (error)
        {
            const err = error as Error;
            logger.error('OAuth callback failed', { error: err.message });

            const errorUrl = new URL(errorRedirect, request.url);
            errorUrl.searchParams.set('error', err.message);

            return NextResponse.redirect(errorUrl);
        }
    };
}
