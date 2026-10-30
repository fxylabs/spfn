/**
 * OAuth State Management
 *
 * CSRF 방지를 위한 state 파라미터 암호화/복호화
 * - returnUrl: OAuth 성공 후 리다이렉트할 URL
 * - nonce: CSRF 방지용 일회용 토큰
 * - provider: OAuth provider (google, github 등)
 * - publicKey, keyId, fingerprint, algorithm: 클라이언트 키 정보
 * - expiresAt: state 만료 시간
 *
 * The Android start of Sign in with Apple seals a second kind of state —
 * `createAppleRelayState` / `verifyAppleRelayState` — under its own key, so
 * neither verifier accepts the other's.
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
 * A state key derived from the session secret under `label`.
 *
 * Each kind of state has its own label, so a state sealed for one flow does
 * not decrypt as another's: the web start's verifier never accepts a relay
 * state, and the relay never accepts a web state.
 */
async function deriveStateKey(label: string): Promise<Uint8Array>
{
    const data = new TextEncoder().encode(`${label}:${env.SPFN_AUTH_SESSION_SECRET}`);

    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/**
 * Get encryption key derived from session secret
 */
async function getStateKey(): Promise<Uint8Array>
{
    return await deriveStateKey('oauth-state');
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

/**
 * What a session-initiated link (#154) seals into the `state` it hands the
 * provider: whose account the identity is attached to, where the browser goes
 * back to, and the CSRF pair.
 *
 * Sealed under its own key, so a link state never opens as a sign-in state and
 * a sign-in state never opens as a link — one callback route serves both, and
 * the key is what tells them apart.
 */
export interface OAuthLinkState
{
    provider: string;
    userId: string;
    returnUrl: string;
    nonce: string;
    /** Names the CSRF cookie the link start set, standing where a sign-in's keyId does. */
    startId: string;
}

async function getLinkStateKey(): Promise<Uint8Array>
{
    return await deriveStateKey('oauth-link-state');
}

/**
 * Seal a link state, ten minutes like the sign-in state, percent-encoded the same
 * way so the callback reads both alike.
 */
export async function createOAuthLinkState(link: OAuthLinkState): Promise<string>
{
    const jwe = await new jose.EncryptJWT({ link: { ...link } })
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setIssuedAt()
        .setExpirationTime('10m')
        .encrypt(await getLinkStateKey());

    return encodeURIComponent(jwe);
}

/**
 * Open a link state, or null when the value is not one.
 *
 * Null for anything that does not decrypt with the link key — a sign-in state, a
 * forged or truncated value — and for a payload that is not a link. Expiry is
 * read only from the `JWTExpired` jose throws after the authenticated decryption
 * succeeded, so only a genuine link state is ever refused as expired.
 *
 * @throws OAuthStateExpiredError for a link state past its ten minutes
 */
export async function openOAuthLinkState(sealed: string): Promise<OAuthLinkState | null>
{
    const key = await getLinkStateKey();
    const payload = await Promise.resolve()
        .then(() => jose.jwtDecrypt(decodeURIComponent(sealed), key))
        .then(({ payload: opened }) => opened)
        .catch((cause: unknown) => (cause instanceof jose.errors.JWTExpired
            ? Promise.reject(new OAuthStateExpiredError())
            : null));

    return payload ? linkStateOf(payload) : null;
}

function linkStateOf(payload: jose.JWTPayload): OAuthLinkState | null
{
    const link = payload.link as Partial<OAuthLinkState> | undefined;
    const fields = [link?.provider, link?.userId, link?.returnUrl, link?.nonce, link?.startId];

    return fields.every(field => typeof field === 'string') ? link as OAuthLinkState : null;
}

/**
 * What the Android start of Sign in with Apple seals into the `state` it hands
 * Apple: the app's own state, which the relay gives back to the app, and the
 * App Link the callback relays to.
 */
export interface AppleRelayState
{
    appState: string;
    relayUrl: string;
}

/**
 * A relay state that decrypted with the relay key. `expired` is true past the
 * ten minutes — the payload is still the authenticated one, so the relay can
 * tell the app why.
 */
export interface VerifiedAppleRelayState
{
    relay: AppleRelayState;
    expired: boolean;
}

/** The app's state, as the native start accepts it (P3). */
export const APPLE_RELAY_APP_STATE_PATTERN = '^[A-Za-z0-9_-]{16,128}$';

async function getAppleRelayStateKey(): Promise<Uint8Array>
{
    return await deriveStateKey('oauth-relay-state');
}

/**
 * Seal the Android start's state, ten minutes like the web start's.
 *
 * The JWE compact form is URL-safe, so unlike `createOAuthState` the result is
 * not percent-encoded: it travels as a query value to Apple and comes back as a
 * form field.
 */
export async function createAppleRelayState(relay: AppleRelayState): Promise<string>
{
    return await new jose.EncryptJWT({ relay: { appState: relay.appState, relayUrl: relay.relayUrl } })
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setIssuedAt()
        .setExpirationTime('10m')
        .encrypt(await getAppleRelayStateKey());
}

/**
 * Open a relay state, or null when it is not one.
 *
 * Null for anything that does not decrypt with the relay key — a web state, a
 * forged or truncated value — and for a payload that is not a relay. An expired
 * state is read only from the `JWTExpired` jose throws after the authenticated
 * decryption succeeded, so a value that never decrypted is never parsed.
 */
export async function verifyAppleRelayState(sealed: string): Promise<VerifiedAppleRelayState | null>
{
    const key = await getAppleRelayStateKey();
    const opened = await jose.jwtDecrypt(sealed, key)
        .then(({ payload }) => ({ payload, expired: false }))
        .catch((cause: unknown) => (cause instanceof jose.errors.JWTExpired
            ? { payload: cause.payload, expired: true }
            : null));

    if (!opened)
    {
        return null;
    }

    const relay = appleRelayOf(opened.payload);

    return relay ? { relay, expired: opened.expired } : null;
}

function appleRelayOf(payload: jose.JWTPayload): AppleRelayState | null
{
    const relay = payload.relay as Partial<AppleRelayState> | undefined;

    if (typeof relay?.appState !== 'string' || typeof relay.relayUrl !== 'string'
        || !new RegExp(APPLE_RELAY_APP_STATE_PATTERN).test(relay.appState))
    {
        return null;
    }

    return { appState: relay.appState, relayUrl: relay.relayUrl };
}
