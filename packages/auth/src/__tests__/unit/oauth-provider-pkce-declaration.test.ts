/**
 * @spfn/auth - A provider declares PKCE, or it is not registered (PR #314 review, F4)
 *
 * `pkce` used to be optional, and a provider that left it out was registered
 * and treated as doing S256. An app in plain JavaScript, or built against that
 * type, could register a provider that never sent `code_verifier` and find out
 * only from a provider that enforces it — or never, from one that does not.
 * Without these rows, dropping the check at registration goes unnoticed.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
    buildAuthorizationUrl,
    exchangeCodeVerifier,
    getOAuthProvider,
    registerOAuthProvider,
    type OAuthProvider,
} from '@/server/lib/oauth';
import { githubProvider } from '@/server/lib/oauth/github-provider';

/** A custom provider's shape, minus the declaration under test. */
function customProvider(pkce: unknown): OAuthProvider
{
    return {
        id: 'github',
        isEnabled: () => true,
        getAuthUrl: (state: string) => `https://idp.example/authorize?state=${state}`,
        exchangeCodeForTokens: async () => ({ accessToken: 'a', expiresIn: 60 }),
        getUserInfo: async () => ({ providerUserId: 'u', email: null, emailVerified: false }),
        ...(pkce === undefined ? {} : { pkce }),
    } as OAuthProvider;
}

describe('registerOAuthProvider and the pkce declaration', () =>
{
    afterEach(() =>
    {
        registerOAuthProvider(githubProvider);
    });

    it('refuses a provider that declares no pkce, naming it, and keeps the one registered before', () =>
    {
        expect(() => registerOAuthProvider(customProvider(undefined)))
            .toThrow("OAuth provider 'github' declares no valid pkce");
        expect(getOAuthProvider('github')).toBe(githubProvider);
    });

    it.each([
        ['an unknown method', 'plain'],
        ['unsupported without a reason', { unsupported: true }],
        ['unsupported with a blank reason', { unsupported: true, reason: ' ' }],
        ['unsupported: false', { unsupported: false, reason: 'no' }],
    ])('refuses %s', (_case, pkce) =>
    {
        expect(() => registerOAuthProvider(customProvider(pkce))).toThrow("'github' declares no valid pkce");
    });

    it.each([
        ['S256', 'S256'],
        ['a stated inability', { unsupported: true, reason: 'the provider takes no code_challenge' }],
    ])('accepts %s', (_case, pkce) =>
    {
        const provider = customProvider(pkce);

        registerOAuthProvider(provider);

        expect(getOAuthProvider('github')).toBe(provider);
    });

    it('keeps the declaration it validated when the app reassigns pkce afterwards', () =>
    {
        const provider = customProvider('S256');
        registerOAuthProvider(provider);

        (provider as { pkce: unknown }).pkce = 'none';

        const url = new URL(buildAuthorizationUrl(provider, 'state', 'verifier'));
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('code_challenge')).toBeTruthy();
        expect(exchangeCodeVerifier(provider, 'verifier')).toBe('verifier');
    });
});
