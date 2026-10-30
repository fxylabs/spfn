/**
 * @spfn/auth - OAuth Routes
 *
 * OAuth 인증 라우트
 * - GET /_auth/oauth/google: OAuth 시작 (Google로 리다이렉트)
 * - GET /_auth/oauth/google/callback: Google 콜백 처리
 * - POST /_auth/oauth/:provider/callback: form_post 콜백(Apple)을 GET 콜백으로 303
 *   (an Android sign-in's relay state: 303 to the configured App Link instead)
 * - POST /_auth/oauth/apple/native/start: Sign in with Apple on Android, the native start
 * - GET /_auth/oauth/providers: 활성화된 OAuth provider 목록
 * - POST /_auth/oauth/:provider/link: 로그인한 사용자가 provider 신원 연결을 시작 (#154)
 * - POST /_auth/oauth/:provider/unlink: 로그인한 사용자가 provider 신원 연결을 해제 (#154)
 */

import { Type } from '@sinclair/typebox';
import { type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Transactional } from '@spfn/core/db';
import { ValidationError } from '@spfn/core/errors';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { defineRouter, route } from '@spfn/core/route';
import { OAuthProviderError, OAuthProviderLinkOnlyError } from '@spfn/auth/errors';

import { KEY_ALGORITHM, SOCIAL_PROVIDERS, type SessionBindingType, type SocialProvider } from '../../types';
import { DeviceNameSchema, OAuthNativeProfileSchema, PlatformSchema } from '../schema';
import { buildStartCookieName, namesEvictedByStart } from '../../lib/oauth/start-cookies';
import { providerErrorReason } from '../../../lib/oauth-error-reason';
import { byIpAndCaller, byIpAndIdToken } from '../../lib/rate-limit-keys';
import { getAuth } from '../../helpers';
import { type OAuthLinkOutcome } from '../../../lib/oauth-link-outcome';
import { deviceProvenance } from '../../lib/device-provenance';
import {
    oauthStartService,
    oauthCallbackService,
    matchOAuthCallbackCsrf,
    matchOAuthLinkCsrf,
    oauthErrorReason,
    oauthNativeService,
    oauthUnlinkNotifyService,
    buildOAuthErrorUrl,
    getEnabledOAuthProviders,
    requireSignInProvider,
    isSafeReturnPath,
    keySessionBindingService,
    startOAuthLinkService,
    oauthLinkCallbackService,
    oauthLinkResultUrl,
    unlinkOAuthService,
} from '../../services';
import { assertSignInProvider, isSignInProvider } from '../../lib/config';
import { isGoogleOAuthEnabled, getGoogleAuthUrl, getOAuthProvider, UnlinkNotifyRejection } from '../../lib/oauth';
import {
    APPLE_RELAY_APP_STATE_PATTERN,
    generateOAuthNonce,
    openOAuthLinkState,
    type OAuthLinkState,
} from '../../lib/oauth/state';
import { appleRelayLocation, startAppleRelay } from '../../lib/oauth/apple-relay';

/**
 * path param의 provider 타입 (등록 가능한 모든 소셜 provider)
 */
const providerParams = Type.Object({
    provider: Type.Union(SOCIAL_PROVIDERS.map(p => Type.Literal(p)), {
        description: 'OAuth provider id (google, apple, github, kakao, naver, superself, battlenet)',
    }),
});

/** The error page for a sign-in start that named a link-only provider (#157). */
function linkOnlyErrorUrl(): string
{
    return buildOAuthErrorUrl(new OAuthProviderLinkOnlyError().message, 'link_only');
}

/** What a provider's redirect back to a callback route carries. */
interface CallbackQuery
{
    code?: string;
    state?: string;
    /** Apple's `user` JSON (the name on a first authorization), carried over by the form_post hop. */
    user?: string;
    error?: string;
    error_description?: string;
}

/**
 * Where a provider's redirect back sends the browser — both callback routes.
 *
 * Every failure goes to the error URL with a `reason` code beside the text
 * (#126), classified by the error's type.
 */
async function oauthCallbackRedirect(c: Context, provider: SocialProvider, query: CallbackQuery): Promise<string>
{
    // A link started from a session (#154) comes back to this same route; its
    // state opens only under the link key, and an expired one is refused here.
    try
    {
        const link = query.state ? await openOAuthLinkState(query.state) : null;

        if (link)
        {
            return await oauthLinkCallbackRedirect(c, provider, query, link);
        }
    }
    catch (err)
    {
        return buildOAuthErrorUrl(err instanceof Error ? err.message : 'OAuth link failed', oauthErrorReason(err));
    }

    // provider에서 에러가 반환된 경우
    if (query.error)
    {
        return buildOAuthErrorUrl(query.error_description || query.error, providerErrorReason(query.error));
    }

    // code와 state 필수 확인
    if (!query.code || !query.state)
    {
        return buildOAuthErrorUrl('Missing authorization code or state', 'failed');
    }

    try
    {
        return await completeOAuthCallback(c, provider, query.code, query.state, query.user);
    }
    catch (err)
    {
        const message = err instanceof Error ? err.message : 'OAuth callback failed';

        return buildOAuthErrorUrl(message, oauthErrorReason(err));
    }
}

