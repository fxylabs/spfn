/**
 * Naver Login OAuthProvider (web authorization-code flow + native id_token verification).
 */

import { ValidationError } from '@spfn/core/errors';
import { NativeSignInUnsupportedError } from '@spfn/auth/errors';

import { env } from '../../../config';
import { resolveAppUrl } from '../app-url';
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { authLogger } from '../../logger';
import { verifyIdToken } from './jwks-verify';
import {
    registerOAuthProvider,
    UnlinkNotifyRejection,
    type NativeVerifyOptions,
    type NormalizedIdentity,
    type OAuthCodeExchangeOptions,
    type OAuthProvider,
    type OAuthTokens,
    type UnlinkNotification,
    type UnlinkNotifyRequest,
} from './provider';

const NAVER_AUTH_URL = 'https://nid.naver.com/oauth2.0/authorize';
const NAVER_TOKEN_URL = 'https://nid.naver.com/oauth2.0/token';
const NAVER_USERINFO_URL = 'https://openapi.naver.com/v1/nid/me';

/**
 * 네이버는 로그인 표면이 두 벌이다.
 *
 * 위의 /oauth2.0/*는 순수 OAuth2로 id_token을 발급하지 않고, 웹 리다이렉트 흐름이 쓴다.
 * 아래 상수는 id_token을 발급하는 OIDC 표면이며 native 검증만 이쪽을 본다.
 */
const NAVER_ISSUER = 'https://nid.naver.com';
const NAVER_JWKS_URI = 'https://nid.naver.com/oauth2/jwks';

/**
 * user-info 조회의 응답 대기 한도(ms)
 *
 * undici의 기본값은 사실상 무제한이라, 네이버가 응답을 붙들고 있으면 요청 핸들러가 몇 분씩
 * 살아남는다. 작은 GET 하나의 정상 응답은 수백 ms 수준이므로 5초면 넉넉하다.
 * 초과 시 native 로그인은 프로필 보강만 건너뛰고 계속되고(withNaverProfile의 catch),
 * 웹 흐름은 로그인이 실패해 사용자가 재시도한다 — 어느 쪽도 무한 대기보다 낫다.
 */
const USERINFO_TIMEOUT_MS = 5_000;

interface NaverTokenResponse
{
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
}

interface NaverUserInfo
{
    resultcode?: unknown;
    response?: {
        id?: unknown;
        email?: unknown;
        name?: unknown;
        nickname?: unknown;
        profile_image?: unknown;
    };
}

function getNaverConfig()
{
    const clientId = env.SPFN_AUTH_NAVER_CLIENT_ID;
    const clientSecret = env.SPFN_AUTH_NAVER_CLIENT_SECRET;

    if (!clientId || !clientSecret)
    {
        throw new ValidationError({
            message: 'Naver OAuth is not configured. Set SPFN_AUTH_NAVER_CLIENT_ID and SPFN_AUTH_NAVER_CLIENT_SECRET.',
        });
    }

    return {
        clientId,
        clientSecret,
        redirectUri: env.SPFN_AUTH_NAVER_REDIRECT_URI
            || `${resolveAppUrl()}/_auth/oauth/naver/callback`,
    };
}

/**
 * native id_token의 audience로 허용할 Naver client id 목록
 *
 * 네이버는 애플리케이션 하나에 Client ID가 하나이고 PC웹·Android·iOS를 그 안의 환경으로
 * 등록하므로, 기존 웹 client id를 그대로 허용한다. 앱이 별도 애플리케이션을 쓰는 구성만
 * 추가 지정이 필요하다.
 */
function getNaverNativeAudiences(): string[]
{
    const ids = (env.SPFN_AUTH_NAVER_NATIVE_CLIENT_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean);

    if (env.SPFN_AUTH_NAVER_CLIENT_ID)
    {
        ids.push(env.SPFN_AUTH_NAVER_CLIENT_ID);
    }

    return ids;
}

async function requestNaverTokens(params: URLSearchParams): Promise<OAuthTokens>
{
    const response = await fetch(NAVER_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: params,
    });

    if (!response.ok)
    {
        throw new Error(`Naver token request failed with status ${response.status}`);
    }

    const body = await response.json() as NaverTokenResponse;
    const expiresIn = Number(body.expires_in);
    if (typeof body.access_token !== 'string' || !Number.isFinite(expiresIn) || expiresIn <= 0)
    {
        throw new Error('Naver token response is invalid');
    }

    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
        expiresIn,
    };
}

/**
 * 네이버 연결 끊기 알림의 암호화/서명 키
 *
 * 네이버 규격: encryptKey(16byte) = md5(CLIENT_SECRET)의 앞 16바이트.
 * AES-128-CBC 복호화 키와 HMAC-SHA256 서명 키로 공용된다.
 */
