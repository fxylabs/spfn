/**
 * Google OAuthProvider 구현
 *
 * 기존 google.ts의 함수를 OAuthProvider 인터페이스로 래핑한다.
 * google.ts 자체는 그대로 유지(테스트·google 전용 route가 직접 의존).
 *
 * 이 모듈을 import 하는 것만으로 google provider가 registry에 자기 등록된다.
 */

import { env } from '@spfn/auth/config';
import { NativeSignInUnsupportedError } from '@spfn/auth/errors';

import {
    isGoogleOAuthEnabled,
    getGoogleOAuthConfig,
    getGoogleAuthUrl,
    exchangeCodeForTokens,
    getGoogleUserInfo,
    refreshAccessToken,
} from './google';
import { verifyIdToken } from './jwks-verify';
import {
    registerOAuthProvider,
    type OAuthProvider,
    type OAuthTokens,
    type OAuthCodeExchangeOptions,
    type NormalizedIdentity,
    type NativeVerifyOptions,
} from './provider';
import { oauthFlowNonce } from './state';

const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

// Google id_token의 iss는 환경에 따라 두 형태로 온다.
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * native id_token의 audience로 허용할 Google client id 목록
 *
 * iOS·Android·web client id가 제각각이므로 콤마로 나열한다.
 * web OAuth용 SPFN_AUTH_GOOGLE_CLIENT_ID도 audience로 올 수 있어 함께 허용한다.
 */
function getGoogleNativeAudiences(): string[]
{
    const ids = (env.SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean);

    if (env.SPFN_AUTH_GOOGLE_CLIENT_ID)
    {
        ids.push(env.SPFN_AUTH_GOOGLE_CLIENT_ID);
    }

    return ids;
}

export const googleProvider: OAuthProvider =
    {
        id: 'google',

        pkce: 'S256',

        isEnabled: isGoogleOAuthEnabled,

        getAuthUrl: getGoogleAuthUrl,

        /**
         * The verifier goes to Google with the code. The id_token that comes back
         * beside the tokens must carry this flow's nonce: one issued to another
         * flow is refused before its identity is read.
         */
        async exchangeCodeForTokens(code: string, options: OAuthCodeExchangeOptions): Promise<OAuthTokens>
        {
            const tokens = await exchangeCodeForTokens(code, options.codeVerifier);

            if (tokens.id_token)
            {
                await verifyIdToken({
                    idToken: tokens.id_token,
                    jwksUri: GOOGLE_JWKS_URI,
                    issuer: GOOGLE_ISSUERS,
                    audiences: [getGoogleOAuthConfig().clientId],
                    algorithms: ['RS256'],
                    expectedNonce: oauthFlowNonce(options.state),
                });
            }

            return {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresIn: tokens.expires_in,
            };
        },

        async getUserInfo(accessToken: string): Promise<NormalizedIdentity>
        {
            const user = await getGoogleUserInfo(accessToken);

            return {
                providerUserId: user.id,
                email: user.email ?? null,
                emailVerified: user.verified_email,
                name: user.name,
                avatar: user.picture,
            };
        },

        async refreshTokens(refreshToken: string): Promise<OAuthTokens>
        {
            const tokens = await refreshAccessToken(refreshToken);

            return {
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresIn: tokens.expires_in,
            };
        },

        async verifyNativeIdToken(idToken: string, options: NativeVerifyOptions): Promise<NormalizedIdentity>
        {
            const audiences = getGoogleNativeAudiences();
            if (audiences.length === 0)
            {
                throw new NativeSignInUnsupportedError({
                    message: 'Google native sign-in is not configured. Set SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS.',
                });
            }

            // Google은 raw nonce를 그대로 id_token nonce claim에 담는다.
            const payload = await verifyIdToken({
                idToken,
                jwksUri: GOOGLE_JWKS_URI,
                issuer: GOOGLE_ISSUERS,
                audiences,
                algorithms: ['RS256'],
                expectedNonce: options.nonce,
            });

            // sub은 verifyIdToken이 string으로 보장한다.
            return {
                providerUserId: payload.sub as string,
                email: (payload.email as string) ?? null,
                emailVerified: payload.email_verified === true || payload.email_verified === 'true',
                name: payload.name as string | undefined,
                avatar: payload.picture as string | undefined,
            };
        },
    };

// dogfood: 패키지 로드 시점에 자기 등록.
//
// ⚠️ 이 등록은 side-effect import(`lib/oauth/index.ts`의 `import './google-provider'`)에
// 의존한다. package.json에 `"sideEffects": false`를 추가하면 이 호출이 tree-shake되어
// Google 로그인이 조용히 깨질 수 있다. 등록 보장은 oauth.test.ts의 회귀 테스트로 고정되어 있다.
registerOAuthProvider(googleProvider);
