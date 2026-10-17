/**
 * OAuth Provider 추상화
 *
 * Provider별로 하드코딩된 분기를 제거하기 위한 공통 인터페이스와 registry.
 * - 내장 provider(google)는 패키지 로드 시점에 자기 등록(dogfood)
 * - 외부 패키지(@superself/auth 등)는 registerOAuthProvider()로 런타임 등록
 *
 * @spfn/auth는 토큰 issuer가 아니라 소비(client) 측이므로, 이 추상화는
 * web 흐름("authorize URL 생성 → code 교환 → 사용자 정보 정규화")과
 * native 흐름(네이티브/웹 SDK가 받은 id_token 직접 검증)을 다룬다.
 */

import { type SocialProvider } from '../../types';

/**
 * Provider 사용자 정보를 공통 형태로 정규화한 신원
 *
 * provider별 응답 형태(snake_case 등)를 service에 노출하지 않기 위한 경계.
 */
export interface NormalizedIdentity
{
    providerUserId: string;
    email: string | null;
    emailVerified: boolean;
    name?: string;
    avatar?: string;
}

/**
 * 정규화된 OAuth 토큰 응답
 *
 * @property expiresIn - access token 만료까지 남은 초(seconds)
 */
export interface OAuthTokens
{
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
    /**
     * The identity the token response itself established (an OIDC id_token), when the provider
     * has no userinfo endpoint. The callback service uses it and skips getUserInfo.
     */
    identity?: NormalizedIdentity;
}

/**
 * 네이티브 id_token 검증 옵션
 */
export interface NativeVerifyOptions
{
    /** 클라이언트가 생성한 raw nonce. provider별 규약(raw 또는 SHA-256 해시)으로 대조된다. */
    nonce: string;

    /**
     * 같은 로그인에서 SDK가 함께 받은 provider access token (선택).
     *
     * id_token만으로는 알 수 없는 claim을 provider API로 보강하려는 provider가 쓴다
     * (카카오: id_token에 email_verified가 없어 /v2/user/me의 이메일 유효·인증 플래그를 본다).
     *
     * ⚠️ 클라이언트가 보낸 검증되지 않은 값이다. 다른 사용자의 토큰일 수 있으므로,
     * 이 값으로 조회한 신원은 반드시 id_token의 sub와 대조한 뒤에만 신뢰해야 한다.
     */
    accessToken?: string;
}

export interface OAuthCodeExchangeOptions
{
    /** Provider가 callback에 돌려준 원본 state. 일부 provider는 token 교환에도 요구한다. */
    state: string;
    /** Apple only: the `user` JSON Apple posts with the first authorization (name), raw, ≤ 2048 bytes. */
    user?: string;
}

/**
 * Provider가 서비스로 보내는 연동 해제 알림의 원재료
 *
 * provider마다 전달 방식(query/form/JSON, 헤더 인증)이 달라 route가 정규화해 넘긴다.
 * fields는 query string과 body(form/JSON)를 병합한 문자열 맵이다.
 */
export interface UnlinkNotifyRequest
{
    /** Authorization 헤더 원문 (없으면 null) */
    authorization: string | null;
    fields: Record<string, string>;
}

/**
 * 검증에 성공한 연동 해제 알림
 */
export interface UnlinkNotification
{
    providerUserId: string;
    /** provider가 전달한 해제 경로 (kakao referrer_type 등) */
    reason?: string;
}

/**
 * 연동 해제 알림 검증 실패
 *
 * API 에러 응답 체계를 타지 않는다 — route가 잡아 status만 반환한다.
 * (provider 웹훅은 사람이 아닌 provider 서버가 호출자라서 에러 본문이 무의미하다)
 */
export class UnlinkNotifyRejection extends Error
{
    readonly status: 400 | 401 | 403;

    constructor(status: 400 | 401 | 403, message: string)
    {
        super(message);
        this.name = 'UnlinkNotifyRejection';
        this.status = status;
    }
}

/**
 * OAuth provider 구현 인터페이스
 *
 * google, superself 등 모든 provider가 이 형태를 만족해야 registry에 등록된다.
 */
export interface OAuthProvider
{
    id: SocialProvider;

    /**
     * provider가 사용 가능한 상태인지(필수 env 등) 확인
     */
    isEnabled(): boolean;

    /**
     * provider 로그인 페이지로 보낼 authorization URL 생성
     *
     * @param state - CSRF 방지용 암호화 state
     * @param scopes - 요청할 scope (미지정 시 provider 기본값)
     */
    getAuthUrl(state: string, scopes?: string[]): string;

    /**
     * authorization code를 토큰으로 교환
     */
    exchangeCodeForTokens(code: string, options: OAuthCodeExchangeOptions): Promise<OAuthTokens>;

    /**
     * access token으로 사용자 정보를 조회하고 공통 형태로 정규화
     */
    getUserInfo(accessToken: string): Promise<NormalizedIdentity>;

    /**
     * refresh token으로 access token 갱신 (provider가 지원하는 경우)
     *
     * 저장된 provider 토큰을 이후 API 호출에 재사용할 때 사용한다.
     * 미구현 provider는 갱신 불가로 간주한다.
     */
    refreshTokens?(refreshToken: string): Promise<OAuthTokens>;

    /**
     * 네이티브/웹 SDK가 받은 id_token을 직접 검증하고 신원을 정규화한다.
     *
     * authorization code 교환 없이 provider JWKS로 서명을 검증하므로 client secret이
     * 필요 없다. native sign-in을 지원하는 provider만 구현한다(Apple은 web SDK 부재로
     * Android·웹도 이 경로를 쓴다).
     */
    verifyNativeIdToken?(idToken: string, options: NativeVerifyOptions): Promise<NormalizedIdentity>;

    /**
     * Provider발 연동 해제 알림(웹훅)을 검증하고 대상 사용자를 식별한다.
     *
     * 인증 없는 공개 엔드포인트로 들어오므로 provider별 규격(카카오: 어드민 키 헤더,
     * 네이버: HMAC 서명 + AES 복호화)의 검증을 통과해야만 처리된다.
     * 검증 실패는 UnlinkNotifyRejection을 던진다.
     */
    verifyUnlinkNotification?(request: UnlinkNotifyRequest): Promise<UnlinkNotification>;

    /**
     * 연동 해제 알림 처리 성공 시 응답할 HTTP status (미지정 시 200)
     *
     * 네이버는 204 No Content를 요구한다.
     */
    unlinkNotifyAckStatus?: 200 | 204;

    /**
     * How the provider sends the browser back: 'query' (GET with ?code&state, the default) or
     * 'form_post' (a cross-site POST with a form body; accepted by POST /_auth/oauth/:provider/callback,
     * which 303-redirects to the GET callback).
     */
    callbackResponseMode?: 'query' | 'form_post';
}

const registry = new Map<SocialProvider, OAuthProvider>();

/**
 * OAuth provider 등록 (public)
 *
 * 동일 id로 다시 등록하면 덮어쓴다(외부 패키지의 override 허용).
 */
export function registerOAuthProvider(provider: OAuthProvider): void
{
    registry.set(provider.id, provider);
}

/**
 * 등록된 provider 조회. 미등록이면 undefined.
 */
export function getOAuthProvider(id: SocialProvider): OAuthProvider | undefined
{
    return registry.get(id);
}

/**
 * 등록된 모든 provider 목록
 */
export function getRegisteredProviders(): OAuthProvider[]
{
    return [...registry.values()];
}
