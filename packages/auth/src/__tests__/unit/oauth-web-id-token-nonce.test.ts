/**
 * @spfn/auth - The web code exchange refuses an id_token issued to another flow
 * (PR #314 review, F5)
 *
 * Google and Kakao bind `oauthFlowNonce(state)` into the authorization URL and
 * check it on the id_token their token endpoint returns. Without these rows,
 * dropping that check — or comparing against the wrong value — goes unnoticed:
 * an id_token from another sign-in would be accepted with this flow's code.
 *
 * The harness of oauth-native.test.ts: id_tokens signed with a real RS256 key,
 * only jose's remote JWKS lookup replaced; the token endpoint is a stubbed fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPair, SignJWT, createRemoteJWKSet } from 'jose';

vi.mock('jose', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('jose')>();

    return { ...actual, createRemoteJWKSet: vi.fn() };
});

import { getOAuthProvider } from '../../server/lib/oauth';
import { oauthFlowNonce } from '../../server/lib/oauth/state';

const STATE = 'sealed-state-of-this-flow';

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeEach(async () =>
{
    ({ privateKey, publicKey } = await generateKeyPair('RS256'));
    // The resolver is cached per JWKS URI, so it reads the current key, not the first one.
    vi.mocked(createRemoteJWKSet).mockReturnValue((async () => publicKey) as never);

    vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'google-web-client');
    vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_SECRET', 'google-web-secret');
    vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', 'https://app.example/_auth/oauth/google/callback');
    vi.stubEnv('SPFN_AUTH_KAKAO_CLIENT_ID', 'kakao-rest-key');
    vi.stubEnv('SPFN_AUTH_KAKAO_REDIRECT_URI', 'https://app.example/_auth/oauth/kakao/callback');
});

afterEach(() =>
{
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

async function idToken(issuer: string, audience: string, nonce: string): Promise<string>
{
    return await new SignJWT({ nonce })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject('subject-1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
}

/** The provider's token endpoint, answering with this id_token beside the tokens. */
function tokenEndpointAnswers(token: string): void
{
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        access_token: 'access',
        token_type: 'bearer',
        expires_in: 3600,
        id_token: token,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

describe('the web exchange checks the id_token nonce against the flow', () =>
{
    it.each([
        ['google', 'https://accounts.google.com', 'google-web-client'],
        ['kakao', 'https://kauth.kakao.com', 'kakao-rest-key'],
    ] as const)('%s: an id_token carrying another flow\'s nonce is refused', async (provider, issuer, audience) =>
    {
        tokenEndpointAnswers(await idToken(issuer, audience, oauthFlowNonce('another-flow-state')));

        await expect(getOAuthProvider(provider)!.exchangeCodeForTokens('code', { state: STATE, codeVerifier: 'v' }))
            .rejects.toThrow('id_token nonce mismatch');
    });

    it.each([
        ['google', 'https://accounts.google.com', 'google-web-client'],
        ['kakao', 'https://kauth.kakao.com', 'kakao-rest-key'],
    ] as const)('%s: the same id_token with this flow\'s nonce is accepted', async (provider, issuer, audience) =>
    {
        tokenEndpointAnswers(await idToken(issuer, audience, oauthFlowNonce(STATE)));

        await expect(getOAuthProvider(provider)!.exchangeCodeForTokens('code', { state: STATE, codeVerifier: 'v' }))
            .resolves.toMatchObject({ accessToken: 'access' });
    });
});