function deriveNaverUnlinkKey(clientSecret: string): Buffer
{
    return createHash('md5').update(clientSecret).digest().subarray(0, 16);
}

/**
 * base64url·base64 혼용 입력을 표준 base64로 정규화해 디코드
 */
function decodeBase64Url(value: string): Buffer
{
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * encryptUniqueId 복호화. 형식이 깨진 입력이면 null.
 */
function decryptNaverUniqueId(encryptUniqueId: string, key: Buffer): string | null
{
    try
    {
        const payload = decodeBase64Url(encryptUniqueId);
        const decipher = createDecipheriv('aes-128-cbc', key, payload.subarray(0, 16));
        const uniqueId = Buffer.concat([
            decipher.update(payload.subarray(16)),
            decipher.final(),
        ]).toString('utf8');

        return uniqueId || null;
    }
    catch
    {
        return null;
    }
}

/**
 * access token으로 네이버 사용자 정보를 조회해 공통 신원으로 정규화한다.
 */
async function fetchNaverIdentity(accessToken: string): Promise<NormalizedIdentity>
{
    const response = await fetch(NAVER_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS),
    });

    if (!response.ok)
    {
        throw new Error(`Naver user-info request failed with status ${response.status}`);
    }

    const body = await response.json() as NaverUserInfo;
    const profile = body.response;
    if (body.resultcode !== '00' || typeof profile?.id !== 'string')
    {
        throw new Error('Naver user-info response is invalid');
    }

    return {
        providerUserId: profile.id,
        email: typeof profile.email === 'string' ? profile.email : null,
        // 존재하면 검증된 것으로 취급한다. 응답에는 검증 플래그가 없고, 근거는 네이버가
        // 연락처 이메일을 바꿀 때 새 주소로 보낸 인증번호를 요구한다는 것 하나다. 그래서
        // 이 값은 소유가 확인된 주소이지 안정적인 식별자는 아니다 — 사용자가 바꿀 수 있고,
        // 하나의 주소를 최대 6개 아이디가 공유할 수 있으며, 아예 없을 수도 있다.
        // 계정을 가리키는 유일 키는 providerUserId뿐이다.
        //
        // 카카오와 근거가 다르다. 카카오는 응답의 is_email_valid·is_email_verified를
        // 직접 보고, 네이버는 변경 시점의 인증에 의존한다.
        emailVerified: typeof profile.email === 'string',
        name: typeof profile.name === 'string'
            ? profile.name
            : (typeof profile.nickname === 'string' ? profile.nickname : undefined),
        avatar: typeof profile.profile_image === 'string' ? profile.profile_image : undefined,
    };
}

/**
 * id_token이 담지 않는 이메일을 user-info 조회로 채운다.
 *
 * 네이버 id_token의 claim은 iss·aud·azp·sub·nonce·jti·iat·exp뿐이라 이메일도 프로필도 없다.
 * access token이 함께 온 경우에만 웹 흐름과 같은 신원을 얻는다.
 *
 * ⚠️ access token은 클라이언트가 보낸 검증되지 않은 값이다. 다른 사용자의 토큰이 섞이면
 * 남의 이메일이 계정에 붙으므로, 조회 결과의 식별자가 id_token의 sub와 같을 때만 신뢰한다.
 * sub가 pairwise라 다른 애플리케이션에서 발급된 토큰은 이 대조에서 걸린다.
 *
 * 조회 실패는 로그인을 막지 않는다 — 이메일 없이 진행한다(id_token 검증은 이미 통과했다).
 */
