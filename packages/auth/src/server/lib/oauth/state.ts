/**
 * OAuth State Management
 *
 * CSRF 방지를 위한 state 파라미터 암호화/복호화
 * - returnUrl: OAuth 성공 후 리다이렉트할 URL
 * - nonce: CSRF 방지용 일회용 토큰
 * - provider: OAuth provider (google, github 등)
 * - publicKey, keyId, fingerprint, algorithm: 클라이언트 키 정보
 * - expiresAt: state 만료 시간
 */

import * as jose from 'jose';
import { env } from '@spfn/auth/config';
import { OAuthStateExpiredError, OAuthStateInvalidError } from '@spfn/auth/errors';
import { type KeyAlgorithmType } from '../../types';

export interface OAuthState
{
    returnUrl: string;
    nonce: string;
    provider: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm: KeyAlgorithmType;
    metadata?: Record<string, unknown>;
}

/**
 * Get encryption key derived from session secret
 */
async function getStateKey(): Promise<Uint8Array>
{
    const secret = env.SPFN_AUTH_SESSION_SECRET;
    const encoder = new TextEncoder();
    const data = encoder.encode(`oauth-state:${secret}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);

    return new Uint8Array(hashBuffer);
}

/**
 * Generate random nonce
 */
function generateNonce(): string
{
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);

    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a CSRF nonce for the OAuth flow. The caller passes it to
 * createOAuthState AND sets it as the oauth_csrf cookie, so the callback can
 * double-submit-verify the flow was initiated by this same browser.
 */
export function generateOAuthNonce(): string
{
    return generateNonce();
}

export interface CreateOAuthStateParams
{
    provider: string;
    returnUrl: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm: KeyAlgorithmType;
    metadata?: Record<string, unknown>;
    /**
     * CSRF nonce bound into the state. Pass the same value as the oauth_csrf
     * cookie. Defaults to a fresh nonce (unbound — legacy/no-CSRF callers).
     */
    nonce?: string;
}

/**
 * OAuth state 생성 및 암호화
 *
 * @param params - state 생성에 필요한 파라미터
 * @returns 암호화된 state 문자열
 */
export async function createOAuthState(params: CreateOAuthStateParams): Promise<string>
{
    const key = await getStateKey();

    const state: OAuthState = {
        returnUrl: params.returnUrl,
        nonce: params.nonce ?? generateNonce(),
        provider: params.provider,
        publicKey: params.publicKey,
        keyId: params.keyId,
        fingerprint: params.fingerprint,
        algorithm: params.algorithm,
        metadata: params.metadata,
    };

    const jwe = await new jose.EncryptJWT({ state })
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setIssuedAt()
        .setExpirationTime('10m')
        .encrypt(key);

    // URL-safe base64 encoding
    return encodeURIComponent(jwe);
}

/**
 * OAuth state 복호화 및 검증
 *
 * @param encryptedState - 암호화된 state 문자열
 * @returns 복호화된 state 객체
 * @throws OAuthStateExpiredError past the ten minutes (jose's exp check)
 * @throws OAuthStateInvalidError for anything that does not decrypt, or decrypts
 *   to a state without its keyId and nonce
 */
export async function verifyOAuthState(encryptedState: string): Promise<OAuthState>
{
    const key = await getStateKey();

    const { payload } = await Promise.resolve()
        .then(() => jose.jwtDecrypt(decodeURIComponent(encryptedState), key))
        .catch((cause: unknown) => Promise.reject(stateRefusal(cause)));
    const state = payload.state as OAuthState | undefined;

    if (typeof state?.keyId !== 'string' || typeof state.nonce !== 'string')
    {
        throw new OAuthStateInvalidError();
    }

    return state;
}

/**
 * The typed refusal for a state that did not decrypt — by jose's error class,
 * never by its message, which is what used to reach the browser verbatim.
 */
function stateRefusal(cause: unknown): Error
{
    return cause instanceof jose.errors.JWTExpired ? new OAuthStateExpiredError() : new OAuthStateInvalidError();
}
