/**
 * Kakao Login OAuthProvider (web authorization-code flow + native id_token verification).
 */

import { ValidationError } from '@spfn/core/errors';
import { NativeSignInUnsupportedError } from '@spfn/auth/errors';

import { env } from '../../../config';
import { resolveAppUrl } from '../app-url';
import { timingSafeEqual } from 'node:crypto';

import { authLogger } from '../../logger';
import { verifyIdToken } from './jwks-verify';
import {
    registerOAuthProvider,
    UnlinkNotifyRejection,
    type NativeVerifyOptions,
    type NormalizedIdentity,
    type OAuthProvider,
    type OAuthTokens,
    type UnlinkNotification,
    type UnlinkNotifyRequest,
} from './provider';

const KAKAO_AUTH_URL = 'https://kauth.kakao.com/oauth/authorize';
const KAKAO_TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const KAKAO_USERINFO_URL = 'https://kapi.kakao.com/v2/user/me';
const KAKAO_ISSUER = 'https://kauth.kakao.com';
const KAKAO_JWKS_URI = 'https://kauth.kakao.com/.well-known/jwks.json';

/**
 * user-info 조회의 응답 대기 한도(ms)
 *
 * undici의 기본값은 사실상 무제한이라, 카카오가 응답을 붙들고 있으면 요청 핸들러가 몇 분씩
 * 살아남는다. 작은 GET 하나의 정상 응답은 수백 ms 수준이므로 5초면 넉넉하다.
 * 초과 시 native 로그인은 이메일 보강만 건너뛰고 계속되고(withKakaoVerifiedEmail의 catch),
 * 웹 흐름은 로그인이 실패해 사용자가 재시도한다 — 어느 쪽도 무한 대기보다 낫다.
 */
const USERINFO_TIMEOUT_MS = 5_000;

interface KakaoTokenResponse
{
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
}

interface KakaoUserInfo
{
    id?: unknown;
    kakao_account?: {
        email?: unknown;
        is_email_valid?: unknown;
        is_email_verified?: unknown;
        profile?: {
            nickname?: unknown;
            profile_image_url?: unknown;
        };
    };
}

function getKakaoConfig()
{
    const clientId = env.SPFN_AUTH_KAKAO_CLIENT_ID;
    const clientSecret = env.SPFN_AUTH_KAKAO_CLIENT_SECRET;

    if (!clientId)
    {
        throw new ValidationError({
            message: 'Kakao OAuth is not configured. Set SPFN_AUTH_KAKAO_CLIENT_ID.',
        });
    }

    return {
        clientId,
        clientSecret,
        redirectUri: env.SPFN_AUTH_KAKAO_REDIRECT_URI
            || `${resolveAppUrl()}/_auth/oauth/kakao/callback`,
    };
}

function getKakaoScopes(): string[]
{
    const configured = env.SPFN_AUTH_KAKAO_SCOPES;

    return configured
        ? configured.split(',').map(scope => scope.trim()).filter(Boolean)
        : ['account_email'];
}

/**
 * native id_token의 audience로 허용할 Kakao 앱 키 목록
 *
 * 카카오는 앱 하나가 키를 여러 벌 갖는다(네이티브 앱 키, REST API 키, JavaScript 키).
 * id_token의 aud는 그 토큰을 발급받은 키라서 웹과 앱이 서로 다른 값이 된다.
 * 반면 sub(회원번호)는 앱 단위로 하나이므로, 두 키를 모두 허용해도 같은 사용자로 이어진다.
 */
function getKakaoNativeAudiences(): string[]
{
    const ids = (env.SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean);

    if (env.SPFN_AUTH_KAKAO_CLIENT_ID)
    {
        ids.push(env.SPFN_AUTH_KAKAO_CLIENT_ID);
    }

    return ids;
}

async function requestKakaoTokens(params: URLSearchParams): Promise<OAuthTokens>
{
    const response = await fetch(KAKAO_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: params,
    });

    if (!response.ok)
    {
        throw new Error(`Kakao token request failed with status ${response.status}`);
    }

    const body = await response.json() as KakaoTokenResponse;
    const expiresIn = Number(body.expires_in);
    if (typeof body.access_token !== 'string' || !Number.isFinite(expiresIn) || expiresIn <= 0)
    {
        throw new Error('Kakao token response is invalid');
    }

    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
        expiresIn,
    };
}