/**
 * The CSRF gate, then the sign-in.
 *
 * `matchOAuthCallbackCsrf` verifies the state before it reads any cookie, and
 * picks the CSRF cookie under that state's id whose value is its nonce. Only
 * that cookie is expired, and only once it matched — a refused callback expires
 * nothing, so another start in flight in this browser can still finish (#126).
 */
async function completeOAuthCallback(
    c: Context,
    provider: SocialProvider,
    code: string,
    state: string,
    user: string | undefined,
): Promise<string>
{
    const csrf = await matchOAuthCallbackCsrf({ provider, state, cookies: getCookie(c) });

    deleteCookie(c, csrf.name, { path: '/' });

    const result = await oauthCallbackService({
        provider,
        code,
        state,
        user,
        expectedNonce: csrf.nonce,
        ...deviceProvenance(c),
    });

    return result.redirectUrl;
}

/**
 * Where a link's callback sends the browser (#154).
 *
 * The CSRF gate runs first and its refusals go to the OAuth error URL, as a
 * sign-in's do: the state names the page to return to, but a browser that did
 * not start this link is not owed that page. Past the gate every outcome — the
 * provider's own error included — returns to the page the link started on.
 *
 * Throws only the CSRF refusals; the caller turns them into the error URL.
 */
async function oauthLinkCallbackRedirect(
    c: Context,
    provider: SocialProvider,
    query: CallbackQuery,
    link: OAuthLinkState,
): Promise<string>
{
    const csrfName = matchOAuthLinkCsrf({ provider, link, cookies: getCookie(c) });

    deleteCookie(c, csrfName, { path: '/' });

    if (query.error)
    {
        return oauthLinkResultUrl(link, providerErrorReason(query.error) === 'cancelled' ? 'cancelled' : 'provider_error');
    }

    if (!query.code || !query.state)
    {
        return oauthLinkResultUrl(link, 'failed');
    }

    const outcome = await oauthLinkCallbackService({ provider, code: query.code, state: query.state, link })
        .catch((err: unknown) => linkOutcomeOf(err));

    return oauthLinkResultUrl(link, outcome);
}

/** A failed link's outcome, by the error's type — the same classes a sign-in's reason reads. */
function linkOutcomeOf(err: unknown): OAuthLinkOutcome
{
    if (err instanceof OAuthProviderError)
    {
        return 'provider_error';
    }

    return oauthErrorReason(err) === 'account_unavailable' ? 'account_unavailable' : 'failed';
}

/**
 * GET /_auth/oauth/google - Google OAuth 시작
 *
 * Next.js에서 키쌍을 생성한 후 호출
 * state에 publicKey를 포함하여 Google로 리다이렉트
 */
export const oauthGoogleStart = route.get('/_auth/oauth/google')
    .input({
        query: Type.Object({
            state: Type.String({
                description: 'Encrypted OAuth state (returnUrl, publicKey, keyId, fingerprint, algorithm)',
            }),
        }),
    })
    .use([rateLimitPolicy('oauth-start', { limit: 20, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { query } = await c.data();

        if (!isGoogleOAuthEnabled())
        {
            return c.redirect(buildOAuthErrorUrl('Google OAuth is not configured'));
        }

        if (!isSignInProvider('google'))
        {
            return c.redirect(linkOnlyErrorUrl());
        }

        const authUrl = getGoogleAuthUrl(query.state);

        return c.redirect(authUrl);
    });

/**
 * GET /_auth/oauth/google/callback - Google OAuth 콜백
 *
 * Google에서 리다이렉트되는 콜백
 * code를 token으로 교환하고, state에서 publicKey를 추출하여 등록
 */
export const oauthGoogleCallback = route.get('/_auth/oauth/google/callback')
    .input({
        query: Type.Object({
            code: Type.Optional(Type.String({
                description: 'Authorization code from Google',
            })),
            state: Type.Optional(Type.String({
                description: 'OAuth state parameter',
            })),
            error: Type.Optional(Type.String({
                description: 'Error code from Google',
            })),
            error_description: Type.Optional(Type.String({
                description: 'Error description from Google',
            })),
        }),
    })
    .use([rateLimitPolicy('oauth-callback', { limit: 30, windowMs: 60_000 }), Transactional()])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { query } = await c.data();

        return c.redirect(await oauthCallbackRedirect(c.raw, 'google', query));
    });

/**
 * POST /_auth/oauth/start - 범용 OAuth 시작 (API 방식)
 *
 * 모든 provider에 대해 OAuth 시작 URL을 반환
 * Next.js API에서 state를 생성하여 호출할 때 사용
 */
