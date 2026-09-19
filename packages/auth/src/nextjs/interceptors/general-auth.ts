/**
 * General Authentication Interceptor
 *
 * Handles authentication for all API requests except login/register
 * - Session validation and renewal
 * - JWT generation and signing
 * - Expired session cleanup
 */

import type { InterceptorRule, RequestInterceptorContext } from '@spfn/core/nextjs/server';
import { SessionContextChangedError, SessionRenewalRequiredError } from '@spfn/auth/errors';
import { unsealSession, sealSession, shouldRefreshSession, type SessionData } from '../../server/lib/session';
import { generateClientToken } from '../../server/lib/crypto';
import { getSessionTtl, COOKIE_NAMES } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { cookieSecure } from './cookie-options';
import { uaFamily } from '../../server/lib/ua-family';
import { refuseInvalidCsrf, pushCsrfCookie, pushCsrfCookieIfStale, pushCsrfCookieRemoval } from './csrf';
import { refusalEnvelope } from './error-envelope';
import { SESSION_RENEW_PATH_PATTERN } from './session-renew';

/**
 * Check if path requires authentication
 */
function requiresAuth(path: string): boolean
{
    // Paths that don't require auth
    const publicPaths = [
        /^\/_auth\/login$/,
        /^\/_auth\/register$/,
        /^\/_auth\/codes$/,           // Send verification code
        /^\/_auth\/codes\/verify$/,   // Verify code
        /^\/_auth\/exists$/,           // Check account exists
        // The two halves of a second-factor step-up (#95). Public for the same
        // reason `login` is — the key they activate is inactive until they
        // succeed, so there is nothing to sign them with — and public *here* for
        // one more: a browser holding a stale session cookie would otherwise have
        // this rule refresh or clear that session on the way out, over the fresh
        // one `mfaVerifyInterceptor` just sealed.
        /^\/_auth\/mfa\/verify$/,
        /^\/_auth\/mfa\/verify\/options$/,
    ];

    return !publicPaths.some((pattern) => pattern.test(path));
}

/**
 * Whether a bound session arrived from a different browser than it was sealed in.
 *
 * Three terms, and each one is a rule.
 *
 * Bound only. An unbound session is not checked and nothing is logged for it —
 * the check would be a warn line per request for every account that did not opt
 * in, which is the noisy half of a protection they did not ask for.
 *
 * A `user-agent` has to be present. Absent is no signal, not a different family:
 * a server component's `api.` call reaches this proxy as Node `fetch` and the
 * isomorphic client sets `Content-Type`, `Cookie` and the CSRF header and nothing
 * else, so fail-closed on absence would refuse every server-rendered page view.
 *
 * And the comparison is between families rather than strings, so a version bump,
 * a user-agent reduction, or "Request desktop site" on Android are all the same
 * browser. What is left is a session presented from a different cookie jar, which
 * is a thing that does not happen without a copy.
 */
function contextChanged(session: SessionData, userAgent: string | null): boolean
{
    return session.binding === 'passkey'
        && Boolean(session.uaFamily)
        && Boolean(userAgent)
        && uaFamily(userAgent) !== session.uaFamily;
}

/**
 * Refuse a bound session presented from another browser, and empty the jar.
 *
 * The opposite of the renewal refusal the response phase mints: this session is
 * not waiting for a prompt, it is one whose cookie is somewhere it was never
 * sealed. The three cookies go with the refusal, which is the only moment a
 * refused request can touch them — and it is the one check this layer makes
 * alone, because the backend never sees the browser's `user-agent`.
 */
function refuseAsContextChanged(ctx: RequestInterceptorContext): void
{
    authLogger.interceptor.general.warn('Bound session presented from a different browser family', {
        path: ctx.path,
        sealed: ctx.metadata.sealedUaFamily,
        presented: ctx.metadata.presentedUaFamily,
    });

    const cleared = [
        { name: COOKIE_NAMES.SESSION, value: '', options: { maxAge: 0, path: '/' } },
        { name: COOKIE_NAMES.SESSION_KEY_ID, value: '', options: { maxAge: 0, path: '/' } },
        { name: COOKIE_NAMES.CSRF, value: '', options: { maxAge: 0, path: '/' } },
    ];

    ctx.abort = refusalEnvelope(new SessionContextChangedError(), cleared);
}

/**
 * Whether a backend 401 is the one that says the device key has expired.
 *
 * Read off `__type`, which is what the error envelope classifies by; the string
 * is the class name, and it is compared rather than imported because the body
 * here is JSON off the wire rather than an error instance.
 */
function isKeyExpiredRefusal(body: unknown): boolean
{
    return (body as { __type?: unknown } | null)?.__type === 'KeyExpiredError';
}

