/**
 * @spfn/auth - OAuth Unit Tests
 *
 * Tests for OAuth state management and pending session
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RequestInterceptorContext } from '@spfn/core/nextjs/server';
import {
    createOAuthState,
    verifyOAuthState,
} from '../../server/lib/oauth/state';
import {
    isGoogleOAuthEnabled,
    getGoogleAuthUrl,
    getGoogleOAuthConfig,
} from '../../server/lib/oauth/google';
// index 경로로 import → side-effect로 google provider가 registry에 자기 등록됨
import {
    registerOAuthProvider,
    getOAuthProvider,
    getRegisteredProviders,
    type OAuthProvider,
} from '../../server/lib/oauth';
import { oauthStartService, oauthCallbackService } from '../../server/services/oauth.service';
import { matchOAuthCsrfCookies } from '../../server/lib/config';
import {
    sealPendingSession,
    unsealPendingSession,
    type PendingSessionData,
} from '../../nextjs/session-helpers';
import { oauthUrlInterceptor } from '../../nextjs/interceptors/oauth';
import { errorRegistry, ValidationError } from '@spfn/core/errors';

/**
 * 테스트용 mock provider 생성 헬퍼
 */
function mockProvider(id: OAuthProvider['id'], enabled = true): OAuthProvider
{
    return {
        id,
        isEnabled: () => enabled,
        getAuthUrl: (state: string) => `https://mock.example.com/${id}/auth?state=${state}`,
        exchangeCodeForTokens: async () => ({ accessToken: 'mock-access', refreshToken: 'mock-refresh', expiresIn: 3600 }),
        getUserInfo: async () => ({ providerUserId: 'mock-id', email: null, emailVerified: false }),
    };
}

describe('OAuth State - Create/Verify', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    const mockStateParams = {
        provider: 'google',
        returnUrl: '/dashboard',
        publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...',
        keyId: 'key-uuid-123',
        fingerprint: 'abc123def456',
        algorithm: 'ES256' as const,
    };

    it('should create and verify OAuth state', async () =>
    {
        const state = await createOAuthState(mockStateParams);

        expect(state).toBeTruthy();
        expect(typeof state).toBe('string');

        const verified = await verifyOAuthState(state);

        expect(verified.provider).toBe('google');
        expect(verified.returnUrl).toBe('/dashboard');
        expect(verified.publicKey).toBe(mockStateParams.publicKey);
        expect(verified.keyId).toBe('key-uuid-123');
        expect(verified.fingerprint).toBe('abc123def456');
        expect(verified.algorithm).toBe('ES256');
        expect(verified.nonce).toBeTruthy();
    });

    it('should produce different state for same params (different nonce)', async () =>
    {
        const state1 = await createOAuthState(mockStateParams);
        const state2 = await createOAuthState(mockStateParams);

        expect(state1).not.toBe(state2);

        const verified1 = await verifyOAuthState(state1);
        const verified2 = await verifyOAuthState(state2);

        expect(verified1.nonce).not.toBe(verified2.nonce);
    });

    it('binds an explicit CSRF nonce into the state (round-trips for cookie match)', async () =>
    {
        const state = await createOAuthState({ ...mockStateParams, nonce: 'csrf-nonce-123' });
        const verified = await verifyOAuthState(state);

        // The callback double-submits this against the oauth_csrf cookie.
        expect(verified.nonce).toBe('csrf-nonce-123');
    });

    it('should reject tampered state', async () =>
    {
        const state = await createOAuthState(mockStateParams);

        // Tamper with the state
        const decoded = decodeURIComponent(state);
        const tampered = encodeURIComponent(decoded.slice(0, -10) + 'TAMPERED!!');

        await expect(verifyOAuthState(tampered)).rejects.toThrow();
    });

    it('should reject malformed state', async () =>
    {
        await expect(verifyOAuthState('not-a-valid-state')).rejects.toThrow();
    });

    it('should handle URL-safe encoding', async () =>
    {
        const params = {
            ...mockStateParams,
            returnUrl: '/path?query=value&foo=bar',
        };

        const state = await createOAuthState(params);
        const verified = await verifyOAuthState(state);

        expect(verified.returnUrl).toBe('/path?query=value&foo=bar');
    });
});

