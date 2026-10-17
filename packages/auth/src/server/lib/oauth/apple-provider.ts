/**
 * Apple OAuthProvider (web authorization-code flow + native id_token verification)
 *
 * - native(iOS): 앱이 받은 id_token을 POST /_auth/oauth/apple/native로 보내고, 서버는 Apple
 *   JWKS로 검증만 한다(client secret 없음). nonce는 클라이언트의 raw nonce를 SHA-256(hex)한 값.
 * - web(브라우저, Android): Apple은 Android용 네이티브 SDK가 없어 Android도 Custom Tab으로 이
 *   흐름을 쓴다. scope에 name·email을 요청하면 Apple은 response_mode=form_post를 강제하므로,
 *   콜백은 cross-site POST로 도착한다(POST /_auth/oauth/apple/callback이 GET 콜백으로 303).
 *   Apple에는 userinfo endpoint가 없어, token 응답의 id_token이 곧 신원이다. nonce는 state를
 *   SHA-256(hex)한 값 — 두 흐름의 nonce 입력이 다르므로 섞지 않는다.
 *
 * 이 모듈을 import 하는 것만으로 apple provider가 registry에 자기 등록된다.
 */

import { createHash } from 'node:crypto';

import { env } from '@spfn/auth/config';
import { ValidationError } from '@spfn/core/errors';
import { NativeSignInUnsupportedError } from '@spfn/auth/errors';

import { resolveAppUrl } from '../app-url';
import { getAppleClientSecret } from './apple-client-secret';
import { verifyIdToken } from './jwks-verify';
import {
    registerOAuthProvider,
    type OAuthProvider,
    type OAuthTokens,
    type OAuthCodeExchangeOptions,
    type NormalizedIdentity,
    type NativeVerifyOptions,
} from './provider';

const APPLE_AUTH_URL = 'https://appleid.apple.com/auth/authorize';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_JWKS_URI = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_DEFAULT_SCOPES = ['name', 'email'];

/**
 * token 요청의 응답 대기 한도(ms)
 *
 * undici의 기본값은 사실상 무제한이라, Apple이 응답을 붙들고 있으면 콜백 핸들러가 몇 분씩
 * 살아남는다. 작은 POST 하나의 정상 응답은 수백 ms 수준이므로 5초면 넉넉하다.
 * 초과 시 로그인이 실패해 사용자가 재시도한다 — 무한 대기보다 낫다.
 */
const TOKEN_TIMEOUT_MS = 5_000;

interface AppleTokenResponse
{
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
}

/** Apple이 첫 인가 때만 form에 실어 보내는 `user` JSON. email은 읽지 않는다(id_token의 것을 쓴다). */
interface AppleUserForm
{
    name?: {
        firstName?: unknown;
        lastName?: unknown;
    };
}

interface AppleWebConfig
{
    servicesId: string;
    teamId: string;
    keyId: string;
    redirectUri: string;
}

/**
 * 웹 흐름 설정. 세 ID와 키 변수 하나가 모두 있어야 한다(isEnabled와 같은 판정).
 */
function getAppleWebConfig(): AppleWebConfig
{
    const servicesId = env.SPFN_AUTH_APPLE_SERVICES_ID;
    const teamId = env.SPFN_AUTH_APPLE_TEAM_ID;
    const keyId = env.SPFN_AUTH_APPLE_KEY_ID;

    if (!servicesId || !teamId || !keyId || !hasExactlyOneKeyVariable())
    {
        throw new ValidationError({
            message: 'Apple web OAuth is not configured. Set SPFN_AUTH_APPLE_SERVICES_ID, SPFN_AUTH_APPLE_TEAM_ID, '
                + 'SPFN_AUTH_APPLE_KEY_ID and one of SPFN_AUTH_APPLE_PRIVATE_KEY / SPFN_AUTH_APPLE_PRIVATE_KEY_FILE.',
        });
    }

    return {
        servicesId,
        teamId,
        keyId,
        redirectUri: env.SPFN_AUTH_APPLE_REDIRECT_URI
            || `${resolveAppUrl()}/_auth/oauth/apple/callback`,
    };
}

function hasExactlyOneKeyVariable(): boolean
{
    return !!env.SPFN_AUTH_APPLE_PRIVATE_KEY !== !!env.SPFN_AUTH_APPLE_PRIVATE_KEY_FILE;
}

/**
 * native id_token의 audience로 허용할 Apple client id 목록
 *
 * iOS bundle ID와 웹/Android용 Services ID가 달라 콤마로 나열한다.
 * 웹 흐름의 Services ID도 자동으로 허용한다(Sign in with Apple JS가 받은 id_token).
 */
function getAppleClientIds(): string[]
{
    const ids = (env.SPFN_AUTH_APPLE_CLIENT_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean);

    if (env.SPFN_AUTH_APPLE_SERVICES_ID)
    {
        ids.push(env.SPFN_AUTH_APPLE_SERVICES_ID);
    }

    return [...new Set(ids)];
}

/**
 * Apple은 nonce를 SHA-256(hex)으로 해시해 id_token의 nonce claim에 담는다.
 *
 * native는 클라이언트의 raw nonce를, 웹은 state 문자열을 이 함수에 넣는다.
 */
function hashNonce(rawNonce: string): string
{
    return createHash('sha256').update(rawNonce).digest('hex');
}