/**
 * General Authentication Interceptor
 *
 * Applies to all paths except login/register/codes
 * - Validates session
 * - Generates JWT token
 * - Refreshes session if needed
 * - Clears expired sessions
 */
export const generalAuthInterceptor: InterceptorRule =
    {
        pathPattern: '*',  // Match all paths, filter by requiresAuth()
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],

        request: async (ctx, next) =>
        {
        // Skip if path doesn't require auth
            if (!requiresAuth(ctx.path))
            {
                authLogger.interceptor.general.debug(`Public path, skipping auth: ${ctx.path}`);
                await next();

                return;
            }

            // Log available cookies
            const cookieNames = Array.from(ctx.cookies.keys());
            authLogger.interceptor.general.debug('Available cookies:', {
                cookieNames,
                totalCount: cookieNames.length,
                lookingFor: COOKIE_NAMES.SESSION,
            });

            const sessionCookie = ctx.cookies.get(COOKIE_NAMES.SESSION);

            authLogger.interceptor.general.debug('Request', {
                method: ctx.method,
                path: ctx.path,
                hasSession: !!sessionCookie,
                sessionLength: sessionCookie?.length ?? 0,
                sessionPrefix: sessionCookie?.slice(0, 20) ?? '',
                sessionSuffix: sessionCookie?.slice(-10) ?? '',
            });

            // No session cookie
            if (!sessionCookie)
            {
                authLogger.interceptor.general.debug('No session cookie, proceeding without auth');
                // Let request proceed - server will return 401
                await next();

                return;
            }

            try
            {
            // Decrypt and validate session
                const session = await unsealSession(sessionCookie);

                authLogger.interceptor.general.debug('Session valid', {
                    userId: session.userId,
                    keyId: session.keyId,
                });

                // The request is authenticated from the session cookie — the one
                // fact only this layer knows, and the whole reason the CSRF check
                // lives here. Refusals stop before the backend is called.
                if (await refuseInvalidCsrf(ctx, session.keyId))
                {
                    return;
                }

                // Context before expiry. A session whose cookie has moved to
                // another browser is finished whether or not its key is still
                // live, and answering it "renew with your passkey" would keep
                // exactly the cookies that need to go.
                const presented = ctx.request.headers.get('user-agent');

                if (contextChanged(session, presented))
                {
                    ctx.metadata.sealedUaFamily = session.uaFamily;
                    ctx.metadata.presentedUaFamily = uaFamily(presented);
                    refuseAsContextChanged(ctx);

                    return;
                }

                // Check if session should be refreshed (within 24h of expiry)
                const needsRefresh = await shouldRefreshSession(sessionCookie, 24);

                if (needsRefresh)
                {
                    authLogger.interceptor.general.debug('Session needs refresh (within 24h of expiry)');
                    // Mark for session renewal in response interceptor
                    ctx.metadata.refreshSession = true;
                    ctx.metadata.sessionData = session;
                }

                // Generate JWT token
                const token = generateClientToken(
                    {
                        userId: session.userId,
                        keyId: session.keyId,
                        timestamp: Date.now(),
                    },
                    session.privateKey,
                    session.algorithm,
                    { expiresIn: '15m' },
                );

                authLogger.interceptor.general.debug('Generated JWT token (expires in 15m)');

                // Add authentication headers
                ctx.headers['Authorization'] = `Bearer ${token}`;
                ctx.headers['X-Key-Id'] = session.keyId;

                // Store session info in metadata
                ctx.metadata.userId = session.userId;
                ctx.metadata.keyId = session.keyId;
                ctx.metadata.sessionValid = true;
                ctx.metadata.sessionBound = session.binding === 'passkey';
            }
            catch (error)
            {
                const err = error as Error;
                const msg = err.message.toLowerCase();

                // Session expired or invalid
                if (msg.includes('expired') || msg.includes('invalid'))
                {
                    authLogger.interceptor.general.warn('Session expired or invalid', {
                        message: err.message,
                        cookieLength: sessionCookie.length,
                        cookiePrefix: sessionCookie.slice(0, 20),
                        cookieSuffix: sessionCookie.slice(-10),
                    });
                    authLogger.interceptor.general.debug('Marking session for cleanup');

                    // Mark for cleanup in response interceptor
                    ctx.metadata.clearSession = true;
                    ctx.metadata.sessionValid = false;
                }
                else
                {
                    authLogger.interceptor.general.error('Failed to process session', err);
                }
            }

            await next();
        },

        response: async (ctx, next) =>
        {
        // A bound session the backend refused as expired. This is the only place
        // the renewal prompt is minted, and deliberately so: the cookie's copy of
        // the expiry is a hint, the key row is the fact, and a proxy that refused
        // on the hint alone would strand a session whose key was made long-lived
        // again on another device. The cookies stay — the session is renewable,
        // not finished.
            if (ctx.response.status === 401
                && ctx.metadata.sessionValid
                && ctx.metadata.sessionBound
                && isKeyExpiredRefusal(ctx.response.body))
            {
                ctx.response.body = refusalEnvelope(new SessionRenewalRequiredError()).body;

                await next();

                return;
            }

            // Backend returned 401 with a valid session — server rejected it.
            //
            // Never on the renewal paths. They are signed like any other path, so
            // `sessionValid` is set there and this branch would otherwise fire on
            // the refusal a renewal answers with — emptying the cookie jar, and
            // with it the session the person was in the middle of repairing.
            if (ctx.response.status === 401
                && ctx.metadata.sessionValid
                && !SESSION_RENEW_PATH_PATTERN.test(ctx.path))
            {
                authLogger.interceptor.general.warn('Backend returned 401, clearing session');

                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION,
                    value: '',
                    options: { maxAge: 0, path: '/' },
                });

                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION_KEY_ID,
                    value: '',
                    options: { maxAge: 0, path: '/' },
                });

                pushCsrfCookieRemoval(ctx.setCookies);

                await next();

                return;
            }

            // Clear expired/invalid session
            if (ctx.metadata.clearSession)
            {
                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION,
                    value: '',
                    options: {
                        maxAge: 0,
                        path: '/',
                    },
                });

                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION_KEY_ID,
                    value: '',
                    options: {
                        maxAge: 0,
                        path: '/',
                    },
                });

                pushCsrfCookieRemoval(ctx.setCookies);
            }
            // Refresh session if needed and request was successful
            else if (ctx.metadata.refreshSession && ctx.response.status === 200)
            {
                try
                {
                    const sessionData = ctx.metadata.sessionData;
                    const ttl = getSessionTtl();

                    // Re-encrypt session with new TTL. The object is the one
                    // unsealed on the way in, so a bound session's `binding`,
                    // `keyExpiresAt` and `uaFamily` survive the refresh — this is
                    // the one sealing site that carries them for free, and the
                    // reason it must go on re-sealing the whole object rather
                    // than rebuilding the four-field literal.
                    const sealed = await sealSession(sessionData, ttl);

                    // Update session cookie
                    ctx.setCookies.push({
                        name: COOKIE_NAMES.SESSION,
                        value: sealed,
                        options: {
                            httpOnly: true,
                            secure: cookieSecure,
                            sameSite: 'lax',
                            maxAge: ttl,
                            path: '/',
                        },
                    });

                    // Update keyId cookie
                    ctx.setCookies.push({
                        name: COOKIE_NAMES.SESSION_KEY_ID,
                        value: sessionData.keyId,
                        options: {
                            httpOnly: true,
                            secure: cookieSecure,
                            sameSite: 'lax',
                            maxAge: ttl,
                            path: '/',
                        },
                    });

                    // Renewed session, renewed CSRF cookie — same lifetime, so the
                    // readable value never outlives the session it belongs to.
                    await pushCsrfCookie(ctx.setCookies, sessionData.keyId, ttl);

                    authLogger.interceptor.general.info('Session refreshed', {
                        userId: sessionData.userId,
                        sealedLength: sealed.length,
                        sealedPrefix: sealed.slice(0, 20),
                    });
                }
                catch (error)
                {
                    const err = error as Error;
                    authLogger.interceptor.general.error('Failed to refresh session', err);
                }
            }
            // Handle logout (clear session)
            else if (ctx.path === '/_auth/logout' && ctx.response.ok)
            {
                const base = {
                    httpOnly: true,
                    secure: cookieSecure,
                    maxAge: 0,
                    path: '/',
                };

                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION,
                    value: '',
                    options: { ...base, sameSite: 'lax' },
                });

                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION_KEY_ID,
                    value: '',
                    options: { ...base, sameSite: 'lax' },
                });

                ctx.setCookies.push({
                    name: COOKIE_NAMES.OAUTH_PENDING,
                    value: '',
                    options: { ...base, sameSite: 'lax' },
                });

                pushCsrfCookieRemoval(ctx.setCookies);
            }

            // A session that predates CSRF protection carries no readable cookie,
            // and renewal only happens near expiry — an app switching to enforce
            // would otherwise refuse every mutation from everyone already signed
            // in, for days. Issue it on any authenticated response whose cookie is
            // missing or no longer matches; reads pass the check, so a page load
            // is enough to heal.
            const csrfQueued = ctx.setCookies.some(cookie => cookie.name === COOKIE_NAMES.CSRF);

            if (ctx.metadata.sessionValid && !csrfQueued)
            {
                await pushCsrfCookieIfStale(
                    ctx.setCookies,
                    ctx.cookies.get(COOKIE_NAMES.CSRF),
                    ctx.metadata.keyId,
                );
            }

            await next();
        },
    };