describe('OAuth State - Expiration', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('should verify state within TTL (JWE exp claim)', async () =>
    {
        const state = await createOAuthState({
            provider: 'google',
            returnUrl: '/',
            publicKey: 'key',
            keyId: 'id',
            fingerprint: 'fp',
            algorithm: 'ES256',
        });

        // State should be verifiable immediately
        const verified = await verifyOAuthState(state);
        expect(verified.provider).toBe('google');
    });
});

describe('Google OAuth Config', () =>
{
    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('should return false when Google OAuth is not configured', () =>
    {
        vi.unstubAllEnvs();

        expect(isGoogleOAuthEnabled()).toBe(false);
    });

    it('should return true when Google OAuth is configured', () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'test-client-id.apps.googleusercontent.com');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'GOCSPX-test-secret');

        expect(isGoogleOAuthEnabled()).toBe(true);
    });

    it('should throw when getting config without credentials', () =>
    {
        vi.unstubAllEnvs();

        expect(() => getGoogleOAuthConfig()).toThrow('Google OAuth is not configured');
    });

    it('should return config when credentials are set', () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'test-client-id.apps.googleusercontent.com');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'GOCSPX-test-secret');

        const config = getGoogleOAuthConfig();

        expect(config.clientId).toBe('test-client-id.apps.googleusercontent.com');
        expect(config.clientSecret).toBe('GOCSPX-test-secret');
        // SPFN_APP_URL 기본값(http://localhost:3000) 기반 — 콜백은 CSRF 쿠키가
        // 심긴 웹 앱 origin으로 돌아온다.
        expect(config.redirectUri).toBe('http://localhost:3000/_auth/oauth/google/callback');
    });

    it('should use custom redirect URI when provided', () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'test-client-id');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'test-secret');
        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', 'https://custom.example.com/callback');

        const config = getGoogleOAuthConfig();

        expect(config.redirectUri).toBe('https://custom.example.com/callback');
    });

    it('should prefer NEXT_PUBLIC_SPFN_APP_URL over SPFN_APP_URL for redirect URI', () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'test-client-id');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'test-secret');
        vi.stubEnv('SPFN_APP_URL', 'http://localhost:3000');
        vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', 'https://app.example.com');

        const config = getGoogleOAuthConfig();

        expect(config.redirectUri).toBe('https://app.example.com/_auth/oauth/google/callback');
    });

    it('should base the redirect URI on the app URL, not the API URL', () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'test-client-id');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'test-secret');
        vi.stubEnv('SPFN_APP_URL', 'https://app.example.com');
        vi.stubEnv('SPFN_API_URL', 'https://api.example.com');
        vi.stubEnv('NEXT_PUBLIC_SPFN_API_URL', 'https://api.example.com');

        const config = getGoogleOAuthConfig();

        // 분리 배포 회귀 가드: API 호스트로 돌아오면 web 호스트 전용 CSRF
        // 쿠키가 전달되지 않는다 (issue #17).
        expect(config.redirectUri).toBe('https://app.example.com/_auth/oauth/google/callback');
    });
});

describe('Google Auth URL', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'test-client-id.apps.googleusercontent.com');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'GOCSPX-test-secret');
        vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('should generate valid Google OAuth URL', () =>
    {
        const state = 'encrypted-state-value';
        const authUrl = getGoogleAuthUrl(state);

        expect(authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
        expect(authUrl).toContain('client_id=test-client-id.apps.googleusercontent.com');
        expect(authUrl).toContain('response_type=code');
        expect(authUrl).toContain('scope=email+profile');
        expect(authUrl).toContain('state=encrypted-state-value');
        expect(authUrl).toContain('access_type=offline');
    });

    it('should include redirect URI', () =>
    {
        const authUrl = getGoogleAuthUrl('state');

        expect(authUrl).toContain(encodeURIComponent('http://localhost:3000/_auth/oauth/google/callback'));
    });
});