async function requestAppleTokens(params: URLSearchParams): Promise<{ tokens: OAuthTokens; idToken: string }>
{
    const response = await fetch(APPLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });

    if (!response.ok)
    {
        throw new Error(`Apple token request failed with status ${response.status}`);
    }

    const body = await response.json() as AppleTokenResponse;
    if (typeof body.access_token !== 'string' || typeof body.id_token !== 'string'
        || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0
        || (body.refresh_token !== undefined && typeof body.refresh_token !== 'string'))
    {
        throw new Error('Apple token response is invalid');
    }

    return {
        tokens: {
            accessToken: body.access_token,
            refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
            expiresIn: body.expires_in,
        },
        idToken: body.id_token,
    };
}

/**
 * Apple이 form에 실어 보낸 `user` JSON에서 이름만 꺼낸다.
 *
 * 공격자가 그대로 적어 보낼 수 있는 form 필드라 신원 판정에는 쓰지 않는다 — 이름은 표시용일
 * 뿐이고, 같은 JSON의 email은 읽지도 않는다. 이름은 첫 인가에만 오므로 대부분의 로그인에선 없다.
 */
function parseAppleUserName(user: string | undefined): string | undefined
{
    const name = user ? parseAppleUserForm(user)?.name : undefined;
    const parts = [name?.firstName, name?.lastName]
        .filter((part): part is string => typeof part === 'string')
        .map(part => part.trim())
        .filter(Boolean);

    return parts.length > 0 ? parts.join(' ') : undefined;
}

function parseAppleUserForm(user: string): AppleUserForm | null
{
    try
    {
        return JSON.parse(user) as AppleUserForm | null;
    }
    catch
    {
        return null;
    }
}

export const appleProvider: OAuthProvider =
    {
        id: 'apple',

        /**
         * 웹 authorization-code 흐름을 쓸 수 있는지만 판정한다.
         *
         * native 로그인은 이 값을 보지 않는다 — 허용 audience는 verifyNativeIdToken이 직접 검사한다.
         * 그래서 SPFN_AUTH_APPLE_CLIENT_IDS만 설정한 iOS 전용 서비스도 native 로그인은 그대로 된다.
         */
        isEnabled(): boolean
        {
            return !!env.SPFN_AUTH_APPLE_SERVICES_ID
                && !!env.SPFN_AUTH_APPLE_TEAM_ID
                && !!env.SPFN_AUTH_APPLE_KEY_ID
                && hasExactlyOneKeyVariable();
        },

        callbackResponseMode: 'form_post',

        /**
         * state를 SHA-256(hex)한 값을 nonce로 보낸다. 콜백이 돌려받는 state가 이 문자열과 같아야
         * id_token의 nonce가 맞는다(form POST → 303 → GET query를 거쳐도 문자열은 그대로다).
         */
        getAuthUrl(state: string, scopes?: string[]): string
        {
            const config = getAppleWebConfig();
            const params = new URLSearchParams({
                client_id: config.servicesId,
                redirect_uri: config.redirectUri,
                response_type: 'code',
                response_mode: 'form_post',
                scope: (scopes ?? APPLE_DEFAULT_SCOPES).join(' '),
                state,
                nonce: hashNonce(state),
            });

            return `${APPLE_AUTH_URL}?${params.toString()}`;
        },

        /**
         * code를 토큰으로 교환하고, 함께 온 id_token을 검증해 신원을 확정한다.
         *
         * audience는 Services ID 하나뿐이다 — native bundle ID로 발급된 토큰은 웹 콜백에서 받지 않는다.
         */
        async exchangeCodeForTokens(code: string, options: OAuthCodeExchangeOptions): Promise<OAuthTokens>
        {
            const config = getAppleWebConfig();
            const { tokens, idToken } = await requestAppleTokens(new URLSearchParams({
                client_id: config.servicesId,
                client_secret: await getAppleClientSecret(config),
                code,
                grant_type: 'authorization_code',
                redirect_uri: config.redirectUri,
            }));

            const payload = await verifyIdToken({
                idToken,
                jwksUri: APPLE_JWKS_URI,
                issuer: APPLE_ISSUER,
                audiences: [config.servicesId],
                algorithms: ['RS256'],
                expectedNonce: hashNonce(options.state),
            });

            return {
                ...tokens,
                identity: {
                    providerUserId: payload.sub as string,
                    email: (payload.email as string) ?? null,
                    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
                    name: parseAppleUserName(options.user),
                },
            };
        },

        async getUserInfo(): Promise<never>
        {
            throw new Error('Apple has no userinfo endpoint; the identity comes with the token response');
        },

        async verifyNativeIdToken(idToken: string, options: NativeVerifyOptions): Promise<NormalizedIdentity>
        {
            const audiences = getAppleClientIds();
            if (audiences.length === 0)
            {
                throw new NativeSignInUnsupportedError({
                    message: 'Apple native sign-in is not configured. Set SPFN_AUTH_APPLE_CLIENT_IDS or SPFN_AUTH_APPLE_SERVICES_ID.',
                });
            }

            const payload = await verifyIdToken({
                idToken,
                jwksUri: APPLE_JWKS_URI,
                issuer: APPLE_ISSUER,
                audiences,
                algorithms: ['RS256'],
                expectedNonce: hashNonce(options.nonce),
            });

            // Apple은 email_verified를 boolean이 아닌 문자열("true")로 줄 수 있다.
            // sub은 verifyIdToken이 string으로 보장한다.
            return {
                providerUserId: payload.sub as string,
                email: (payload.email as string) ?? null,
                emailVerified: payload.email_verified === true || payload.email_verified === 'true',
            };
        },
    };

// dogfood: 패키지 로드 시점에 자기 등록(google-provider와 동일 패턴).
registerOAuthProvider(appleProvider);
