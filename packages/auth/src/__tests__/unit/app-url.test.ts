/**
 * The web app URL: one resolution, no localhost default.
 *
 * `SPFN_APP_URL` is declared by `@spfn/core` and `NEXT_PUBLIC_SPFN_APP_URL` by
 * this package; everything here that builds a URL on the app reads them through
 * `resolveAppUrl`, which refuses — naming both — when neither is set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAppUrl } from '@/server/lib/app-url';
import { buildConfirmUrl } from '@/server/lib/link-credentials';
import { configureAuthorizationServer, getAuthorizationServerConfig } from '@/server/lib/oauth2/config';

const MISSING = 'Set NEXT_PUBLIC_SPFN_APP_URL or SPFN_APP_URL';

describe('resolveAppUrl', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_APP_URL', '');
        vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', '');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('reads SPFN_APP_URL through @spfn/core', () =>
    {
        vi.stubEnv('SPFN_APP_URL', 'https://app.example.com');

        expect(resolveAppUrl()).toBe('https://app.example.com');
    });

    it('prefers NEXT_PUBLIC_SPFN_APP_URL over SPFN_APP_URL', () =>
    {
        vi.stubEnv('SPFN_APP_URL', 'http://internal.example.com');
        vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', 'https://app.example.com');

        expect(resolveAppUrl()).toBe('https://app.example.com');
    });

    it('refuses, naming both variables, when neither is set — no localhost default', () =>
    {
        expect(() => resolveAppUrl()).toThrow(MISSING);
    });

    it('reads a given source instead of the environment', () =>
    {
        vi.stubEnv('SPFN_APP_URL', 'https://ignored.example.com');

        expect(resolveAppUrl({ SPFN_APP_URL: 'https://app.example.com' })).toBe('https://app.example.com');
        expect(() => resolveAppUrl({})).toThrow(MISSING);
    });
});

describe('readers of the app URL', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_APP_URL', '');
        vi.stubEnv('NEXT_PUBLIC_SPFN_APP_URL', '');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        configureAuthorizationServer(undefined);
    });

    it('an emailed link is built on the app URL, without a doubled slash', () =>
    {
        vi.stubEnv('SPFN_APP_URL', 'https://app.example.com/');

        expect(buildConfirmUrl('/password/reset', 'a b')).toBe('https://app.example.com/password/reset?token=a%20b');
    });

    it('an emailed link is refused rather than built relative when no app URL is set', () =>
    {
        expect(() => buildConfirmUrl('/password/reset', 'token')).toThrow(MISSING);
    });

    it('the OAuth 2.1 consent screen defaults to the app URL', () =>
    {
        configureAuthorizationServer(
            { scopes: { read: 'Read' } },
            { SPFN_API_URL: 'https://api.example.com', SPFN_APP_URL: 'https://app.example.com' },
        );

        expect(getAuthorizationServerConfig()?.authorizeUrl).toBe('https://app.example.com/oauth/authorize');
    });

    it('the OAuth 2.1 consent screen has no localhost default', () =>
    {
        expect(() => configureAuthorizationServer({ scopes: { read: 'Read' } }, { SPFN_API_URL: 'https://api.example.com' }))
            .toThrow(MISSING);
    });

    it('an explicit authorizeUrl needs no app URL', () =>
    {
        configureAuthorizationServer(
            { scopes: { read: 'Read' }, authorizeUrl: 'https://consent.example.com/authorize' },
            { SPFN_API_URL: 'https://api.example.com' },
        );

        expect(getAuthorizationServerConfig()?.authorizeUrl).toBe('https://consent.example.com/authorize');
    });
});