describe('OAuth CSRF cookie matching (matchOAuthCsrfCookies)', () =>
{
    it('should match the base name and any PORT-suffixed variant', () =>
    {
        const matched = matchOAuthCsrfCookies({
            spfn_oauth_csrf: 'nonce-base',
            spfn_oauth_csrf_3790: 'nonce-web',
            spfn_oauth_csrf_8790: 'nonce-api',
        });

        expect(matched).toEqual([
            { name: 'spfn_oauth_csrf', value: 'nonce-base' },
            { name: 'spfn_oauth_csrf_3790', value: 'nonce-web' },
            { name: 'spfn_oauth_csrf_8790', value: 'nonce-api' },
        ]);
    });

    it('should ignore unrelated and malformed cookie names', () =>
    {
        const matched = matchOAuthCsrfCookies({
            spfn_oauth_pending_3790: 'pending',
            spfn_session: 'session',
            spfn_oauth_csrf_abc: 'bad-suffix',
            spfn_oauth_csrf_3790_extra: 'bad-shape',
        });

        expect(matched).toEqual([]);
    });
});

describe('OAuth Callback - CSRF nonce candidates', () =>
{
    const mockStateParams = {
        provider: 'google',
        returnUrl: '/dashboard',
        publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...',
        keyId: 'key-uuid-123',
        fingerprint: 'abc123def456',
        algorithm: 'ES256' as const,
    };

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('should reject when no candidate is present (fails closed)', async () =>
    {
        const state = await createOAuthState({ ...mockStateParams, nonce: 'nonce-a' });

        await expect(oauthCallbackService({
            provider: 'google', code: 'code', state, expectedNonce: [],
        })).rejects.toThrow('OAuth state validation failed');

        await expect(oauthCallbackService({
            provider: 'google', code: 'code', state, expectedNonce: undefined,
        })).rejects.toThrow('OAuth state validation failed');
    });

    it('should reject when no candidate matches the state nonce', async () =>
    {
        const state = await createOAuthState({ ...mockStateParams, nonce: 'nonce-a' });

        await expect(oauthCallbackService({
            provider: 'google', code: 'code', state, expectedNonce: ['nonce-b', 'nonce-c'],
        })).rejects.toThrow('OAuth state validation failed');
    });

    it('should pass the CSRF gate when one of several candidates matches', async () =>
    {
        const state = await createOAuthState({ ...mockStateParams, nonce: 'nonce-a' });

        // CSRF 게이트를 통과하면 다음 단계(provider 설정 검사)에서 실패한다 —
        // 접미사가 다른 여분 쿠키가 섞여 있어도 대조가 성공함을 고정한다.
        await expect(oauthCallbackService({
            provider: 'google', code: 'code', state, expectedNonce: ['stale-nonce', 'nonce-a'],
        })).rejects.toThrow(/registered but not configured/);
    });

    it('should keep accepting a single string nonce (backward compat)', async () =>
    {
        const state = await createOAuthState({ ...mockStateParams, nonce: 'nonce-a' });

        await expect(oauthCallbackService({
            provider: 'google', code: 'code', state, expectedNonce: 'nonce-a',
        })).rejects.toThrow(/registered but not configured/);
    });

    it('passes the original callback state to providers that require it for token exchange', async () =>
    {
        const exchangeCodeForTokens = vi.fn().mockRejectedValue(new Error('stop-after-exchange'));
        registerOAuthProvider({
            ...mockProvider('naver'),
            exchangeCodeForTokens,
        });
        const state = await createOAuthState({
            ...mockStateParams,
            provider: 'naver',
            nonce: 'nonce-a',
        });

        await expect(oauthCallbackService({
            provider: 'naver', code: 'authorization-code', state, expectedNonce: 'nonce-a',
        })).rejects.toThrow('stop-after-exchange');
        expect(exchangeCodeForTokens).toHaveBeenCalledWith('authorization-code', { state });
    });
});

