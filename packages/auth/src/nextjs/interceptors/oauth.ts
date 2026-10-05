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

import type { InterceptorRule, ProxyAbort, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';
import { generateKeyPair } from '../../server/lib/crypto';
import { createOAuthState, generateOAuthNonce } from '../../server/lib/oauth/state';
import { buildStartCookieName, legacyPendingCookie, namesEvictedByStart } from '../../server/lib/oauth/start-cookies';
import { sealSession } from '../../server/lib/session';
import { COOKIE_NAMES, getSessionTtl } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { isSafeReturnPath } from '../../lib/return-path';
import {
    isPendingSessionExpired,
    pendingCookieForKey,
    sealPendingSession,
    unsealPendingSession,
} from '../session-helpers';
import { cookieSecure } from './cookie-options';
import { pushCsrfCookie } from './csrf';
import { bindingSessionFields } from './session-binding';

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

/** An HttpOnly, SameSite=Lax cookie on `/` — the options every cookie this file writes uses. */
function lockedCookie(name: string, value: string, maxAge: number): SetCookie
{
    return {
        name,
        value,
        options: {
            httpOnly: true,
            secure: cookieSecure,
            sameSite: 'lax', // OAuth 리다이렉트 허용
            maxAge,
            path: '/',
        },
    };
}

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

    for (const name of [...namesEvictedByStart('pending', ctx.cookies), ...namesEvictedByStart('csrf', ctx.cookies)])
    {
        ctx.setCookies.push(lockedCookie(name, '', 0));
    }

    ctx.setCookies.push(lockedCookie(
        buildStartCookieName('pending', keyId, issuedAtMs),
        await sealPendingSession(ctx.metadata.pendingSession),
        START_COOKIE_TTL_SECONDS,
    ));

    // CSRF nonce cookie (double-submit against the state.nonce at callback)
    if (ctx.metadata.oauthCsrf)
    {
        ctx.setCookies.push(lockedCookie(
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
 * The 401 is this rule's own answer, not the backend's, and `proxyWroteError`
 * says so to the rules after it. `generalAuthInterceptor` expires the session on
 * a 401 because a backend 401 means the key was refused; a finalize that failed
 * here says nothing about the session the browser already holds, so the flag is
 * what keeps that session in place.
 *
 * Only the pending cookie this finalize read is expired, when it read one —
 * every other start's cookies stay, so a refusal here cannot break a sign-in
 * still in flight in another tab (#126). `reason` is the code the callback page
 * shows (`OAuthErrorReason`).
 */
function setFinalizeError(
    ctx: ResponseInterceptorContext,
    message: string,
    reason: 'expired' | 'invalid_state' | 'failed',
    readCookie?: string,
): void
{
    ctx.metadata.proxyWroteError = true;
    ctx.response.ok = false;
    ctx.response.status = 401;
    ctx.response.statusText = 'Unauthorized';
    ctx.response.body = { success: false, message, reason };

    if (readCookie)
    {
        ctx.setCookies.push(lockedCookie(readCookie, '', 0));
    }
}

/**
 * Whether a finalize repeats the one that installed the browser's current session.
 *
 * The first finalize clears the pending cookie, so a reload of the callback page
 * posts the same `userId`/`keyId` again with no pending cookie and the session it
 * sealed. The backend route keeps no state and answers 200 again; the session's
 * key id matching the body's is what makes this the same sign-in rather than a
 * different one. Both are server-issued ids, not secrets, so plain equality.
 *
 * The body's `userId` is only required to be present, never compared or used:
 * it is a UI convenience (see the SECURITY note on the oauthFinalize route), and
 * the repeat writes nothing, so nothing is taken on trust from it.
 */
function repeatsCurrentSession(ctx: ResponseInterceptorContext): boolean
{
    const { userId, keyId } = ctx.response.body || {};

    return Boolean(userId && keyId)
        && ctx.metadata.sessionValid === true
        && ctx.metadata.keyId === keyId;
}

/**
 * A backend success with no pending cookie: a repeat, or a finalize that cannot complete.
 *
 * A repeat is answered with the backend's success, unchanged, and writes no
 * cookie — there is no private key to seal with (the pending cookie is gone)
 * and none is needed: the session it would seal is the one already installed.
 * Anything else is refused without touching the session the browser holds.
 */
function answerWithoutPendingCookie(ctx: ResponseInterceptorContext): void
{
    if (repeatsCurrentSession(ctx))
    {
        authLogger.interceptor.oauth?.debug?.('Repeated finalize for the current session, answered unchanged', {
            keyId: ctx.metadata.keyId,
        });

        return;
    }

    authLogger.interceptor.oauth?.warn?.('No pending session cookie found');
    setFinalizeError(ctx, 'OAuth session expired. Please try again.', 'expired');
}

/**
 * Seal the session from the pending cookie this finalize's keyId names.
 *
 * `userId` here is the value reflected by /_auth/oauth/finalize (a UI
 * convenience, not a trust anchor). It's safe to seal: keyId is matched against
 * the pending cookie, the session is sealed, and the backend re-derives identity
 * from keyId on every request — see the SECURITY note on the oauthFinalize route
 * handler.
 */
async function finalizeFromPendingCookie(
    ctx: ResponseInterceptorContext,
    pendingCookie: { name: string; value: string },
): Promise<void>
{
    // pending session에서 privateKey 복원
    const pendingSession = await unsealPendingSession(pendingCookie.value);
    const { userId, keyId } = ctx.response.body || {};

    if (!userId || !keyId)
    {
        authLogger.interceptor.oauth?.error?.('Missing userId or keyId in response');
        setFinalizeError(ctx, 'OAuth finalize failed: missing credentials', 'failed', pendingCookie.name);

        return;
    }

    // keyId 일치 확인 — a legacy cookie can hold another start's key
    if (pendingSession.keyId !== keyId)
    {
        authLogger.interceptor.oauth?.error?.('KeyId mismatch', { expected: pendingSession.keyId, received: keyId });
        setFinalizeError(ctx, 'OAuth session mismatch. Please try again.', 'invalid_state', pendingCookie.name);

        return;
    }

    const ttl = getSessionTtl();
    const sessionToken = await sealSession({
        userId,
        privateKey: pendingSession.privateKey,
        keyId: pendingSession.keyId,
        algorithm: pendingSession.algorithm,
        ...bindingSessionFields(ctx.response.body, ctx.request.headers['user-agent']),
    }, ttl);

    pushFinalizedCookies(ctx, sessionToken, keyId, ttl, pendingCookie.name);
    await pushCsrfCookie(ctx.setCookies, keyId, ttl);

    authLogger.interceptor.oauth?.debug?.('OAuth session finalized', { userId, keyId });
}

/** The session and key-id cookies, plus the expiry of this start's pending cookie — that one only. */
function pushFinalizedCookies(
    ctx: ResponseInterceptorContext,
    sessionToken: string,
    keyId: string,
    ttl: number,
    pendingCookieName: string,
): void
{
    ctx.setCookies.push(lockedCookie(COOKIE_NAMES.SESSION, sessionToken, ttl));
    ctx.setCookies.push(lockedCookie(COOKIE_NAMES.SESSION_KEY_ID, keyId, ttl));
    ctx.setCookies.push(lockedCookie(pendingCookieName, '', 0));
}

/** The pending cookie the finalize body's keyId names, else the legacy one when the body has none. */
async function finalizePendingCookie(ctx: ResponseInterceptorContext): Promise<{ name: string; value: string } | undefined>
{
    const keyId = ctx.response.body?.keyId;

    return typeof keyId === 'string' && keyId
        ? await pendingCookieForKey(ctx.cookies, keyId)
        : legacyPendingCookie(ctx.cookies);
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
function refuseUnreadablePendingCookie(ctx: ResponseInterceptorContext, error: unknown, cookieName: string): void
{
    if (isPendingSessionExpired(error))
    {
        setFinalizeError(ctx, 'OAuth session expired. Please try again.', 'expired', cookieName);

        return;
    }

    setFinalizeError(ctx, 'OAuth session could not be verified. Please try again.', 'invalid_state', cookieName);
}

/**
 * OAuth Finalize Interceptor
 *
 * POST /_auth/oauth/finalize 요청을 가로채서
 * pending session에서 세션 저장
 */
export const oauthFinalizeInterceptor: InterceptorRule = {
    pathPattern: /^\/_auth\/oauth\/finalize$/,
    method: 'POST',

    response: async (ctx, next) =>
    {
        // 성공 응답일 때만 처리.
        //
        // A 202 is `ok` and is deliberately not one of them (#95): the callback
        // carried a second-factor challenge rather than a userId/keyId pair, so
        // there is no session to finalize yet. `mfaVerifyInterceptor` bakes its
        // own cookie from that body — picking this start's pending cookie by the
        // body's keyId — and the app page sends the person to the confirm screen;
        // sealing anything here would be sealing a session for a key whose
        // second factor has not been proved.
        if (!ctx.response.ok || ctx.response.status === 202)
        {
            await next();

            return;
        }

        // This start's own pending cookie, else the legacy fixed name (a start
        // made before per-start cookies).
        const pendingCookie = await finalizePendingCookie(ctx);

        if (!pendingCookie)
        {
            answerWithoutPendingCookie(ctx);
            await next();

            return;
        }

        try
        {
            await finalizeFromPendingCookie(ctx, pendingCookie);
        }
        catch (error)
        {
            authLogger.interceptor.oauth?.error?.('Failed to finalize OAuth session', error as Error);
            refuseUnreadablePendingCookie(ctx, error, pendingCookie.name);
        }

        await next();
    },
};
