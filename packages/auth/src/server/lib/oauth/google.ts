/**
 * Google OAuth 2.0 Client
 *
 * Authorization Code Flow 구현
 * - getGoogleAuthUrl: Google 로그인 URL 생성
 * - exchangeCodeForTokens: Code를 Token으로 교환
 * - getGoogleUserInfo: 사용자 정보 조회
 */

import { env } from '@spfn/auth/config';
import { resolveAppUrl } from '../app-url';

// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export interface GoogleTokenResponse
{
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
    token_type: string;
    id_token?: string;
}

export interface GoogleUserInfo
{
    id: string;
    email: string;
    verified_email: boolean;
    name?: string;
    given_name?: string;
    family_name?: string;
    picture?: string;
    locale?: string;
}

/**
 * Google OAuth가 활성화되어 있는지 확인
 */
export function isGoogleOAuthEnabled(): boolean
{
    return !!(env.SPFN_AUTH_GOOGLE_CLIENT_ID && env.SPFN_AUTH_GOOGLE_CLIENT_SECRET);
}

/**
 * Google OAuth 설정 가져오기
 */
export function getGoogleOAuthConfig()
{
    const clientId = env.SPFN_AUTH_GOOGLE_CLIENT_ID;
    const clientSecret = env.SPFN_AUTH_GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret)
    {
        throw new Error('Google OAuth is not configured. Set SPFN_AUTH_GOOGLE_CLIENT_ID and SPFN_AUTH_GOOGLE_CLIENT_SECRET.');
    }

    // 콜백은 CSRF 쿠키(oauth_csrf)를 심은 웹 앱 origin으로 돌아와야 한다.
    // web/api가 다른 호스트인 분리 배포에서 API 호스트로 돌아오면 호스트 전용
    // 쿠키가 전달되지 않아 콜백 CSRF 검증이 항상 실패한다. 앱에는
    // /_auth/:path* → API rewrite가 표준 구성이다(README의 OAuth 절 참고).
    // 앱 URL에는 기본값이 없다 — 둘 다 없으면 resolveAppUrl이 두 변수를 짚어 실패한다.
    const redirectUri = env.SPFN_AUTH_GOOGLE_REDIRECT_URI
        || `${resolveAppUrl()}/_auth/oauth/google/callback`;

    return {
        clientId,
        clientSecret,
        redirectUri,
    };
}

/**
 * 환경변수 또는 기본값에서 Google OAuth scopes 가져오기
 *
 * SPFN_AUTH_GOOGLE_SCOPES가 설정되면 콤마로 분리하여 사용.
 * 미설정이면 ['email', 'profile'] 기본값 사용.
 */
function getDefaultScopes(): string[]
{
    const envScopes = env.SPFN_AUTH_GOOGLE_SCOPES;
    if (envScopes)
    {
        return envScopes.split(',').map(s => s.trim()).filter(Boolean);
    }

    return ['email', 'profile'];
}

/**
 * Google 로그인 URL 생성
 *
 * @param state - CSRF 방지용 state 파라미터 (암호화된 returnUrl + nonce 포함)
 * @param scopes - 요청할 OAuth scopes (기본: env 또는 email, profile)
 */
export function getGoogleAuthUrl(
    state: string,
    scopes?: string[],
): string
{
    const resolvedScopes = scopes ?? getDefaultScopes();
    const config = getGoogleOAuthConfig();

    const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: resolvedScopes.join(' '),
        state,
        access_type: 'offline',  // refresh_token 받기 위해
        prompt: 'consent',       // 매번 동의 화면 표시 (refresh_token 보장)
    });

    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Authorization Code를 Token으로 교환
 *
 * @param code - Google에서 받은 authorization code
 */
export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse>
{
    const config = getGoogleOAuthConfig();

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: config.redirectUri,
            grant_type: 'authorization_code',
            code,
        }),
    });

    if (!response.ok)
    {
        const error = await response.text();
        throw new Error(`Failed to exchange code for tokens: ${error}`);
    }

    return response.json();
}

/**
 * Access Token으로 Google 사용자 정보 조회
 *
 * @param accessToken - Google access token
 */
export async function getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo>
{
    const response = await fetch(GOOGLE_USERINFO_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    });

    if (!response.ok)
    {
        const error = await response.text();
        throw new Error(`Failed to get user info: ${error}`);
    }

    return response.json();
}

/**
 * Refresh Token으로 새 Access Token 획득
 *
 * @param refreshToken - Google refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse>
{
    const config = getGoogleOAuthConfig();

    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
        }),
    });

    if (!response.ok)
    {
        const error = await response.text();
        throw new Error(`Failed to refresh access token: ${error}`);
    }

    return response.json();
}
