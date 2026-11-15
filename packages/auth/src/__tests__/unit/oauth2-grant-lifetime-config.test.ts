/**
 * `authorizationServer.grantLifetimeMs` is validated at configuration
 *
 * The lifetime decides when a grant stops being live, and every value that is
 * not a positive whole number of milliseconds means something nobody meant:
 * zero or a negative ends every grant at birth, a fraction or a string turns
 * the cutoff into NaN — which compares false against every creation time, so
 * no grant is live and none is ever revoked as lapsed either. Each is refused
 * when the application configures it, before anything is stored.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
    configureAuthorizationServer,
    getAuthorizationServerConfig,
    type AuthorizationServerOptions,
} from '@/server/lib/oauth2/config';

const OPTIONS: AuthorizationServerOptions = {
    issuer: 'https://api.example.com',
    authorizeUrl: 'https://app.example.com/oauth/authorize',
    scopes: { 'mcp:read': 'Read your projects' },
};

describe('authorizationServer.grantLifetimeMs', () =>
{
    afterEach(() =>
    {
        configureAuthorizationServer(undefined);
    });

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['non-integer', 1.5],
        ['a string', '15552000000'],
    ])('%s → a configuration error, and the refused value never installed', (_label, grantLifetimeMs) =>
    {
        configureAuthorizationServer({ ...OPTIONS, grantLifetimeMs: 60_000 });

        expect(() => configureAuthorizationServer({ ...OPTIONS, grantLifetimeMs: grantLifetimeMs as number }))
            .toThrow(/grantLifetimeMs must be a positive whole number of milliseconds/);
        expect(getAuthorizationServerConfig()!.grantLifetimeMs).toBe(60_000);
    });

    it('a positive whole number is taken as given; absent is 180 days', () =>
    {
        configureAuthorizationServer({ ...OPTIONS, grantLifetimeMs: 60_000 });

        expect(getAuthorizationServerConfig()!.grantLifetimeMs).toBe(60_000);

        configureAuthorizationServer(OPTIONS);

        expect(getAuthorizationServerConfig()!.grantLifetimeMs).toBe(180 * 24 * 60 * 60 * 1000);
    });
});