describe('Pending Session - Seal/Unseal', () =>
{
    const mockPendingSession: PendingSessionData = {
        privateKey: 'MHcCAQEEIAbK7gT9pqxQx...',
        keyId: 'key-uuid-123',
        algorithm: 'ES256',
    };

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('should seal and unseal pending session', async () =>
    {
        const sealed = await sealPendingSession(mockPendingSession);

        expect(sealed).toBeTruthy();
        expect(sealed.split('.')).toHaveLength(5); // JWE format

        const unsealed = await unsealPendingSession(sealed);

        expect(unsealed.privateKey).toBe(mockPendingSession.privateKey);
        expect(unsealed.keyId).toBe('key-uuid-123');
        expect(unsealed.algorithm).toBe('ES256');
    });

    it('should produce different output for same data (different IV)', async () =>
    {
        const sealed1 = await sealPendingSession(mockPendingSession);
        const sealed2 = await sealPendingSession(mockPendingSession);

        expect(sealed1).not.toBe(sealed2);

        // But both decrypt to same data
        const unsealed1 = await unsealPendingSession(sealed1);
        const unsealed2 = await unsealPendingSession(sealed2);

        expect(unsealed1).toEqual(unsealed2);
    });

    it('should reject tampered pending session', async () =>
    {
        const sealed = await sealPendingSession(mockPendingSession);

        const parts = sealed.split('.');
        parts[3] = parts[3].slice(0, -10) + 'TAMPERED!!';
        const tampered = parts.join('.');

        await expect(unsealPendingSession(tampered)).rejects.toThrow();
    });

    it('should use short TTL by default (10 minutes)', async () =>
    {
        const sealed = await sealPendingSession(mockPendingSession);

        // Verify unsealing works immediately
        const unsealed = await unsealPendingSession(sealed);
        expect(unsealed).toEqual(mockPendingSession);
    });

    it('should reject expired pending session', async () =>
    {
        // Create with very short TTL
        const sealed = await sealPendingSession(mockPendingSession, 1);

        // Wait for expiration
        await new Promise(resolve => setTimeout(resolve, 1500));

        await expect(unsealPendingSession(sealed)).rejects.toThrow();
    });
});

