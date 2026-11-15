/**
 * @spfn/auth - An authorization code is bound to the flow that asked for it (au5-A5)
 *
 * T3: for every built-in provider that does PKCE, an authorization code issued
 * to one sign-in attempt and injected into another attempt's callback — that
 * attempt's own state and CSRF cookie — is refused at the code exchange.
 *
 * The real provider modules run; `fetch` is a fake provider. Its authorize step
 * is the start's `authUrl`: the code it issues remembers the `code_challenge`
 * that URL carried, and its token endpoint refuses a `code_verifier` whose S256
 * hash is not that challenge, as RFC 7636 §4.6 has a provider do. A code issued
 * without a challenge is exchanged with any verifier, which is what a provider
 * does for a flow that never sent one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import { generateKeyPair } from '@/server/lib/crypto';
import { registerOAuthProvider } from '@/server/lib/oauth';
import { googleProvider } from '@/server/lib/oauth/google-provider';
import { githubProvider } from '@/server/lib/oauth/github-provider';
import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { battlenetProvider } from '@/server/lib/oauth/battlenet-provider';

const { initializeAuth } = await import('@/server/services/rbac.service');

const dbAvailable = await isDatabaseAvailable();

const APP_URL = 'http://localhost:3000';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;

/** Each provider's token endpoint, and the userinfo answer for an identity id. */
const FAKE_ENDPOINTS: Record<string, { token: string; userInfo: Record<string, (id: string) => unknown> }> = {
    google: {
        token: 'https://oauth2.googleapis.com/token',
        userInfo: {
            'https://www.googleapis.com/oauth2/v2/userinfo': id => ({ id, email: `${id}@pkce.test`, verified_email: false }),
        },
    },
    github: {
        token: 'https://github.com/login/oauth/access_token',
        userInfo: {
            'https://api.github.com/user': id => ({ id, login: id }),
            'https://api.github.com/user/emails': () => [],
        },
    },
    kakao: {
        token: 'https://kauth.kakao.com/oauth/token',
        userInfo: { 'https://kapi.kakao.com/v2/user/me': id => ({ id, kakao_account: {} }) },
    },
    battlenet: {
        token: 'https://oauth.battle.net/token',
        userInfo: { 'https://oauth.battle.net/userinfo': id => ({ sub: id, battletag: `${id}#1234` }) },
    },
};

const PKCE_PROVIDERS = ['google', 'github', 'kakao', 'battlenet'] as const;

/** A sign-in attempt as the browser holds it after the provider sent it back. */
interface Attempt
{
    state: string;
    cookie: string;
    code: string;
}

describe.skipIf(!dbAvailable)('PKCE binds every code-flow sign-in (T3, au5-A5)', () =>
{
    let app: Hono;
    let ipCounter = 0;
    /** What the fake provider remembers about each code it issued. */
    const issued = new Map<string, { challenge: string | null; identity: string }>();

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        [googleProvider, githubProvider, kakaoProvider, battlenetProvider].forEach(registerOAuthProvider);
        stubProviderEnv();
        issued.clear();
        vi.stubGlobal('fetch', vi.fn(fakeProvider));
    });

    afterEach(() =>
    {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    function stubProviderEnv(): void
    {
        vi.stubEnv('SPFN_APP_URL', APP_URL);
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'google-client');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'google-secret');
        vi.stubEnv('SPFN_AUTH_GITHUB_CLIENT_ID', 'github-client');
        vi.stubEnv('SPFN_AUTH_GITHUB_CLIENT_SECRET', 'github-secret');
        vi.stubEnv('SPFN_AUTH_KAKAO_CLIENT_ID', 'kakao-client');
        vi.stubEnv('SPFN_AUTH_BATTLENET_CLIENT_ID', 'bnet-client');
        vi.stubEnv('SPFN_AUTH_BATTLENET_CLIENT_SECRET', 'bnet-secret');
        vi.stubEnv('SPFN_AUTH_BATTLENET_REGION', '');
    }

    // ========================================================================
    // The fake provider
    // ========================================================================

    async function fakeProvider(input: string | URL | Request, init?: RequestInit): Promise<Response>
    {
        const url = String(input);
        const endpoints = Object.values(FAKE_ENDPOINTS);

        if (endpoints.some(endpoint => endpoint.token === url))
        {
            return exchange(new URLSearchParams(String(init?.body)));
        }

        const userInfo = endpoints.map(endpoint => endpoint.userInfo[url]).find(Boolean);
        const authorization = new Headers(init?.headers).get('authorization') ?? '';

        return userInfo
            ? Response.json(userInfo(authorization.replace('Bearer at-', '')))
            : new Response('not found', { status: 404 });
    }

    /** The token endpoint: a code issued to a challenge is exchanged only with that challenge's verifier. */
    function exchange(body: URLSearchParams): Response
    {
        const grant = issued.get(body.get('code') ?? '');
        const verifier = body.get('code_verifier');
        const verified = grant?.challenge === null
            || (verifier !== null && createHash('sha256').update(verifier).digest('base64url') === grant?.challenge);

        if (!grant || !verified)
        {
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }

        return Response.json({ access_token: `at-${grant.identity}`, token_type: 'bearer', expires_in: 3600 });
    }

    // ========================================================================
    // Driving the router
    // ========================================================================

    /** Start a sign-in through the API start route; the provider's code comes back for `identity`. */
    async function attempt(provider: string, identity: string): Promise<Attempt>
    {
        const key = generateKeyPair('ES256');
        ipCounter += 1;
        const response = await app.request('/_auth/oauth/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `198.51.100.${ipCounter % 250 + 1}` },
            body: JSON.stringify({
                provider,
                returnUrl: '/',
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });

        expect(response.status).toBe(200);

        const authUrl = new URL((await response.json()).authUrl as string);
        const code = `code-${provider}-${identity}`;
        issued.set(code, { challenge: authUrl.searchParams.get('code_challenge'), identity });

        return {
            state: authUrl.searchParams.get('state')!,
            cookie: response.headers.get('set-cookie')!.split(';')[0]!,
            code,
        };
    }

    async function callback(provider: string, state: string, code: string, cookie: string): Promise<URL>
    {
        const response = await app.request(`/_auth/oauth/${provider}/callback?${new URLSearchParams({ code, state })}`, {
            headers: { Cookie: cookie },
        });

        expect(response.status).toBe(302);

        return new URL(response.headers.get('location')!, APP_URL);
    }

    it.each(PKCE_PROVIDERS)('%s: a code from another sign-in attempt, injected into one\'s own callback, is refused at the exchange', async (provider) =>
    {
        const victim = await attempt(provider, 'victim');
        const attacker = await attempt(provider, 'attacker');

        const injected = await callback(provider, attacker.state, victim.code, attacker.cookie);

        expect(injected.pathname).toBe('/auth/error');
        expect(injected.searchParams.get('reason')).toBe('provider_error');

        const own = await callback(provider, attacker.state, attacker.code, attacker.cookie);

        expect(own.pathname).toBe('/auth/callback');
        expect(own.searchParams.get('userId')).toBeTruthy();
    });
});