/**
 * access token으로 카카오 사용자 정보를 조회해 공통 신원으로 정규화한다.
 *
 * 이메일은 동의항목이라 없을 수 있고, 동의했더라도 유효하지 않거나 미인증 상태일 수 있다.
 * 그래서 값의 존재만으로 검증됐다고 보지 않고 카카오가 주는 두 플래그를 함께 본다.
 */
async function fetchKakaoIdentity(accessToken: string): Promise<NormalizedIdentity>
{
    const response = await fetch(KAKAO_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });

    if (!response.ok)
    {
        throw new Error(`Kakao user-info request failed with status ${response.status}`);
    }

    const body = await response.json() as KakaoUserInfo;
    if (typeof body.id !== 'number' && typeof body.id !== 'string')
    {
        throw new Error('Kakao user-info response is missing the provider user ID');
    }

    const account = body.kakao_account;
    const email = typeof account?.email === 'string' ? account.email : null;

    return {
        providerUserId: String(body.id),
        email,
        emailVerified: email !== null
            && account?.is_email_valid === true
            && account.is_email_verified === true,
        name: typeof account?.profile?.nickname === 'string'
            ? account.profile.nickname
            : undefined,
        avatar: typeof account?.profile?.profile_image_url === 'string'
            ? account.profile.profile_image_url
            : undefined,
    };
}

/**
 * id_token으로 확인할 수 없는 이메일 검증 상태를 user-info 조회로 보강한다.
 *
 * 카카오 id_token에는 email_verified가 없다(discovery claims_supported에 부재). 이메일 값은
 * 오지만 유효·인증 여부를 알 수 없어, access token이 함께 온 경우에만 웹 흐름과 같은 판정을 한다.
 *
 * ⚠️ access token은 클라이언트가 보낸 검증되지 않은 값이다. 공격자가 자신의 토큰을 남의
 * id_token과 함께 보내면 서버가 엉뚱한 사람의 이메일을 붙일 수 있다. 조회 결과의 회원번호가
 * id_token의 sub와 같을 때만 신뢰하고, 다르면 보강 없이 원래 신원을 그대로 쓴다.
 *
 * 조회 실패는 로그인을 막지 않는다 — 이메일 없이 진행한다(id_token 검증은 이미 통과했다).
 */
async function withKakaoVerifiedEmail(
    identity: NormalizedIdentity,
    accessToken: string,
): Promise<NormalizedIdentity>
{
    const fetched = await fetchKakaoIdentity(accessToken).catch((err: unknown) =>
    {
        authLogger.service.warn('Kakao user-info lookup failed; continuing without email verification', {
            reason: err instanceof Error ? err.message : 'unknown',
        });

        return null;
    });

    if (!fetched)
    {
        return identity;
    }

    if (fetched.providerUserId !== identity.providerUserId)
    {
        authLogger.service.warn('Kakao access token belongs to another user; ignoring it', {
            subject: identity.providerUserId,
        });

        return identity;
    }

    // 동의 범위가 두 응답에서 다를 수 있어, user-info에 없는 값(이메일·이름·프로필)은 id_token 쪽을 남긴다.
    // 이메일이 없는 응답이면 fetchKakaoIdentity가 emailVerified를 false로 두므로, id_token 이메일을
    // 되살려도 검증 판정은 그대로 미인증이다.
    return {
        ...fetched,
        email: fetched.email ?? identity.email,
        name: fetched.name ?? identity.name,
        avatar: fetched.avatar ?? identity.avatar,
    };
}