describe('OAuth Interceptor Logic', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'test-client-id');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'test-secret');
        vi.stubEnv('SPFN_API_URL', 'http://localhost:8790');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('oauthUrlInterceptor pathPattern should match OAuth URL paths', () =>
    {
        const pattern = /^\/_auth\/oauth\/\w+\/url$/;

        expect(pattern.test('/_auth/oauth/google/url')).toBe(true);
        expect(pattern.test('/_auth/oauth/github/url')).toBe(true);
        expect(pattern.test('/_auth/oauth/facebook/url')).toBe(true);
        expect(pattern.test('/_auth/oauth/url')).toBe(false);
        expect(pattern.test('/_auth/oauth/google/callback')).toBe(false);
        expect(pattern.test('/api/oauth/google/url')).toBe(false);
    });

    it('oauthFinalizeInterceptor pathPattern should match finalize path', () =>
    {
        const pattern = /^\/_auth\/oauth\/finalize$/;

        expect(pattern.test('/_auth/oauth/finalize')).toBe(true);
        expect(pattern.test('/_auth/oauth/finalize/')).toBe(false);
        expect(pattern.test('/_auth/oauth/google/finalize')).toBe(false);
        expect(pattern.test('/api/oauth/finalize')).toBe(false);
    });

    it('should generate valid state with publicKey included', async () =>
    {
        const stateParams = {
            provider: 'google',
            returnUrl: '/dashboard',
            publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...',
            keyId: 'test-key-id',
            fingerprint: 'test-fingerprint',
            algorithm: 'ES256' as const,
        };

        const state = await createOAuthState(stateParams);
        const verified = await verifyOAuthState(state);

        // State should contain all key info for later session creation
        expect(verified.publicKey).toBe(stateParams.publicKey);
        expect(verified.keyId).toBe(stateParams.keyId);
        expect(verified.fingerprint).toBe(stateParams.fingerprint);
        expect(verified.algorithm).toBe('ES256');
    });

    it.each([
        ['getGoogleOAuthUrl', '/_auth/oauth/google/url', 'google'],
        ['getProviderOAuthUrl', '/_auth/oauth/naver/url', 'naver'],
    ])('should seal metadata from %s into OAuth state', async (_name, path, provider) =>
    {
        const ctx = {
            path,
            body: {
                returnUrl: '/signup/complete',
                metadata: {
                    birthDate: '2000-01-01',
                    termsAgreed: true,
                },
            },
            metadata: {},
        } as unknown as RequestInterceptorContext;
        const next = vi.fn(async () => undefined);

        await oauthUrlInterceptor.request?.(ctx, next);

        expect(next).toHaveBeenCalledOnce();
        expect(ctx.body.state).toEqual(expect.any(String));

        const verified = await verifyOAuthState(ctx.body.state);
        expect(verified.provider).toBe(provider);
        expect(verified.returnUrl).toBe('/signup/complete');
        expect(verified.metadata).toEqual({
            birthDate: '2000-01-01',
            termsAgreed: true,
        });
    });

    /**
     * Drives the seam the way the proxy does: whatever the caller posted as the
     * body, and nothing else. The interceptor is the only layer that ever sees
     * the caller's returnUrl — after it, every layer sees sealed state.
     */
    async function startWith(returnUrl: unknown)
    {
        const ctx = {
            path: '/_auth/oauth/google/url',
            body: { returnUrl },
            metadata: {},
        } as unknown as RequestInterceptorContext;
        const next = vi.fn(async () => undefined);

        await oauthUrlInterceptor.request?.(ctx, next);

        return { ctx, next };
    }

    it.each([
        ['https://evil.com', 'absolute URL'],
        ['//evil.com', 'protocol-relative host'],
        ['/a/../b', 'traversal'],
        ['/\\evil.com', 'backslash a browser may normalize to a slash'],
        ['\\\\evil.com', 'backslash pair'],
        ['/..//evil.com', 'traversal ahead of a host'],
        ['/./../evil', 'traversal spelled with a dot segment'],
        ['javascript:alert(1)', 'a javascript URL'],
        ['/javascript:x', 'protocol prefix in the first segment'],
        ['/a\r\nLocation: https://evil.com', 'raw CR/LF'],
        [' //evil.com', 'leading space ahead of a host'],
        ['/\t/evil.com', 'tab a URL parser strips, leaving //evil.com'],
        ['http:/evil.com', 'single-slash absolute URL'],
        ['/evil.com:443', 'host:port read as an authority'],
    ])('refuses to seal a returnUrl that leaves the app: %j (%s)', async (returnUrl) =>
    {
        const { ctx, next } = await startWith(returnUrl);

        // Refused before the seal: no state to follow, and the backend is never called.
        expect(ctx.abort).toMatchObject({ status: 400, body: { __type: 'ValidationError' } });
        expect(ctx.body.state).toBeUndefined();
        expect(next).not.toHaveBeenCalled();
        // Nothing to put in a cookie either: the response interceptor sets the
        // pending-session cookie off this, and a refusal never runs it anyway.
        expect(ctx.metadata.pendingSession).toBeUndefined();
        expect(ctx.metadata.oauthCsrf).toBeUndefined();
    });

    /**
     * The body is JSON from the browser, so `returnUrl` is not a string just
     * because the backend route's schema says it is — the schema runs one hop
     * later. Refused here, rather than thrown out of the rule as a 500.
     */
    it.each<[unknown, string]>([
        [123, 'a number'],
        [{}, 'an object'],
        [[], 'an array'],
        [true, 'a boolean'],
    ])('refuses a non-string returnUrl: %j (%s)', async (returnUrl) =>
    {
        const { ctx, next } = await startWith(returnUrl);

        expect(ctx.abort).toMatchObject({ status: 400, body: { __type: 'ValidationError' } });
        expect(ctx.body.state).toBeUndefined();
        expect(next).not.toHaveBeenCalled();
    });

    it.each<[string | undefined | null, string]>([
        [undefined, 'absent'],
        [null, 'null'],
        ['', 'empty'],
    ])('seals the app root when returnUrl is %j (%s)', async (returnUrl) =>
    {
        const { ctx, next } = await startWith(returnUrl);

        expect(ctx.abort).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
        expect((await verifyOAuthState(ctx.body.state)).returnUrl).toBe('/');
    });

    /**
     * The refusal is a response body, so what matters to a caller is the error it
     * restores to. The typed client deserializes by `__type` through the core
     * registry (packages/core/src/nextjs/client/helpers.ts), which is why the
     * abort body carries that field rather than only the envelope.
     */
    it('the refusal restores to a ValidationError in the typed client', async () =>
    {
        const { ctx } = await startWith('https://evil.com');
        const restored = errorRegistry.deserialize(ctx.abort!.body as { __type: string });

        expect(restored).toBeInstanceOf(ValidationError);
        expect(restored).toMatchObject({ statusCode: 400, message: expect.stringContaining('returnUrl') });
        expect(ctx.abort!.status).toBe(400);
    });

    it('seals a safe returnUrl and lets the request through', async () =>
    {
        const ctx = {
            path: '/_auth/oauth/google/url',
            body: { returnUrl: '/dashboard' },
            metadata: {},
        } as unknown as RequestInterceptorContext;
        const next = vi.fn(async () => undefined);

        await oauthUrlInterceptor.request?.(ctx, next);

        expect(ctx.abort).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
        expect((await verifyOAuthState(ctx.body.state)).returnUrl).toBe('/dashboard');
    });

    it('pending session should preserve key info for finalization', async () =>
    {
        const pendingData: PendingSessionData = {
            privateKey: 'private-key-pem-content',
            keyId: 'matched-key-id',
            algorithm: 'ES256',
        };

        const sealed = await sealPendingSession(pendingData);
        const unsealed = await unsealPendingSession(sealed);

        // These values are used to create the final session
        expect(unsealed.privateKey).toBe(pendingData.privateKey);
        expect(unsealed.keyId).toBe(pendingData.keyId);
        expect(unsealed.algorithm).toBe(pendingData.algorithm);
    });
});

