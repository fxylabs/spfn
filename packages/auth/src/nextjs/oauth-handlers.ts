/**
 * OAuth Handlers for Next.js
 *
 * Helper functions to create OAuth callback route handlers
 */

import { NextRequest, NextResponse } from 'next/server.js';
import { CSRF_HEADER } from '../server/lib/csrf';
import { COOKIE_NAMES } from '../server/lib/config';
import { logger } from '@spfn/core/logger';
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { isSafeReturnPath } from '../lib/return-path';
import { resolveMfaConfirmPath } from './mfa-confirm-path';
import {
    OAUTH_ERROR_MESSAGES,
    callbackQueryReason,
    isOAuthErrorReason,
    oauthErrorCode,
    type OAuthErrorReason,
} from '../lib/oauth-error-reason';
import { routeMap as authRouteMap } from '../generated/route-map';
import { authInterceptors } from './interceptors';

export interface OAuthCallbackOptions
{
    /**
     * Default redirect URL if returnUrl is not provided
     * @default '/'
     */
    defaultRedirectUrl?: string;

    /**
     * Error redirect URL. Every redirect to it carries `reason` (an
     * `OAuthErrorReason` code), `error` (the fixed sentence for it,
     * `OAUTH_ERROR_MESSAGES`) and, on `sign_in_refused`, `code` (the app's
     * `signIn.admit` refusal code) when the callback carried a valid one.
     * Never the callback URL's own `error` text (#489).
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
     * handler redirects to it with `?challenge=`, the start's `?keyId=` and
     * `?returnUrl=`, reduced to a path on this origin.
     *
     * @default env SPFN_AUTH_MFA_CONFIRM_PATH, then '/auth/mfa'
     */
    mfaPath?: string;

    /**
     * The app's RPC proxy — what its `/api/rpc/[routeName]` route exports from
     * `createRpcProxy(...)`. The handler completes the sign-in by calling its
     * `POST` in-process, so the session is decided by the same interceptor chain,
     * backend URL and proxy-guard key the app's own proxy uses. Pass it: that is
     * the normal form. Nothing records the proxy an app builds, so without it the
     * handler cannot find it, and an app proxy configured beyond the defaults (its
     * own `interceptors`, `apiUrl` or `proxySecret`) would finalize through a
     * different chain, silently.
     *
     * @default a proxy built as `createRpcProxy` builds one by default —
     *   `SPFN_API_URL`, `SPFN_PROXY_SECRET`, the registered interceptors — with
     *   `authInterceptors` in it
     */
    rpcProxy?: FinalizeProxy;
}

/** The part of an RPC proxy the callback calls. */
type FinalizeProxy = Pick<ReturnType<typeof createRpcProxy>, 'POST'>;

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
 *
 * The callback's `keyId` rides along when it carried one (#126): it names which
 * in-flight start's pending cookie holds the key, and the page passes it on to
 * `oauthFinalize` as `OAuthCallback` does.
 */
function mfaRedirect(
    request: NextRequest,
    flow: { challenge: string; keyId: string | null; returnUrl: string },
    configured?: string,
): NextResponse
{
    const path = resolveMfaConfirmPath(configured);
    const target = new URL(path, request.url);

    target.searchParams.set('challenge', flow.challenge);

    if (flow.keyId)
    {
        target.searchParams.set('keyId', flow.keyId);
    }

    target.searchParams.set('returnUrl', flow.returnUrl);

    logger.debug('OAuth callback needs a second factor', { path });

    return NextResponse.redirect(target);
}

/**
 * The error page, with the reason code, its fixed sentence and the app's
 * refusal code on its query (#489).
 */
function errorRedirect(request: NextRequest, errorUrl: string, reason: OAuthErrorReason, code?: string): NextResponse
{
    const target = new URL(errorUrl, request.url);

    target.searchParams.set('error', OAUTH_ERROR_MESSAGES[reason]);
    target.searchParams.set('reason', reason);

    if (code !== undefined)
    {
        target.searchParams.set('code', code);
    }

    return NextResponse.redirect(target);
}

/**
 * Create OAuth callback handler for Next.js API Route
 *
 * Handles the final step of OAuth flow by completing it through the RPC proxy —
 * the same `oauthFinalize` call the `OAuthCallback` page makes, with this
 * browser's cookies, run in-process by the proxy's own handler — and
 * redirecting with the cookies the proxy decided:
 * 1. Gets keyId from query params (set by backend)
 * 2. Posts it to the proxy's `oauthFinalize`, which finds this start's pending
 *    cookie, takes the user id the backend answers for that key, and writes the
 *    session through the one session decision
 * 3. Redirects to returnUrl carrying those cookies
 *
 * The handler seals nothing itself, so a `userId` on the callback query is not
 * read: the session is the backend's answer for the key, never the query's.
 *
 * When the account has a second factor and this device is new to it (#95) the
 * backend sends `mfaChallenge` in place of `userId`. No session is sealed; the
 * browser goes to `SPFN_AUTH_MFA_CONFIRM_PATH` with the challenge, and the
 * session is sealed by `mfaVerifyInterceptor` once the page proves it.
 *
 * Every failure redirects to `errorRedirectUrl` with a `reason` code (#126):
 * `cancelled`, `failed`, `expired`, `invalid_state` or `no_cookie` (#129) — or
 * the code the backend's own redirect already carried — and `error`, the fixed
 * sentence for it. The callback URL's `error` text is never passed on: anyone
 * can write it (#489). Its `code` is, on `sign_in_refused`, when it has the
 * shape of an app's refusal code (`oauthErrorCode`).
 *
 * @example
 * ```typescript
 * // /api/auth/callback/route.ts
 * import { createOAuthCallbackHandler } from '@spfn/auth/nextjs/server';
 * import { POST } from '@/app/api/rpc/[routeName]/route';
 *
 * export const GET = createOAuthCallbackHandler({ rpcProxy: { POST } });
 * ```
 */