export const oauthStart = route.post('/_auth/oauth/start')
    .input({
        body: Type.Object({
            provider: Type.Union(SOCIAL_PROVIDERS.map(p => Type.Literal(p)), {
                description: 'OAuth provider (google, github, kakao, naver)',
            }),
            returnUrl: Type.String({
                description: 'URL to redirect after OAuth success',
            }),
            publicKey: Type.String({
                description: 'Client public key (Base64 DER)',
            }),
            keyId: Type.String({
                description: 'Key identifier (UUID)',
            }),
            fingerprint: Type.String({
                description: 'Key fingerprint (SHA-256 hex)',
            }),
            algorithm: Type.Union(KEY_ALGORITHM.map(a => Type.Literal(a)), {
                description: 'Key algorithm (ES256 or RS256)',
            }),
            metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
                description: 'Custom metadata passed to authRegisterEvent (e.g. referral code, UTM params)',
            })),
        }),
    })
    .use([rateLimitPolicy('oauth-start', { limit: 20, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        // Sealed into the state here and followed after login, so it is held to
        // the same rule as the signup link's returnPath.
        if (!isSafeReturnPath(body.returnUrl))
        {
            throw new ValidationError({ message: 'returnUrl must be a relative path within the app' });
        }

        // CSRF: bind the flow to this browser via a cookie matched at the callback.
        const nonce = generateOAuthNonce();
        setStartCsrfCookie(c.raw, body.keyId, nonce);

        const result = await oauthStartService({ ...body, nonce });

        return result;
    });

/**
 * The API-mode start's CSRF cookie, under its own per-start name (#126).
 *
 * The same name the proxy's start writes, built from the start's keyId, so the
 * callback finds it the same way; a second start in another tab writes its own.
 * The oldest start past the cap of five has its cookie expired in this response.
 */
function setStartCsrfCookie(c: Context, keyId: string, nonce: string): void
{
    const options = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        path: '/',
    } as const;

    for (const name of namesEvictedByStart('csrf', getCookie(c)))
    {
        deleteCookie(c, name, options);
    }

    setCookie(c, buildStartCookieName('csrf', keyId), nonce, { ...options, maxAge: 600 });
}

/**
 * GET /_auth/oauth/providers - 활성화된 OAuth provider 목록
 *
 * 클라이언트에서 어떤 OAuth provider를 사용할 수 있는지 확인.
 * `providers`는 로그인 버튼을 그릴 provider, `linkOnly`는 로그인한 계정에
 * 연결만 되는 provider(#157)다. 연결 화면은 둘을 합쳐 읽는다.
 */
export const oauthProviders = route.get('/_auth/oauth/providers')
    .skip(['auth'])
    .handler(async () =>
    {
        const enabled = getEnabledOAuthProviders();

        return {
            providers: enabled.filter(isSignInProvider),
            linkOnly: enabled.filter(provider => !isSignInProvider(provider)),
        };
    });

/**
 * POST /_auth/oauth/google/url - Google OAuth URL 획득 (인터셉터용)
 *
 * Next.js 인터셉터가 state를 생성하여 body.state에 주입
 * 백엔드는 state를 사용해 Google OAuth URL 생성 후 반환
 *
 * @example
 * // 클라이언트
 * const { authUrl } = await authApi.getGoogleOAuthUrl.call({ body: { returnUrl: '/dashboard' } });
 * window.location.href = authUrl;
 */
export const getGoogleOAuthUrl = route.post('/_auth/oauth/google/url')
    .input({
        body: Type.Object({
            returnUrl: Type.Optional(Type.String({
                description: 'URL to redirect after OAuth success',
            })),
            metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
                description: 'Custom signup metadata sealed into OAuth state and passed to beforeRegister',
            })),
            state: Type.Optional(Type.String({
                description: 'Encrypted OAuth state (injected by interceptor)',
            })),
        }),
    })
    .use([rateLimitPolicy('oauth-start', { limit: 20, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        if (!isGoogleOAuthEnabled())
        {
            throw new ValidationError({ message: 'Google OAuth is not configured' });
        }

        assertSignInProvider('google');

        if (!body.state)
        {
            throw new ValidationError({
                message: 'OAuth state is required. Ensure the OAuth interceptor is configured.',
            });
        }

        return { authUrl: getGoogleAuthUrl(body.state) };
    });

/**
 * What `POST /_auth/oauth/finalize` answers with, in both of its branches.
 *
 * One type with a required discriminant rather than a union, on the same
 * reasoning as `LoginResult` (#95): `authApi.oauthFinalize` infers its result
 * from this, and a union would make every `result.userId` in every callback page
 * stop compiling. `mfaRequired` false is the 200 and carries `userId`/`keyId`;
 * true is the 202 and carries `challenge`.
 */
export interface OAuthFinalizeResponse
{
    success: boolean;
    mfaRequired: boolean;
    /** The second-factor challenge, echoed back. Present exactly on the 202. */
    challenge?: string;
    /**
     * The confirm page, `SPFN_AUTH_MFA_CONFIRM_PATH`. Added to the 202 by
     * `mfaVerifyInterceptor` in the Next.js proxy, never by this route.
     */
    mfaPath?: string;
    userId?: string;
    /**
     * The key being finalized. On the 202 it is the key the callback named
     * beside the challenge (#126), echoed so the proxy picks that start's
     * pending cookie; absent when the page did not send one.
     */
    keyId?: string;
    returnUrl: string;
    sessionBinding?: SessionBindingType;
    keyExpiresAtMillis?: number;
}

/**
 * POST /_auth/oauth/finalize - OAuth 세션 완료 (인터셉터용)
 *
 * 백엔드 콜백에서 이 라우트로 리다이렉트
 * Next.js 인터셉터가 pending session에서 세션 저장
 */
export const oauthFinalize = route.post('/_auth/oauth/finalize')
    .input({
        body: Type.Object({
            userId: Type.Optional(Type.String({ description: 'User ID from OAuth callback' })),
            keyId: Type.Optional(Type.String({ description: 'Key ID from OAuth state' })),
            mfaChallenge: Type.Optional(Type.String({
                minLength: 16,
                maxLength: 256,
                description: 'Second-factor challenge from the callback query, when the callback carried one',
            })),
            returnUrl: Type.Optional(Type.String({ description: 'URL to redirect after login' })),
        }),
    })
    .use([rateLimitPolicy('oauth-start', { limit: 20, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c): Promise<OAuthFinalizeResponse> =>
    {
        const { body } = await c.data();

        // Echoed back to the callback page, which navigates to it. Refused here
        // rather than echoed and left to the page, the same way the signup-link
        // route refuses a returnPath that would leave the app. An empty value is
        // an absent one — the response below already answers it with '/', and a
        // callback page that forwards `?returnUrl=` verbatim sends exactly that
        // on a login that has always worked.
        if (body.returnUrl && !isSafeReturnPath(body.returnUrl))
        {
            throw new ValidationError({ message: 'returnUrl must be a relative path within the app' });
        }

        // The callback handed the page a challenge instead of a userId/keyId pair,
        // because the account has a second factor and this device is new to it
        // (#95). There is no session to finalize yet, so this answers 202 with
        // the challenge echoed back — the interceptor bakes its pending cookie
        // from that and lets the body through, and the app page sends the person
        // to the confirm screen. The value is echoed rather than looked up: it is
        // the page's own copy, it authorizes only `POST /_auth/mfa/verify`, and
        // this route has no session to seal around it either way. The keyId is
        // echoed on the same terms (#126): it names which in-flight start's
        // pending cookie the interceptor bakes from, and authorizes nothing.
        if (body.mfaChallenge)
        {
            return c.accepted({
                success: true,
                mfaRequired: true,
                challenge: body.mfaChallenge,
                ...(body.keyId ? { keyId: body.keyId } : {}),
                returnUrl: body.returnUrl || '/',
            });
        }

        if (!body.userId || !body.keyId)
        {
            throw new ValidationError({ message: 'userId and keyId are required unless mfaChallenge is sent' });
        }

        // 인터셉터가 세션을 저장함 — userId, keyId를 반환해야 인터셉터가 처리 가능.
        //
        // SECURITY (not a vuln — read before "fixing"): this unauthenticated route
        // reflects the client-supplied userId. That is intentional and safe — the
        // reflected userId is a convenience value, never a trust anchor:
        //   1. The interceptor seals it into the session only after matching keyId
        //      against the server-sealed `oauth_pending` cookie, and the session is
        //      sealed with SPFN_AUTH_SESSION_SECRET (the client can't forge/tamper it).
        //   2. Identity on every backend request is re-derived in `authenticate`
        //      from the keyId → public-key → DB-owner binding (signature-verified),
        //      never from this userId. That keyId↔userId binding is created
        //      server-side in oauthCallbackService from the OAuth-verified identity.
        // A substituted userId therefore cannot grant another user's identity; it
        // only populates getSession().userId for client-side UI without a backend call.
        //
        // The two binding fields are read off the key row rather than echoed:
        // this is the seam the Next.js interceptor seals a session from, and a
        // caller allowed to state its own binding could ask for a cookie that
        // believes a bound key is an ordinary one.
        return {
            success: true,
            mfaRequired: false,
            userId: body.userId,
            keyId: body.keyId,
            returnUrl: body.returnUrl || '/',
            ...await keySessionBindingService(body.keyId),
        };
    });

/**
 * GET /_auth/oauth/:provider - 범용 OAuth 시작 (provider로 리다이렉트)
 *
 * oauthGoogleStart의 provider-generic 버전.
 * Next.js에서 키쌍을 생성한 후 state를 query에 담아 호출.
 *
 * 경로 충돌: Hono는 static segment(/google, /providers)를 param(:provider)보다
 * 우선 매칭하므로, google 리터럴 라우트와 /providers 목록 라우트가 이를 흡수하고
 * 나머지 provider만 이 핸들러로 들어온다.
 */
export const oauthProviderStart = route.get('/_auth/oauth/:provider')
    .input({
        params: providerParams,
        query: Type.Object({
            state: Type.String({
                description: 'Encrypted OAuth state (returnUrl, publicKey, keyId, fingerprint, algorithm)',
            }),
        }),
    })
    .use([rateLimitPolicy('oauth-start', { limit: 20, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { params, query } = await c.data();

        const provider = getOAuthProvider(params.provider);

        if (!provider?.isEnabled())
        {
            return c.redirect(buildOAuthErrorUrl(`OAuth provider '${params.provider}' is not configured`));
        }

        if (!isSignInProvider(params.provider))
        {
            return c.redirect(linkOnlyErrorUrl());
        }

        return c.redirect(provider.getAuthUrl(query.state));
    });

/**
 * GET /_auth/oauth/:provider/callback - 범용 OAuth 콜백
 *
 * oauthGoogleCallback의 provider-generic 버전.
 * provider에서 리다이렉트되는 콜백을 path param의 provider로 처리한다.
 */
export const oauthProviderCallback = route.get('/_auth/oauth/:provider/callback')
    .input({
        params: providerParams,
        query: Type.Object({
            code: Type.Optional(Type.String({
                description: 'Authorization code from provider',
            })),
            state: Type.Optional(Type.String({
                description: 'OAuth state parameter',
            })),
            user: Type.Optional(Type.String({
                description: 'Apple only: the user JSON (name) of a first authorization, carried over from the form_post callback',
            })),
            error: Type.Optional(Type.String({
                description: 'Error code from provider',
            })),
            error_description: Type.Optional(Type.String({
                description: 'Error description from provider',
            })),
        }),
    })
    .use([rateLimitPolicy('oauth-callback', { limit: 30, windowMs: 60_000 }), Transactional()])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { params, query } = await c.data();

        return c.redirect(await oauthCallbackRedirect(c.raw, params.provider, query));
    });

/** The form fields a form_post callback hands on to the GET callback, in this order. */
const FORM_POST_FIELDS = ['code', 'state', 'user', 'error', 'error_description'] as const;

/** Apple's `user` JSON carries a name and an email; anything longer is not Apple's. */
const MAX_FORM_POST_USER_BYTES = 2048;

/**
 * The form_post body, read once: Hono caches `parseBody`, and the relay and the
 * hand-on to the GET callback both read this one copy. A body that does not
 * parse is an empty form.
 */
async function readFormPostBody(raw: Context): Promise<Record<string, unknown>>
{
    return await raw.req.parseBody().catch(() => ({} as Record<string, unknown>));
}

/**
 * The GET callback's query for a form_post body: the known string fields only,
 * `user` dropped when oversized.
 */
function formPostCallbackQuery(body: Record<string, unknown>): URLSearchParams
{
    const query = new URLSearchParams();

    for (const field of FORM_POST_FIELDS)
    {
        const value = body[field];

        if (typeof value !== 'string')
        {
            continue;
        }

        if (field === 'user' && Buffer.byteLength(value, 'utf8') > MAX_FORM_POST_USER_BYTES)
        {
            continue;
        }

        query.set(field, value);
    }

    return query;
}

/**
 * POST /_auth/oauth/:provider/callback - form_post 콜백을 GET 콜백으로 넘긴다
 *
 * Apple은 name·email scope를 요청하면 response_mode=form_post를 강제해, 브라우저가 콜백에
 * cross-site POST로 도착한다. 이 패키지의 OAuth 쿠키(oauth_csrf.*, oauth_pending.*)는
 * SameSite=Lax라 cross-site POST에는 실리지 않으므로, 여기서는 로그인을 끝내지 않는다.
 * form 필드를 query로 옮겨 같은 경로의 GET으로 303을 보내면, 브라우저의 top-level GET에는
 * Lax 쿠키가 실리고 기존 GET 콜백(CSRF 대조 → oauthCallbackService)이 그대로 돈다.
 *
 * 쿠키를 읽지도 쓰지도 않고 DB도 건드리지 않는다(Transactional 없음). Location은 상대 경로이고
 * provider 세그먼트는 검증된 path param에서만 온다 — body 값이 경로를 정하지 않는다.
 * form_post provider가 아니거나 비활성이면 본문 없는 404다(탐색에 정보를 주지 않는다).
 *
 * Sign in with Apple on Android: when the posted `state` opens as a relay state
 * (`POST /_auth/oauth/apple/native/start` sealed it) and the App Link it names is
 * still configured, the answer is a `303` to that absolute https URL with
 * `id_token`, `user`, `error` and the app's `state` (`appleRelayLocation`).
 * Still no cookie and no DB. Any other state — a web state, garbage, a relay to
 * a URL no longer configured — gets the hand-on above, unchanged.
 *
 * 경로 충돌: 마지막 세그먼트가 callback이라 POST /_auth/oauth/start(static)와
 * /:provider/url·/native·/unlink-notify와 겹치지 않는다.
 */
export const oauthProviderCallbackPost = route.post('/_auth/oauth/:provider/callback')
    .input({ params: providerParams })
    .use([rateLimitPolicy('oauth-callback', { limit: 30, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { params } = await c.data();
        const provider = getOAuthProvider(params.provider);

        if (!provider?.isEnabled() || provider.callbackResponseMode !== 'form_post')
        {
            return c.raw.body(null, 404);
        }

        const body = await readFormPostBody(c.raw);
        const relay = params.provider === 'apple' ? await appleRelayLocation(body) : null;

        if (relay)
        {
            return c.redirect(relay, 303);
        }

        return c.redirect(`/_auth/oauth/${params.provider}/callback?${formPostCallbackQuery(body)}`, 303);
    });

/**
 * POST /_auth/oauth/:provider/url - 범용 OAuth URL 획득 (인터셉터용)
 *
 * getGoogleOAuthUrl의 provider-generic 버전.
 * Next.js 인터셉터(oauthUrlInterceptor)가 키쌍 생성 후 body.state를 주입하고,
 * 백엔드는 state로 provider별 authorization URL을 생성해 반환한다.
 *
 * @example
 * const { authUrl } = await authApi.getProviderOAuthUrl.call({
 *     params: { provider: 'superself' },
 *     body: { returnUrl: '/dashboard' },
 * });
 * window.location.href = authUrl;
 */
export const getProviderOAuthUrl = route.post('/_auth/oauth/:provider/url')
    .input({
        params: providerParams,
        body: Type.Object({
            returnUrl: Type.Optional(Type.String({
                description: 'URL to redirect after OAuth success',
            })),
            metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
                description: 'Custom signup metadata sealed into OAuth state and passed to beforeRegister',
            })),
            state: Type.Optional(Type.String({
                description: 'Encrypted OAuth state (injected by interceptor)',
            })),
        }),
    })
    .use([rateLimitPolicy('oauth-start', { limit: 20, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { params, body } = await c.data();

        // 미등록/비활성을 구분해 ValidationError를 던진다(인터셉터가 던졌을 plain Error 대신).
        // 연결 전용 provider(#157)는 OAuthProviderLinkOnlyError.
        const provider = requireSignInProvider(params.provider);

        if (!body.state)
        {
            throw new ValidationError({
                message: 'OAuth state is required. Ensure the OAuth interceptor is configured.',
            });
        }

        return { authUrl: provider.getAuthUrl(body.state) };
    });

/**
 * POST /_auth/oauth/apple/native/start - Sign in with Apple on Android, the native start
 *
 * Apple ships no Android SDK, so the app runs Apple's web flow in a Custom Tab.
 * This start carries the app's values instead of minting a key: `requestNonce`
 * (the SHA-256 hex of the app's key fingerprint) goes to Apple as the nonce, and
 * the app's `state` is sealed with `relayUrl` into the state Apple returns.
 * Apple's form_post to the usual Return URL is then relayed to `relayUrl`
 * (`oauthProviderCallbackPost`), and the app posts the id_token to
 * `POST /_auth/oauth/apple/native` with the same key, exactly as on iOS.
 *
 * `relayUrl` must equal one entry of `SPFN_AUTH_APPLE_RELAY_URLS` exactly. Sets no
 * cookie, mints no key, touches no database.
 *
 * 경로 충돌: 다섯 세그먼트라 /:provider/native(네 세그먼트)와 겹치지 않는다.
 */
export const oauthAppleNativeStart = route.post('/_auth/oauth/apple/native/start')
    .input({
        body: Type.Object({
            requestNonce: Type.String({
                pattern: '^[0-9a-f]{64}$',
                description: 'SHA-256 (64 lowercase hex) of the fingerprint of the key the app will enroll; '
                    + 'Apple puts it in the id_token as its nonce claim.',
            }),
            state: Type.String({
                pattern: APPLE_RELAY_APP_STATE_PATTERN,
                description: 'The app\'s own state, 16–128 characters of [A-Za-z0-9_-]; the relay hands it back.',
            }),
            relayUrl: Type.String({
                description: 'The https App Link to relay to — one entry of SPFN_AUTH_APPLE_RELAY_URLS, exactly.',
            }),
        }),
    })
    .use([rateLimitPolicy('oauth-start', { limit: 20, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        requireSignInProvider('apple');

        return {
            authUrl: await startAppleRelay({
                appState: body.state,
                relayUrl: body.relayUrl,
                requestNonce: body.requestNonce,
            }),
        };
    });

/**
 * POST /_auth/oauth/:provider/native - 네이티브/웹 id_token 로그인
 *
 * 네이티브 SDK(또는 웹 Sign in with Apple JS)가 받은 id_token을 서버가 JWKS로 검증하고,
 * 클라이언트가 생성한 공개키를 등록한다. 토큰은 반환하지 않는다 — 클라이언트가 등록한
 * 키로 client token을 직접 서명해 Bearer로 사용한다.
 *
 * Apple은 Android·웹에 네이티브 SDK가 없어 web 흐름(Custom Tab / Sign in with Apple JS)으로
 * id_token을 얻은 뒤 이 엔드포인트로 보낸다. 어느 경로든 서버 계약은 동일하다.
 */
export const oauthNative = route.post('/_auth/oauth/:provider/native')
    .input({
        params: providerParams,
        body: Type.Object({
            idToken: Type.String({ description: 'id_token from native/web social SDK' }),
            nonce: Type.String({
                description:
                    'Raw nonce used when requesting the id_token. Must equal `fingerprint` — the nonce is what '
                    + 'binds the id_token to this public key, so a stolen id_token cannot be paired with a '
                    + 'different key.',
            }),
            accessToken: Type.Optional(Type.String({
                description:
                    'Provider access token from the same sign-in. Optional — sent only when the provider '
                    + 'needs it to resolve claims the id_token omits (Kakao email verification).',
            })),
            publicKey: Type.String({ description: 'Client public key (Base64 DER)' }),
            keyId: Type.String({ description: 'Key identifier (UUID)' }),
            fingerprint: Type.String({ description: 'Key fingerprint (SHA-256 hex)' }),
            algorithm: Type.Union(KEY_ALGORITHM.map(a => Type.Literal(a)), {
                description: 'Key algorithm (ES256 or RS256)',
            }),
            deviceName: Type.Optional(DeviceNameSchema),
            platform: Type.Optional(PlatformSchema),
            profile: Type.Optional(OAuthNativeProfileSchema),
            metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
                description: 'Custom metadata passed to auth events (e.g. referral code, UTM params)',
            })),
        }),
    })
    // Transactional 미들웨어를 쓰지 않는다. id_token 검증(외부 JWKS 조회)을 트랜잭션 밖에서
    // 먼저 하고, DB 쓰기만 oauthNativeService 내부의 runInTransaction으로 감싼다.
    // IP만으로는 토큰 하나를 여러 IP에서 되던지는 것을 못 막는다. id_token 자체를 두 번째
    // 축으로 두어 한 토큰의 제출 횟수를 조인다(분당 5회 — 정상 클라이언트는 로그인마다
    // 새 토큰을 쓰고, 같은 토큰은 재시도할 때만 반복한다). IP 축은 기존 20회 그대로 둬서
    // 공유 NAT 뒤의 정상 사용자를 새로 조이지 않는다.
    .use([rateLimitPolicy('oauth-native', {
        limit: 5,
        windowMs: 60_000,
        by: byIpAndIdToken({ ipLimit: 20 }),
    })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { params, body } = await c.data();
        const result = await oauthNativeService({ provider: params.provider, ...body, ...deviceProvenance(c.raw) });

        // 202 when the account has a second factor and this device is new to it
        // (#95): the id_token verified, the key is registered inactive, and the
        // body carries the challenge that activates it.
        return result.mfaRequired ? c.accepted(result) : result;
    });

/**
 * unlink-notify 요청의 query·body(form/JSON)를 문자열 맵으로 병합
 *
 * 카카오는 GET/POST 모두 보낼 수 있고, 네이버는 POST면서 샘플상 파라미터가
 * query string에도 실리므로 두 소스를 합쳐 provider 검증에 넘긴다.
 */
async function collectUnlinkNotifyFields(raw: Context): Promise<Record<string, string>>
{
    const fields: Record<string, string> = { ...raw.req.query() };

    if (raw.req.method === 'GET')
    {
        return fields;
    }

    const contentType = raw.req.header('content-type') ?? '';

    if (contentType.includes('application/json'))
    {
        const body = await raw.req.json().catch(() => null) as Record<string, unknown> | null;
        for (const [key, value] of Object.entries(body ?? {}))
        {
            if (typeof value === 'string' || typeof value === 'number')
            {
                fields[key] = String(value);
            }
        }

        return fields;
    }

    const body = await raw.req.parseBody().catch(() => ({} as Record<string, unknown>));
    for (const [key, value] of Object.entries(body))
    {
        if (typeof value === 'string')
        {
            fields[key] = value;
        }
    }

    return fields;
}

/**
 * provider 검증 → 소셜 연결 삭제까지의 unlink-notify 공통 처리
 *
 * 웹훅 호출자는 provider 서버라서 에러 응답 본문이 소비되지 않는다 —
 * status 코드로만 결과를 표현한다(카카오 성공 200 · 네이버 성공 204).
 */
async function processUnlinkNotify(
    provider: SocialProvider,
    raw: Context,
): Promise<200 | 204 | 400 | 401 | 403 | 404>
{
    const oauthProvider = getOAuthProvider(provider);

    if (!oauthProvider?.isEnabled() || !oauthProvider.verifyUnlinkNotification)
    {
        return 404;
    }

    const request = {
        authorization: raw.req.header('authorization') ?? null,
        fields: await collectUnlinkNotifyFields(raw),
    };

    try
    {
        const notification = await oauthProvider.verifyUnlinkNotification(request);
        const result = await oauthUnlinkNotifyService(provider, notification);

        return result.ackStatus;
    }
    catch (error)
    {
        return error instanceof UnlinkNotifyRejection ? error.status : 400;
    }
}

/** The account password, for a session that proved itself longer ago than the recent-authentication window. */
const LinkCurrentPasswordSchema = Type.String({
    minLength: 1,
    description: 'Account password, needed when the session proved itself longer ago than the recent-authentication window',
});

/** What `oauthLinkInterceptor` injects: 32 hex, the shape `generateOAuthNonce` makes. */
function linkStartToken(description: string)
{
    return Type.String({ pattern: '^[0-9a-f]{32}$', description });
}

/**
 * POST /_auth/oauth/:provider/link - Start linking a provider identity to the signed-in account (#154)
 *
 * Authenticated: the account is the session's. Gated like a passkey change —
 * step-up for an enrolled account, then recent authentication — because a linked
 * identity is one more way to sign in. The Next.js interceptor
 * (`oauthLinkInterceptor`) injects `nonce` and `startId` and sets the matching
 * CSRF cookie; the provider then returns to the ordinary callback route, which
 * tells a link state from a sign-in state by the key it opens under.
 *
 * @example
 * const { authUrl } = await authApi.oauthLinkStart.call({
 *     params: { provider: 'battlenet' },
 *     body: { returnUrl: '/settings/connections' },
 * });
 * window.location.href = authUrl;
 * // back on /settings/connections?oauthLink=linked&provider=battlenet
 */
export const oauthLinkStart = route.post('/_auth/oauth/:provider/link')
    .input({
        params: providerParams,
        body: Type.Object({
            returnUrl: Type.Optional(Type.String({
                description: 'Path within the app the browser returns to, with oauthLink=<outcome>',
            })),
            currentPassword: Type.Optional(LinkCurrentPasswordSchema),
            nonce: Type.Optional(linkStartToken('CSRF nonce (injected by interceptor)')),
            startId: Type.Optional(linkStartToken('Names the CSRF cookie (injected by interceptor)')),
        }),
    })
    .use([rateLimitPolicy('oauth-link', { limit: 10, windowMs: 60_000, by: byIpAndCaller({ ipLimit: 100 }) })])
    .handler(async (c) =>
    {
        const { params, body } = await c.data();
        const { userId, keyId } = getAuth(c);

        if (!body.nonce || !body.startId)
        {
            throw new ValidationError({
                message: 'OAuth link nonce is required. Ensure the OAuth interceptor is configured.',
            });
        }

        return await startOAuthLinkService({
            provider: params.provider,
            userId: Number(userId),
            keyId,
            currentPassword: body.currentPassword,
            returnUrl: body.returnUrl || '/',
            nonce: body.nonce,
            startId: body.startId,
        });
    });

/**
 * POST /_auth/oauth/:provider/unlink - Detach the signed-in account's identity of a provider (#154)
 *
 * Gated like the link. Refused with `LAST_RECOVERY_CREDENTIAL` when the identity
 * is the account's last way to sign in. A POST rather than a DELETE because the
 * body may carry `currentPassword`, and the RPC proxy forwards no body on DELETE.
 * Emits `auth.oauth.link_removed`, never the provider-initiated `auth.oauth.unlinked`.
 */
export const oauthUnlink = route.post('/_auth/oauth/:provider/unlink')
    .input({
        params: providerParams,
        body: Type.Object({
            currentPassword: Type.Optional(LinkCurrentPasswordSchema),
        }),
    })
    .use([
        rateLimitPolicy('oauth-unlink', { limit: 10, windowMs: 60_000, by: byIpAndCaller({ ipLimit: 100 }) }),
        Transactional(),
    ])
    .handler(async (c) =>
    {
        const { params, body } = await c.data();
        const { userId, keyId } = getAuth(c);

        return await unlinkOAuthService({
            provider: params.provider,
            userId: Number(userId),
            keyId,
            currentPassword: body.currentPassword,
        });
    });

/**
 * POST /_auth/oauth/:provider/unlink-notify - provider발 연동 해제 알림 수신
 *
 * 카카오 [연결 해제 웹훅]·네이버 [연결끊기 Callback URL]에 등록하는 공개
 * 엔드포인트. provider별 서명/키 검증을 통과한 요청만 소셜 연결을 삭제한다.
 */
export const oauthUnlinkNotify = route.post('/_auth/oauth/:provider/unlink-notify')
    .input({ params: providerParams })
    .use([rateLimitPolicy('oauth-unlink-notify', { limit: 300, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { params } = await c.data();
        const status = await processUnlinkNotify(params.provider, c.raw);

        return status === 204 ? c.noContent() : c.json({}, status);
    });

/**
 * GET /_auth/oauth/:provider/unlink-notify - 카카오 웹훅의 GET 발송 대응
 */
export const oauthUnlinkNotifyGet = route.get('/_auth/oauth/:provider/unlink-notify')
    .input({ params: providerParams })
    .use([rateLimitPolicy('oauth-unlink-notify', { limit: 300, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { params } = await c.data();
        const status = await processUnlinkNotify(params.provider, c.raw);

        return status === 204 ? c.noContent() : c.json({}, status);
    });

// Export router
export const oauthRouter = defineRouter({
    oauthGoogleStart,
    oauthGoogleCallback,
    oauthStart,
    oauthProviders,
    getGoogleOAuthUrl,
    oauthFinalize,
    oauthProviderStart,
    oauthProviderCallback,
    oauthProviderCallbackPost,
    getProviderOAuthUrl,
    oauthNative,
    oauthAppleNativeStart,
    oauthUnlinkNotify,
    oauthUnlinkNotifyGet,
    oauthLinkStart,
    oauthUnlink,
});

export default oauthRouter;
