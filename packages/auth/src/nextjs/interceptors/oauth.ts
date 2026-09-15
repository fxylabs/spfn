/**
 * OAuth Interceptors
 *
 * 1. oauthUrlInterceptor: OAuth URL 요청 시 키쌍 생성 및 state 주입
 * 2. oauthFinalizeInterceptor: OAuth 완료 시 pending session에서 세션 저장
 */

import type { InterceptorRule, ProxyAbort, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import { generateKeyPair } from '../../server/lib/crypto';
import { createOAuthState, generateOAuthNonce } from '../../server/lib/oauth/state';
import { sealSession } from '../../server/lib/session';
import { COOKIE_NAMES, getSessionTtl } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { isSafeReturnPath } from '../../lib/return-path';
import { sealPendingSession, unsealPendingSession } from '../session-helpers';
import { cookieSecure } from './cookie-options';
import { pushCsrfCookie } from './csrf';

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
                const sealed = await sealPendingSession(ctx.metadata.pendingSession);

                ctx.setCookies.push({
                    name: COOKIE_NAMES.OAUTH_PENDING,
                    value: sealed,
                    options: {
                        httpOnly: true,
                        secure: cookieSecure,
                        sameSite: 'lax', // OAuth 리다이렉트 허용
                        maxAge: 600, // 10분
                        path: '/',
                    },
                });

                // CSRF nonce cookie (double-submit against the state.nonce at callback)
                if (ctx.metadata.oauthCsrf)
                {
                    ctx.setCookies.push({
                        name: COOKIE_NAMES.OAUTH_CSRF,
                        value: ctx.metadata.oauthCsrf,
                        options: {
                            httpOnly: true,
                            secure: cookieSecure,
                            sameSite: 'lax',
                            maxAge: 600,
                            path: '/',
                        },
                    });
                }

                authLogger.interceptor.oauth?.debug?.('Pending session cookie set', {
                    keyId: ctx.metadata.pendingSession.keyId,
                });
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
 * Finalize 실패 시 에러 응답 설정 + pending 쿠키 정리
 */
function setFinalizeError(ctx: ResponseInterceptorContext, message: string): void
{
    ctx.response.ok = false;
    ctx.response.status = 401;
    ctx.response.statusText = 'Unauthorized';
    ctx.response.body = { success: false, message };

    ctx.setCookies.push({
        name: COOKIE_NAMES.OAUTH_PENDING,
        value: '',
        options: {
            httpOnly: true,
            secure: cookieSecure,
            sameSite: 'lax',
            maxAge: 0,
            path: '/',
        },
    });
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
        // 성공 응답일 때만 처리
        if (!ctx.response.ok)
        {
            await next();

            return;
        }

        const pendingCookie = ctx.cookies.get(COOKIE_NAMES.OAUTH_PENDING);
        if (!pendingCookie)
        {
            authLogger.interceptor.oauth?.warn?.('No pending session cookie found');
            setFinalizeError(ctx, 'OAuth session expired. Please try again.');
            await next();

            return;
        }

        try
        {
            // pending session에서 privateKey 복원
            const pendingSession = await unsealPendingSession(pendingCookie);

            // body에서 userId, keyId 추출
            const { userId, keyId } = ctx.response.body || {};

            if (!userId || !keyId)
            {
                authLogger.interceptor.oauth?.error?.('Missing userId or keyId in response');
                setFinalizeError(ctx, 'OAuth finalize failed: missing credentials');
                await next();

                return;
            }

            // keyId 일치 확인
            if (pendingSession.keyId !== keyId)
            {
                authLogger.interceptor.oauth?.error?.('KeyId mismatch', {
                    expected: pendingSession.keyId,
                    received: keyId,
                });
                setFinalizeError(ctx, 'OAuth session mismatch. Please try again.');
                await next();

                return;
            }

            // 세션 생성.
            // `userId` here is the value reflected by /_auth/oauth/finalize (a UI
            // convenience, not a trust anchor). It's safe to seal: keyId was matched
            // against the pending cookie above, the session is sealed, and the
            // backend re-derives identity from keyId on every request — see the
            // SECURITY note on the oauthFinalize route handler.
            const ttl = getSessionTtl();
            const sessionToken = await sealSession({
                userId,
                privateKey: pendingSession.privateKey,
                keyId: pendingSession.keyId,
                algorithm: pendingSession.algorithm,
            }, ttl);

            // 세션 쿠키 설정
            ctx.setCookies.push({
                name: COOKIE_NAMES.SESSION,
                value: sessionToken,
                options: {
                    httpOnly: true,
                    secure: cookieSecure,
                    sameSite: 'lax',
                    maxAge: ttl,
                    path: '/',
                },
            });

            // keyId 쿠키 설정
            ctx.setCookies.push({
                name: COOKIE_NAMES.SESSION_KEY_ID,
                value: keyId,
                options: {
                    httpOnly: true,
                    secure: cookieSecure,
                    sameSite: 'lax',
                    maxAge: ttl,
                    path: '/',
                },
            });

            // Set the readable CSRF cookie the client mirrors into a header
            await pushCsrfCookie(ctx.setCookies, keyId, ttl);

            // pending session 쿠키 삭제 (maxAge: 0)
            ctx.setCookies.push({
                name: COOKIE_NAMES.OAUTH_PENDING,
                value: '',
                options: {
                    httpOnly: true,
                    secure: cookieSecure,
                    sameSite: 'lax',
                    maxAge: 0,
                    path: '/',
                },
            });

            authLogger.interceptor.oauth?.debug?.('OAuth session finalized', {
                userId,
                keyId,
            });
        }
        catch (error)
        {
            const err = error as Error;
            authLogger.interceptor.oauth?.error?.('Failed to finalize OAuth session', err);
            setFinalizeError(ctx, err.message);
        }

        await next();
    },
};