export function createOAuthCallbackHandler(options?: OAuthCallbackOptions)
{
    const defaultRedirect = options?.defaultRedirectUrl || '/';
    const errorUrl = options?.errorRedirectUrl || '/auth/error';
    // Built on first use: `SPFN_API_URL` is read when a callback is handled, not when the route module loads
    let defaultProxy: FinalizeProxy | undefined;
    const rpcProxy = (): FinalizeProxy => options?.rpcProxy ?? (defaultProxy ??= defaultFinalizeProxy());

    return async (request: NextRequest): Promise<NextResponse> =>
    {
        const searchParams = request.nextUrl.searchParams;
        const keyId = searchParams.get('keyId');
        const returnUrl = safeReturnUrl(searchParams.get('returnUrl'), defaultRedirect);
        const error = searchParams.get('error');
        const mfaChallenge = searchParams.get('mfaChallenge');

        // Handle error from backend
        if (error)
        {
            const reason = callbackQueryReason(searchParams.get('reason'), error);

            return errorRedirect(request, errorUrl, reason, oauthErrorCode(reason, searchParams.get('code')));
        }

        if (mfaChallenge)
        {
            return mfaRedirect(request, { challenge: mfaChallenge, keyId, returnUrl }, options?.mfaPath);
        }

        if (!keyId)
        {
            logger.error('OAuth callback missing required params', { keyId: false });

            return errorRedirect(request, errorUrl, 'failed');
        }

        return await finishCallback(request, {
            keyId,
            returnUrl,
            errorUrl,
            rpcProxy: rpcProxy(),
        });
    };
}

/**
 * The proxy `oauthFinalize` runs through when the app passes none: the default
 * `createRpcProxy`, with this package's interceptors whether or not the app's
 * `@spfn/auth/nextjs/api` import has registered them in this bundle.
 */
function defaultFinalizeProxy(): FinalizeProxy
{
    return createRpcProxy({
        routeMap: { oauthFinalize: authRouteMap.oauthFinalize },
        disableAutoInterceptors: ['auth'],
        interceptors: authInterceptors,
    });
}

/**
 * Complete the sign-in through the proxy, then redirect carrying its cookies —
 * or to the error page with the reason the proxy named.
 */
async function finishCallback(
    request: NextRequest,
    input: FinalizeInput & { errorUrl: string },
): Promise<NextResponse>
{
    const finalized = await postFinalize(request, input).catch((error: unknown) =>
    {
        logger.error('OAuth callback failed', { error });

        return null;
    });

    if (!finalized?.ok)
    {
        return errorRedirect(request, input.errorUrl, await failureReasonOf(finalized));
    }

    const response = NextResponse.redirect(new URL(input.returnUrl, request.url));

    for (const cookie of finalized.headers.getSetCookie())
    {
        response.headers.append('Set-Cookie', cookie);
    }

    logger.debug('OAuth callback completed', { keyId: input.keyId });

    return response;
}

/** What the callback hands the proxy's `oauthFinalize`. */
interface FinalizeInput
{
    keyId: string;
    returnUrl: string;
    rpcProxy: FinalizeProxy;
}

/**
 * `oauthFinalize`, through the RPC proxy's own handler, in-process, as this browser.
 *
 * No HTTP hop: the request the proxy runs is the callback request itself — its
 * cookies, its user agent, its client address — with the readable CSRF token
 * mirrored into the header, exactly what the `OAuthCallback` page sends. Going
 * out through the app's public URL instead would meet whatever stands in front
 * of it (basic auth, an edge the server cannot call back through) and give the
 * proxy the server's own address for every user.
 */
async function postFinalize(request: NextRequest, input: FinalizeInput): Promise<Response>
{
    const headers = new Headers(request.headers);
    const csrf = request.cookies.get(COOKIE_NAMES.CSRF)?.value;

    headers.set('content-type', 'application/json');

    if (csrf)
    {
        headers.set(CSRF_HEADER, csrf);
    }

    const finalize = new NextRequest(new URL('/api/rpc/oauthFinalize', request.url), {
        method: 'POST',
        headers,
        body: JSON.stringify({ body: { keyId: input.keyId, returnUrl: input.returnUrl } }),
    });

    return await input.rpcProxy.POST(finalize, { params: Promise.resolve({ routeName: 'oauthFinalize' }) });
}

/** The reason the proxy named for its refusal (`failed` when none). */
async function failureReasonOf(response: Response | null): Promise<OAuthErrorReason>
{
    const data = response ? await response.json().catch(() => ({})) : {};

    return isOAuthErrorReason(data.reason) ? data.reason : 'failed';
}