async function withNaverProfile(
    identity: NormalizedIdentity,
    accessToken: string,
): Promise<NormalizedIdentity>
{
    const fetched = await fetchNaverIdentity(accessToken).catch((err: unknown) =>
    {
        authLogger.service.warn('Naver user-info lookup failed; continuing without email', {
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
        authLogger.service.warn('Naver access token belongs to another user; ignoring it', {
            subject: identity.providerUserId,
        });

        return identity;
    }

    return fetched;
}

export const naverProvider: OAuthProvider = {
    id: 'naver',

    isEnabled(): boolean
    {
        return !!(env.SPFN_AUTH_NAVER_CLIENT_ID && env.SPFN_AUTH_NAVER_CLIENT_SECRET);
    },

    getAuthUrl(state: string): string
    {
        const config = getNaverConfig();
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            state,
        });

        return `${NAVER_AUTH_URL}?${params.toString()}`;
    },

    async exchangeCodeForTokens(
        code: string,
        options: OAuthCodeExchangeOptions,
    ): Promise<OAuthTokens>
    {
        const config = getNaverConfig();

        return requestNaverTokens(new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: config.redirectUri,
            code,
            state: options.state,
        }));
    },

    async getUserInfo(accessToken: string): Promise<NormalizedIdentity>
    {
        return fetchNaverIdentity(accessToken);
    },

    /**
     * 네이티브/웹 SDK가 받은 네이버 id_token을 검증한다.
     *
     * 표준 OIDC라 nonce는 raw 그대로 대조한다(Apple 같은 해싱이 없다). 다만 네이버는
     * nonce의 끝 문자가 A일 때 그것을 떨어뜨려 돌려주므로, 클라이언트는 nonce를 소문자
     * hex로 만들어야 한다 — 문자집합에 A가 없어야 이 경우를 만나지 않는다. base64url은
     * 16바이트 값의 끝이 A·Q·g·w 중 하나라 4번에 1번, 대문자 hex는 16번에 1번 걸린다.
     *
     * id_token에는 이메일도 프로필도 없다. 이메일은 access token이 함께 왔을 때만 얻는다.
     */
    async verifyNativeIdToken(idToken: string, options: NativeVerifyOptions): Promise<NormalizedIdentity>
    {
        const audiences = getNaverNativeAudiences();
        if (audiences.length === 0)
        {
            throw new NativeSignInUnsupportedError({
                message: 'Naver native sign-in is not configured. Set SPFN_AUTH_NAVER_NATIVE_CLIENT_IDS.',
            });
        }

        const payload = await verifyIdToken({
            idToken,
            jwksUri: NAVER_JWKS_URI,
            issuer: NAVER_ISSUER,
            audiences,
            algorithms: ['RS256'],
            expectedNonce: options.nonce,
        });

        // sub은 verifyIdToken이 string으로 보장한다.
        const identity: NormalizedIdentity = {
            providerUserId: payload.sub as string,
            email: null,
            emailVerified: false,
        };

        return options.accessToken
            ? withNaverProfile(identity, options.accessToken)
            : identity;
    },

    async refreshTokens(refreshToken: string): Promise<OAuthTokens>
    {
        const config = getNaverConfig();

        return requestNaverTokens(new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: refreshToken,
        }));
    },

    // 네이버 연결 끊기 알림 규격은 성공 응답으로 204 No Content를 요구한다.
    unlinkNotifyAckStatus: 204,

    /**
     * 네이버 연결 끊기 알림 검증
     *
     * 파라미터: clientId · encryptUniqueId · timestamp · signature.
     * signature = base64url( HMAC-SHA256( "clientId=..&encryptUniqueId=..&timestamp=..", key ) ),
     * encryptUniqueId = base64url( iv(16) + AES-128-CBC-PKCS5(uniqueId, key) ),
     * key = md5(CLIENT_SECRET)[0..16].
     *
     * 복호화된 uniqueId는 프로필 API(/v1/nid/me)의 id와 동일한 이용자 고유 식별자다.
     * 네이버는 실패 요청을 재시도하지 않으므로 재전송(replay) 방어는 검증 통과 후
     * 삭제가 멱등이라는 점에 의존한다.
     */
    async verifyUnlinkNotification(request: UnlinkNotifyRequest): Promise<UnlinkNotification>
    {
        const clientId = env.SPFN_AUTH_NAVER_CLIENT_ID;
        const clientSecret = env.SPFN_AUTH_NAVER_CLIENT_SECRET;
        if (!clientId || !clientSecret)
        {
            throw new UnlinkNotifyRejection(403, 'Naver OAuth is not configured');
        }

        const { clientId: requestClientId, encryptUniqueId, timestamp, signature } = request.fields;
        if (!requestClientId || !encryptUniqueId || !timestamp || !signature)
        {
            throw new UnlinkNotifyRejection(400, 'Naver unlink notification is missing required parameters');
        }

        if (requestClientId !== clientId)
        {
            throw new UnlinkNotifyRejection(403, 'Naver unlink notification clientId mismatch');
        }

        const key = deriveNaverUnlinkKey(clientSecret);
        const baseString = `clientId=${requestClientId}&encryptUniqueId=${encryptUniqueId}&timestamp=${timestamp}`;
        const expected = createHmac('sha256', key).update(baseString).digest();
        const actual = decodeBase64Url(signature);
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        {
            throw new UnlinkNotifyRejection(403, 'Naver unlink notification signature mismatch');
        }

        const uniqueId = decryptNaverUniqueId(encryptUniqueId, key);
        if (!uniqueId)
        {
            throw new UnlinkNotifyRejection(400, 'Naver encryptUniqueId cannot be decrypted');
        }

        return { providerUserId: uniqueId, reason: 'NAVER_UNLINK' };
    },
};

registerOAuthProvider(naverProvider);