describe('OAuth Provider Registry', () =>
{
    // 회귀 방어: side-effect import가 tree-shake되거나 wiring이 깨지면 이 테스트가 실패한다.
    it('auto-registers all built-in providers on module load', () =>
    {
        const registered = getRegisteredProviders().map(provider => provider.id);

        expect(registered).toEqual(expect.arrayContaining(['google', 'apple', 'kakao', 'naver']));
    });

    it('register/get round-trips a custom provider', () =>
    {
        const provider = mockProvider('github');
        registerOAuthProvider(provider);

        expect(getOAuthProvider('github')).toBe(provider);
        expect(getRegisteredProviders().map(p => p.id)).toContain('github');
    });

    it('re-registering the same id overrides the previous provider', () =>
    {
        const first = mockProvider('kakao');
        const second = mockProvider('kakao');

        registerOAuthProvider(first);
        registerOAuthProvider(second);

        expect(getOAuthProvider('kakao')).toBe(second);
    });

    it('returns undefined for an unregistered provider', () =>
    {
        expect(getOAuthProvider('superself')).toBeUndefined();
    });
});

describe('oauthStartService - provider resolution', () =>
{
    const baseParams = {
        returnUrl: '/dashboard',
        publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...',
        keyId: 'key-uuid-123',
        fingerprint: 'abc123',
        algorithm: 'ES256' as const,
    };

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-with-at-least-32-characters-for-security-testing');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('throws "Unsupported OAuth provider" for an unregistered provider', async () =>
    {
        await expect(
            oauthStartService({ provider: 'superself', ...baseParams }),
        ).rejects.toThrow(/Unsupported OAuth provider/);
    });

    it('throws "registered but not configured" for a disabled provider', async () =>
    {
        registerOAuthProvider(mockProvider('naver', false));

        await expect(
            oauthStartService({ provider: 'naver', ...baseParams }),
        ).rejects.toThrow(/registered but not configured/);
    });

    it('returns an authUrl from a registered enabled provider', async () =>
    {
        registerOAuthProvider(mockProvider('github', true));

        const result = await oauthStartService({ provider: 'github', ...baseParams });

        expect(result.authUrl).toContain('https://mock.example.com/github/auth?state=');
    });
});