export const kakaoProvider: OAuthProvider = {
    id: 'kakao',

    /**
     * 웹 authorization-code 흐름을 쓸 수 있는지만 판정한다.
     *
     * native 로그인은 이 값을 보지 않는다 — oauthNativeService는 verifyNativeIdToken의 존재만
     * 확인하고, 허용 audience는 그 메서드가 직접 검사한다. 네이티브 앱 키만 설정한 서비스에서
     * 이 값이 true가 되면 웹 흐름 게이트를 통과한 뒤 더 깊은 곳에서 REST API 키 부재로
     * 실패하므로, 판정을 웹 키에 그대로 둔다.
     */
    isEnabled(): boolean
    {
        return !!env.SPFN_AUTH_KAKAO_CLIENT_ID;
    },

    getAuthUrl(state: string, scopes?: string[]): string
    {
        const config = getKakaoConfig();
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            state,
            scope: (scopes ?? getKakaoScopes()).join(','),
        });

        return `${KAKAO_AUTH_URL}?${params.toString()}`;
    },

    async exchangeCodeForTokens(code: string): Promise<OAuthTokens>
    {
        const config = getKakaoConfig();

        const params = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            code,
        });
        if (config.clientSecret)
        {
            params.set('client_secret', config.clientSecret);
        }

        return requestKakaoTokens(params);
    },

    async getUserInfo(accessToken: string): Promise<NormalizedIdentity>
    {
        return fetchKakaoIdentity(accessToken);
    },

    /**
     * 네이티브/웹 SDK가 받은 카카오 id_token을 검증한다.
     *
     * 카카오는 표준 OIDC라 nonce를 raw 그대로 담는다(Apple 같은 SHA-256 해싱이 없다).
     * 앱에서 id_token을 받으려면 개발자 콘솔에서 OpenID Connect를 켜고 로그인 요청 scope에
     * openid를 넣어야 한다.
     *
     * emailVerified는 기본이 false다. id_token에는 이메일의 유효·인증 여부를 알려주는 claim이
     * 없어서, 웹 흐름과 같은 강도로 판정하려면 access token이 함께 와야 한다.
     */
    async verifyNativeIdToken(idToken: string, options: NativeVerifyOptions): Promise<NormalizedIdentity>
    {
        const audiences = getKakaoNativeAudiences();
        if (audiences.length === 0)
        {
            throw new NativeSignInUnsupportedError({
                message: 'Kakao native sign-in is not configured. Set SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS.',
            });
        }

        const payload = await verifyIdToken({
            idToken,
            jwksUri: KAKAO_JWKS_URI,
            issuer: KAKAO_ISSUER,
            audiences,
            algorithms: ['RS256'],
            expectedNonce: options.nonce,
        });

        // sub은 verifyIdToken이 string으로 보장한다.
        const identity: NormalizedIdentity = {
            providerUserId: payload.sub as string,
            email: typeof payload.email === 'string' ? payload.email : null,
            emailVerified: false,
            name: typeof payload.nickname === 'string' ? payload.nickname : undefined,
            avatar: typeof payload.picture === 'string' ? payload.picture : undefined,
        };

        return options.accessToken
            ? withKakaoVerifiedEmail(identity, options.accessToken)
            : identity;
    },

    async refreshTokens(refreshToken: string): Promise<OAuthTokens>
    {
        const config = getKakaoConfig();

        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: config.clientId,
            refresh_token: refreshToken,
        });
        if (config.clientSecret)
        {
            params.set('client_secret', config.clientSecret);
        }

        return requestKakaoTokens(params);
    },

    /**
     * 카카오 연결 해제 웹훅(User Unlinked) 검증
     *
     * 카카오는 `Authorization: KakaoAK ${대표 어드민 키}` 헤더로 요청하므로
     * 어드민 키 일치가 곧 발신자 검증이다. 웹훅 규격상 GET/POST 모두 가능하며
     * 본문 필드는 app_id · user_id · referrer_type.
     */
    async verifyUnlinkNotification(request: UnlinkNotifyRequest): Promise<UnlinkNotification>
    {
        const adminKey = env.SPFN_AUTH_KAKAO_ADMIN_KEY;
        if (!adminKey)
        {
            throw new UnlinkNotifyRejection(401, 'SPFN_AUTH_KAKAO_ADMIN_KEY is not configured');
        }

        const expected = Buffer.from(`KakaoAK ${adminKey}`);
        const actual = Buffer.from(request.authorization ?? '');
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        {
            throw new UnlinkNotifyRejection(401, 'Kakao admin key mismatch');
        }

        const userId = request.fields.user_id;
        if (!userId)
        {
            throw new UnlinkNotifyRejection(400, 'Kakao unlink webhook is missing user_id');
        }

        return {
            providerUserId: userId,
            reason: request.fields.referrer_type,
        };
    },
};

registerOAuthProvider(kakaoProvider);
