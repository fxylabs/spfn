/**
 * Boot-time check of explicit OAuth redirect URI overrides.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertOAuthRedirectUris } from '@/server/lib/oauth/redirect-uri-check';
import { authLogger } from '@/server/logger';

const APP_ORIGIN = 'http://localhost:3790';
const API_ORIGIN = 'http://localhost:8790';

const REDIRECT_URI_VARS = [
    'SPFN_AUTH_GOOGLE_REDIRECT_URI',
    'SPFN_AUTH_KAKAO_REDIRECT_URI',
    'SPFN_AUTH_NAVER_REDIRECT_URI',
    'SPFN_AUTH_GITHUB_REDIRECT_URI',
    'SPFN_AUTH_APPLE_REDIRECT_URI',
];

const PROVIDERS = [
    { provider: 'google', variable: 'SPFN_AUTH_GOOGLE_REDIRECT_URI' },
    { provider: 'kakao', variable: 'SPFN_AUTH_KAKAO_REDIRECT_URI' },
    { provider: 'naver', variable: 'SPFN_AUTH_NAVER_REDIRECT_URI' },
    { provider: 'github', variable: 'SPFN_AUTH_GITHUB_REDIRECT_URI' },
    { provider: 'apple', variable: 'SPFN_AUTH_APPLE_REDIRECT_URI' },
];

describe('assertOAuthRedirectUris', () =>
{
    beforeEach(() =>
    {
        // vi.stubEnv does not clear what a previous test set: reset every variable
        // this check reads, not just the ones a given test cares about.
        vi.stubEnv('SPFN_APP_URL', APP_ORIGIN);
        vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', '');
        vi.stubEnv('SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK', '');
        for (const variable of REDIRECT_URI_VARS)
        {
            vi.stubEnv(variable, '');
        }
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('passes when no override is set', () =>
    {
        expect(() => assertOAuthRedirectUris()).not.toThrow();
    });

    it.each(PROVIDERS)('passes for $provider on the app origin at the callback path', ({ provider, variable }) =>
    {
        vi.stubEnv(variable, `${APP_ORIGIN}/_auth/oauth/${provider}/callback`);

        expect(() => assertOAuthRedirectUris()).not.toThrow();
    });

    it.each(PROVIDERS)('refuses $provider on another origin', ({ provider, variable }) =>
    {
        vi.stubEnv(variable, `${API_ORIGIN}/_auth/oauth/${provider}/callback`);

        expect(() => assertOAuthRedirectUris()).toThrow(variable);
        expect(() => assertOAuthRedirectUris()).toThrow(APP_ORIGIN);
        expect(() => assertOAuthRedirectUris()).toThrow(`/_auth/oauth/${provider}/callback`);
    });

    it('C1: refuses SPFN_AUTH_APPLE_REDIRECT_URI off the app origin (fxylabs/spfn#142)', () =>
    {
        vi.stubEnv('SPFN_APP_URL', 'https://app.example.com');
        vi.stubEnv('SPFN_AUTH_APPLE_REDIRECT_URI', 'https://other.example.com/_auth/oauth/apple/callback');

        expect(() => assertOAuthRedirectUris()).toThrow('SPFN_AUTH_APPLE_REDIRECT_URI');
    });

    it('refuses the right origin at the wrong path', () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', `${APP_ORIGIN}/_auth/oauth/google/cb`);

        expect(() => assertOAuthRedirectUris()).toThrow(/SPFN_AUTH_GOOGLE_REDIRECT_URI.*\/_auth\/oauth\/google\/callback/s);
    });

    it('refuses a scheme mismatch on an otherwise identical URL', () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', 'https://localhost:3790/_auth/oauth/google/callback');

        expect(() => assertOAuthRedirectUris()).toThrow('SPFN_AUTH_GOOGLE_REDIRECT_URI');
    });

    it('refuses a value that does not parse as a URL', () =>
    {
        vi.stubEnv('SPFN_AUTH_NAVER_REDIRECT_URI', 'not a url');

        expect(() => assertOAuthRedirectUris()).toThrow('The value is not a URL.');
    });

    it('refuses a conforming origin and path carrying a query string', () =>
    {
        vi.stubEnv('SPFN_AUTH_KAKAO_REDIRECT_URI', `${APP_ORIGIN}/_auth/oauth/kakao/callback?tenant=acme`);

        expect(() => assertOAuthRedirectUris()).toThrow('query string or fragment');
    });

    it('accepts a trailing slash only where it is the callback path itself', () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', `${APP_ORIGIN}/_auth/oauth/google/callback/`);

        expect(() => assertOAuthRedirectUris()).toThrow('SPFN_AUTH_GOOGLE_REDIRECT_URI');
    });

    it('names every offending variable in one error', () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', `${API_ORIGIN}/_auth/oauth/google/callback`);
        vi.stubEnv('SPFN_AUTH_GITHUB_REDIRECT_URI', `${API_ORIGIN}/_auth/oauth/github/callback`);

        let message = '';
        try
        {
            assertOAuthRedirectUris();
        }
        catch (error)
        {
            message = (error as Error).message;
        }

        expect(message).toContain('SPFN_AUTH_GOOGLE_REDIRECT_URI');
        expect(message).toContain('SPFN_AUTH_GITHUB_REDIRECT_URI');
    });

    it('prefers NEXT_PUBLIC_SPFN_APP_URL over SPFN_APP_URL', () =>
    {
        vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', 'https://app.example.com');
        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', 'https://app.example.com/_auth/oauth/google/callback');

        expect(() => assertOAuthRedirectUris()).not.toThrow();

        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', `${APP_ORIGIN}/_auth/oauth/google/callback`);

        expect(() => assertOAuthRedirectUris()).toThrow('https://app.example.com');
    });

    it('skips the check and logs once when the opt-out is off', () =>
    {
        const info = vi.spyOn(authLogger.service, 'info').mockImplementation(() => 
        {});
        vi.stubEnv('SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK', 'off');
        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', `${API_ORIGIN}/_auth/oauth/google/callback`);

        expect(() => assertOAuthRedirectUris()).not.toThrow();
        expect(info).toHaveBeenCalledTimes(1);
        expect(info.mock.calls[0]![0]).toContain('SPFN_AUTH_GOOGLE_REDIRECT_URI');
    });

    it.each(['false', '0', 'no', 'on', 'OFF'])('still runs the check when the opt-out is %s', (value) =>
    {
        vi.stubEnv('SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK', value);
        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', `${API_ORIGIN}/_auth/oauth/google/callback`);

        expect(() => assertOAuthRedirectUris()).toThrow('SPFN_AUTH_GOOGLE_REDIRECT_URI');
    });

    it('skips the check and logs once when the app URL does not parse', () =>
    {
        const info = vi.spyOn(authLogger.service, 'info').mockImplementation(() => 
        {});
        vi.stubEnv('SPFN_AUTH_GOOGLE_REDIRECT_URI', `${API_ORIGIN}/_auth/oauth/google/callback`);

        expect(() => assertOAuthRedirectUris({
            SPFN_APP_URL: 'not a url',
            SPFN_AUTH_GOOGLE_REDIRECT_URI: `${API_ORIGIN}/_auth/oauth/google/callback`,
        })).not.toThrow();
        expect(info).toHaveBeenCalledTimes(1);
    });

    it('compares origins rather than hand-built strings, so a default port is not a mismatch', () =>
    {
        expect(() => assertOAuthRedirectUris({
            SPFN_APP_URL: 'http://app.example.com:80',
            SPFN_AUTH_GOOGLE_REDIRECT_URI: 'http://app.example.com/_auth/oauth/google/callback',
        })).not.toThrow();
    });
});
