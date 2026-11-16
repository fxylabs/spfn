/**
 * OAuth Interceptors
 *
 * 1. oauthUrlInterceptor: OAuth URL 요청 시 키쌍 생성 및 state 주입
 * 2. oauthFinalizeInterceptor: OAuth 완료 시 pending session에서 세션 저장
 *
 * Each start writes its own pending and CSRF cookie (`<base>.<issuedAt>.<id>`,
 * see `server/lib/oauth/start-cookies.ts`), so several sign-ins can be in flight
 * in one browser and each finalize reads and clears only its own (#126).
 */

import type { InterceptorRule, ProxyAbort, RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import { OAUTH_COOKIE_MISSING_MESSAGE } from '@spfn/auth/errors';
import { generateKeyPair } from '../../server/lib/crypto';
import { createOAuthState, generateOAuthNonce } from '../../server/lib/oauth/state';
import { buildStartCookieName, legacyPendingCookie, namesEvictedByStart } from '../../server/lib/oauth/start-cookies';
import { authLogger } from '../../server/logger';
import { isSafeReturnPath } from '../../lib/return-path';
import {
    isPendingSessionExpired,
    pendingCookieForKey,
    sealPendingSession,
    unsealPendingSession,
    type PendingSessionData,
} from '../session-helpers';
import { expiredCookie, packageCookie } from '../cookie-writer';
import { establish, writeCookie } from './session-decision';
import { rememberField, takeRemember } from './remember';
import { signedRequestHeaders } from './request-token';

/** The path this rule establishes a session on. */
export const ESTABLISHING_PATHS = ['/_auth/oauth/finalize'] as const;

/**
 * The start that takes `remember`. The choice is sealed into the start's pending
 * cookie and read back at finalize, whose own body cannot set it.
 */
export const REMEMBER_PATHS = ['/_auth/oauth/:provider/url'] as const;

/** How long a start's two cookies live — the state's own ten minutes. */
const START_COOKIE_TTL_SECONDS = 600;

const UNSAFE_RETURN_URL_MESSAGE = 'returnUrl must be a relative path within the app';

/**
 * Refuse an OAuth start whose `returnUrl` would leave the app.
 *
 * This is where the value has to be checked: the interceptor seals it into the
 * encrypted state, and every layer after this one — the backend `/url` routes,
 * the provider, the callback — sees only the sealed state and cannot recover
 * what the caller asked for. An unchecked value comes back as a redirect after
 * a real login, which is what turns a forgotten screen into an open redirect.
 *
 * Refused the same way the signup-link route refuses `returnPath`: 400 carrying
 * a ValidationError, so the typed client restores the same error class whether
 * the refusal came from here or from the backend.
 */
function refuseUnsafeReturnUrl(): ProxyAbort
{
    return {
        status: 400,
        body: {
            __type: 'ValidationError',
            message: UNSAFE_RETURN_URL_MESSAGE,
            error: {
                code: 'ValidationError',
                message: UNSAFE_RETURN_URL_MESSAGE,
            },
        },
    };
}

/**
 * OAuth URL Interceptor
 *
 * POST /_auth/oauth/:provider/url 요청을 가로채서
 * 키쌍 생성 및 state 주입 처리
 */
export const oauthUrlInterceptor: InterceptorRule = {
    pathPattern: /^\/_auth\/oauth\/\w+\/url$/,
    method: 'POST',

    request: async (ctx, next) =>
    {
        const provider = ctx.path.split('/')[3]; // google, github, etc.
        const remember = takeRemember(ctx);

        if (remember === null)
        {
            return;
        }

        const returnUrl = ctx.body?.returnUrl || '/';
        const metadata = ctx.body?.metadata as Record<string, unknown> | undefined;

        // `ctx.body` is whatever the caller posted, so the value reaching the rule
        // is not a string just because the route's schema says it is — the schema
        // runs at the backend, one hop after this. A non-string is refused here
        // rather than left to throw out of `isSafeReturnPath` as a 500.
        if (typeof returnUrl !== 'string' || !isSafeReturnPath(returnUrl))
        {
            authLogger.interceptor.oauth?.warn?.('OAuth start refused: returnUrl is not a path within the app', {
                provider,
            });
            ctx.abort = refuseUnsafeReturnUrl();

            return;
        }

        // 키쌍 생성
        const keyPair = generateKeyPair('ES256');

        // CSRF nonce: bound into the state AND set as the oauth_csrf cookie below,
        // so the backend callback can confirm the flow started in THIS browser.
        const csrfNonce = generateOAuthNonce();

        // state 생성 (publicKey 포함)
        const state = await createOAuthState({
            provider,
            returnUrl,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            nonce: csrfNonce,
            metadata,
        });

        // body에 state 주입
        if (!ctx.body)
        {
            ctx.body = {};
        }
        ctx.body.state = state;

        // pending session 저장용 metadata
        ctx.metadata.pendingSession = {
            privateKey: keyPair.privateKey,
            keyId: keyPair.keyId,
            algorithm: keyPair.algorithm,
            ...rememberField(remember),
        };
        ctx.metadata.oauthCsrf = csrfNonce;

        authLogger.interceptor.oauth?.debug?.('OAuth state created', {
            provider,
            keyId: keyPair.keyId,
        });

        await next();
    },

    response: async (ctx, next) =>
    {
        // 성공 응답이고 pending session이 있으면 쿠키 설정
        if (ctx.response.ok && ctx.metadata.pendingSession)
        {
            try
            {
                await pushStartCookies(ctx);
            }
            catch (error)
            {
                const err = error as Error;
                authLogger.interceptor.oauth?.error?.('Failed to set pending session', err);
            }
        }

        await next();
    },
};

/**
 * This start's two cookies, under names of its own, and the cap.
 *
 * Both names carry the same `issuedAt`, so the two halves of a start are evicted
 * together. At most five starts live in the jar: a sixth expires the oldest in
 * this same response. The legacy fixed names are never written.
 */
async function pushStartCookies(ctx: ResponseInterceptorContext): Promise<void>
{
    const { keyId } = ctx.metadata.pendingSession;
    const issuedAtMs = Date.now();

    const sealed = await sealPendingSession(ctx.metadata.pendingSession);

    for (const name of [...namesEvictedByStart('pending', ctx.cookies), ...namesEvictedByStart('csrf', ctx.cookies)])
    {
        writeCookie(ctx, expiredCookie(name));
    }

    writeCookie(ctx, packageCookie(buildStartCookieName('pending', keyId, issuedAtMs), sealed, START_COOKIE_TTL_SECONDS));

    // CSRF nonce cookie (double-submit against the state.nonce at callback)
    if (ctx.metadata.oauthCsrf)
    {
        writeCookie(ctx, packageCookie(
            buildStartCookieName('csrf', keyId, issuedAtMs),
            ctx.metadata.oauthCsrf,
            START_COOKIE_TTL_SECONDS,
        ));
    }

    authLogger.interceptor.oauth?.debug?.('Pending session cookie set', { keyId });
}

/**
 * Finalize 실패 시 에러 응답 설정 + pending 쿠키 정리
 *
 * The 401 is this rule's own answer, not the backend's. It carries no error code
 * of the key-refused family, so it says nothing about the session the browser
 * already holds, and that session stays.
 *
 * Only the pending cookie this finalize read is expired, when it read one —
 * every other start's cookies stay, so a refusal here cannot break a sign-in
 * still in flight in another tab (#126). `reason` is the code the callback page
 * shows (`OAuthErrorReason`).
 */
function setFinalizeError(
    ctx: ResponseInterceptorContext,
    message: string,
    reason: 'expired' | 'invalid_state' | 'no_cookie' | 'failed',
    readCookie?: string,
): void
{
    ctx.response.ok = false;
    ctx.response.status = 401;
    ctx.response.statusText = 'Unauthorized';
    ctx.response.body = { success: false, message, reason };

    if (readCookie)
    {
        writeCookie(ctx, expiredCookie(readCookie));
    }
}

/**
 * Whether a finalize repeats the one that installed the browser's current session.
 *
 * The first finalize clears the pending cookie, so a reload of the callback page
 * posts the same `keyId` again with no pending cookie and the session it sealed.
 * That request is signed by the session (`generalAuthInterceptor`) and the
 * backend answers its principal; the session's key id matching the body's is
 * what makes this the same sign-in rather than a different one. Both are
 * server-issued ids, not secrets, so plain equality.
 */
function repeatsCurrentSession(ctx: { body?: any; metadata: Record<string, any> }): boolean
{
    const keyId = ctx.body?.keyId;

    return typeof keyId === 'string'
        && ctx.metadata.sessionValid === true
        && ctx.metadata.keyId === keyId;
}

/**
 * Refuse a finalize before the backend is asked.
 *
 * The 401 is this rule's own answer, not the backend's: it carries no error code
 * of the key-refused family, so the session the browser already holds stays.
 * Only the pending cookie this finalize read is expired, when it read one —
 * every other start's cookies stay (#126). `reason` is the code the callback
 * page shows (`OAuthErrorReason`).
 */
function refuseFinalize(
    ctx: RequestInterceptorContext,
    message: string,
    reason: 'expired' | 'invalid_state' | 'no_cookie',
    readCookie?: string,
): void
{
    ctx.abort = { status: 401, body: { success: false, message, reason } };

    if (readCookie)
    {
        writeCookie(ctx, expiredCookie(readCookie));
    }
}

/**
 * Refuse a finalize whose pending cookie could not be used.
 *
 * The browser gets a fixed sentence, never the library's message — jose's text
 * about a JWE or an initialization vector says nothing a person can act on, and
 * the `OAuthCallback` page shows it. The full error is in the log. A seal past
 * its ten minutes is `expired`, told apart by jose's error class; anything else
 * is `invalid_state`.
 */
function refuseUnreadablePendingCookie(ctx: RequestInterceptorContext, error: unknown, cookieName: string): void
{
    authLogger.interceptor.oauth?.error?.('Failed to read the OAuth pending session', error as Error);

    if (isPendingSessionExpired(error))
    {
        refuseFinalize(ctx, 'OAuth session expired. Please try again.', 'expired', cookieName);

        return;
    }

    refuseFinalize(ctx, 'OAuth session could not be verified. Please try again.', 'invalid_state', cookieName);
}

/** The pending cookie the finalize body's keyId names, else the legacy one when the body has none. */
async function requestedPendingCookie(ctx: RequestInterceptorContext): Promise<{ name: string; value: string } | undefined>
{
    const keyId = ctx.body?.keyId;

    return typeof keyId === 'string' && keyId
        ? await pendingCookieForKey(ctx.cookies, keyId)
        : legacyPendingCookie(ctx.cookies);
}

/**
 * Sign the finalize with the key this start's pending cookie holds.
 *
 * The backend answers the principal the request is signed by (`oauthFinalizeAuth`),
 * so only the browser holding the key's private half learns whose it is. A
 * repeat of the finalize that installed the current session stays signed by that
 * session; anything else without a usable pending cookie is refused here.
 *
 * The answer is about the key being finalized, not about the session the browser
 * holds, so that session is not judged by it (`sessionValid` is lowered).
 */
async function signWithPendingKey(ctx: RequestInterceptorContext): Promise<void>
{
    const pendingCookie = await requestedPendingCookie(ctx);

    if (!pendingCookie)
    {
        if (!repeatsCurrentSession(ctx))
        {
            authLogger.interceptor.oauth?.warn?.('No pending session cookie found');
            refuseFinalize(ctx, OAUTH_COOKIE_MISSING_MESSAGE, 'no_cookie');
        }

        return;
    }

    const pending = await unsealPendingSession(pendingCookie.value).catch((error: unknown) =>
    {
        refuseUnreadablePendingCookie(ctx, error, pendingCookie.name);

        return null;
    });

    if (!pending)
    {
        return;
    }

    // A legacy cookie can hold another start's key
    if (typeof ctx.body?.keyId === 'string' && pending.keyId !== ctx.body.keyId)
    {
        authLogger.interceptor.oauth?.error?.('KeyId mismatch', { expected: pending.keyId, received: ctx.body.keyId });
        refuseFinalize(ctx, 'OAuth session mismatch. Please try again.', 'invalid_state', pendingCookie.name);

        return;
    }

    ctx.metadata.finalizePending = { cookieName: pendingCookie.name, session: pending };
    ctx.metadata.sessionValid = false;
    Object.assign(ctx.headers, signedRequestHeaders(pending));
}

/**
 * A success with no pending key: the repeat the request phase let through, as
 * long as the answer names the session's own key. Anything else is refused with
 * `no_cookie` (#129) — the browser kept none of the start's cookies — without
 * touching the session it holds.
 */
async function answerRepeat(ctx: ResponseInterceptorContext): Promise<void>
{
    const { userId, keyId } = ctx.response.body || {};

    if (userId && keyId && ctx.metadata.sessionValid === true && ctx.metadata.keyId === keyId)
    {
        authLogger.interceptor.oauth?.debug?.('Repeated finalize for the current session, answered unchanged', { keyId });

        return;
    }

    authLogger.interceptor.oauth?.warn?.('No pending session cookie found');
    setFinalizeError(ctx, OAUTH_COOKIE_MISSING_MESSAGE, 'no_cookie');
}

/**
 * Establish the session from the pending key the finalize was signed with.
 *
 * `userId` is the backend's: the principal it admitted for this key's signature,
 * so `getSession().userId` is the account the key in this cookie belongs to.
 */
async function finalizeFromPendingKey(
    ctx: ResponseInterceptorContext,
    pending: { cookieName: string; session: PendingSessionData },
): Promise<void>
{
    const { userId, keyId } = ctx.response.body || {};

    if (!userId || keyId !== pending.session.keyId)
    {
        authLogger.interceptor.oauth?.error?.('Finalize answered for another key', { expected: pending.session.keyId, received: keyId });
        setFinalizeError(ctx, 'OAuth session mismatch. Please try again.', 'invalid_state', pending.cookieName);

        return;
    }

    await establish(ctx, {
        userId: String(userId),
        privateKey: pending.session.privateKey,
        keyId: pending.session.keyId,
        algorithm: pending.session.algorithm,
        ...rememberField(pending.session.remember),
    });

    // This start's pending cookie, that one only
    writeCookie(ctx, expiredCookie(pending.cookieName));

    authLogger.interceptor.oauth?.debug?.('OAuth session finalized', { userId, keyId });
}

/**
 * OAuth Finalize Interceptor
 *
 * Request: signs the call with this start's pending key (after
 * `generalAuthInterceptor` has signed it with the session, which a repeat keeps).
 * Response: establishes the session from that key.
 */
export const oauthFinalizeInterceptor: InterceptorRule = {
    pathPattern: /^\/_auth\/oauth\/finalize$/,
    method: 'POST',

    request: async (ctx, next) =>
    {
        await next();

        // The second-factor 202 echoes; its key is parked, so nothing signs it
        if (!ctx.abort && typeof ctx.body?.mfaChallenge !== 'string')
        {
            await signWithPendingKey(ctx);
        }
    },

    response: async (ctx, next) =>
    {
        // 성공 응답일 때만 처리.
        //
        // A 202 is `ok` and is deliberately not one of them (#95): the callback
        // carried a second-factor challenge rather than a key to finalize, so
        // there is no session yet. `mfaVerifyInterceptor` bakes its own cookie
        // from that body — picking this start's pending cookie by the body's
        // keyId — and the app page sends the person to the confirm screen.
        // A repeat (no pending key) is answered with the backend's success,
        // unchanged: the session it would seal is the one already installed.
        if (ctx.response.ok && ctx.response.status !== 202)
        {
            await (ctx.metadata.finalizePending
                ? finalizeFromPendingKey(ctx, ctx.metadata.finalizePending)
                : answerRepeat(ctx));
        }

        await next();
    },
};

/**
 * OAuth Link Interceptor (#154)
 *
 * POST /_auth/oauth/:provider/link — a signed-in user starting to attach a
 * provider identity. Checks the returnUrl here for the reason a sign-in start
 * does, then injects a CSRF nonce and a start id and, on success, sets the CSRF
 * cookie under that id. No key pair and no pending cookie: a link registers no
 * device key, the session it is made from stays the session.
 *
 * Runs before `generalAuthInterceptor`, which signs the request with the
 * session's key — the route is authenticated, unlike the sign-in starts.
 */
export const oauthLinkInterceptor: InterceptorRule = {
    pathPattern: /^\/_auth\/oauth\/\w+\/link$/,
    method: 'POST',

    request: async (ctx, next) =>
    {
        const returnUrl = ctx.body?.returnUrl || '/';

        if (typeof returnUrl !== 'string' || !isSafeReturnPath(returnUrl))
        {
            authLogger.interceptor.oauth?.warn?.('OAuth link refused: returnUrl is not a path within the app', {
                provider: ctx.path.split('/')[3],
            });
            ctx.abort = refuseUnsafeReturnUrl();

            return;
        }

        const linkStart = { nonce: generateOAuthNonce(), startId: generateOAuthNonce() };

        ctx.body = { ...(ctx.body ?? {}), returnUrl, ...linkStart };
        ctx.metadata.oauthLinkStart = linkStart;

        await next();
    },

    response: async (ctx, next) =>
    {
        if (ctx.response.ok && ctx.metadata.oauthLinkStart)
        {
            pushLinkCsrfCookie(ctx);
        }

        await next();
    },
};

/** The link start's CSRF cookie, under the start-cookie cap a sign-in start keeps. */
function pushLinkCsrfCookie(ctx: ResponseInterceptorContext): void
{
    const { nonce, startId } = ctx.metadata.oauthLinkStart;

    for (const name of namesEvictedByStart('csrf', ctx.cookies))
    {
        writeCookie(ctx, expiredCookie(name));
    }

    writeCookie(ctx, packageCookie(buildStartCookieName('csrf', startId), nonce, START_COOKIE_TTL_SECONDS));
}
