/**
 * @spfn/auth - AS metadata and the boot check (design #93 v2, case table 8f)
 *
 * The rows of 8f this package owns: the authorization server metadata document,
 * and the issuers the boot check refuses. The protected-resource document and
 * the `/mcp` challenge are `@spfn/mcp`'s (PR B).
 *
 * The boot rows call the check directly with a configuration rather than
 * starting a server, which is what it is for — `createAuthLifecycle` resolves
 * the config synchronously and `afterInfrastructure` calls this, so a refusal
 * here is a process that exits before it ever listens. The reduction to an
 * origin happens one step earlier, at `configureAuthorizationServer`, so the row
 * that reads the metadata document reads it without asserting anything first.
 *
 * The last two tests are not rows. They are the opt-in: an application that
 * passes no `authorizationServer` must boot exactly as it did before this
 * feature existed, and must serve none of these endpoints.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    configureTestAuthorizationServer,
    mountAuthApp,
    resetMemoryRateLimitStore,
    TEST_SCOPES,
} from '../helpers/oauth2';
import {
    assertAuthorizationServerIssuer,
    configureAuthorizationServer,
} from '@/server/lib/oauth2/config';

const dbAvailable = await isDatabaseAvailable();

const { initializeAuth } = await import('@/server/services/rbac.service');

const METADATA_PATH = '/.well-known/oauth-authorization-server';

interface Metadata
{
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    revocation_endpoint: string;
    response_types_supported: string[];
    grant_types_supported: string[];
    token_endpoint_auth_methods_supported: string[];
    code_challenge_methods_supported: string[];
    scopes_supported: string[];
}

describe.skipIf(!dbAvailable)('OAuth2 metadata and boot check (8f)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        // Leave the module-level config as the other suites expect to find it:
        // one fork runs every file.
        configureAuthorizationServer(undefined);
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        configureTestAuthorizationServer();
    });

    it('GET /.well-known/oauth-authorization-server → 200 with every field of §4, endpoints absolute', async () =>
    {
        const response = await app.request(METADATA_PATH);
        const document = await response.json() as Metadata;

        expect(response.status).toBe(200);
        expect(document).toEqual({
            issuer: 'https://api.example.com',
            authorization_endpoint: 'https://app.example.com/oauth/authorize',
            token_endpoint: 'https://api.example.com/_auth/oauth2/token',
            registration_endpoint: 'https://api.example.com/_auth/oauth2/register',
            revocation_endpoint: 'https://api.example.com/_auth/oauth2/revoke',
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['none'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: Object.keys(TEST_SCOPES),
        });

        // The one endpoint that is deliberately somewhere else: the consent
        // screen needs the session cookie, and that lives on the web app.
        expect(new URL(document.authorization_endpoint).origin)
            .not.toBe(new URL(document.issuer).origin);
    });

    it('an issuer carrying a path → boot refused, message names the source', () =>
    {
        configureAuthorizationServer({ issuer: 'https://api.example.com/auth', scopes: TEST_SCOPES });

        expect(() => assertAuthorizationServerIssuer())
            .toThrow(/authorizationServer\.issuer must be an origin with no path/);
    });

    it('an issuer from SPFN_API_URL carrying a path → boot refused, message names the variable', () =>
    {
        configureAuthorizationServer({ scopes: TEST_SCOPES }, { SPFN_API_URL: 'https://api.example.com/auth' });

        expect(() => assertAuthorizationServerIssuer())
            .toThrow(/SPFN_API_URL must be an origin with no path/);
    });

    it('an issuer written with a trailing slash → the document publishes the origin, with no boot check', async () =>
    {
        configureTestAuthorizationServer({ issuer: 'https://api.example.com/' });

        // Read before anything asserts: the reduction happens where the config is
        // resolved, so a harness that mounts the router without the lifecycle
        // hook publishes the same document a booted server does.
        const document = await (await app.request(METADATA_PATH)).json() as Metadata;

        // `@spfn/mcp` derives `authorization_servers` with `URL.origin`, which
        // never carries the slash. RFC 8414 §3.3 has a client compare the two.
        expect(document.issuer).toBe('https://api.example.com');
        expect(document.token_endpoint).toBe('https://api.example.com/_auth/oauth2/token');
        expect(() => assertAuthorizationServerIssuer()).not.toThrow();
    });

    it('an issuer whose path is percent-encoded dot segments → boot refused', () =>
    {
        // `new URL` resolves `%2e%2e` away, so the parsed pathname is `/` and a
        // check reading it has nothing to refuse. The rule is written on the raw
        // string instead: an origin, or that origin with a trailing slash, and
        // nothing else is reduced or accepted.
        configureAuthorizationServer({ issuer: 'https://api.example.com/%2e%2e', scopes: TEST_SCOPES });

        expect(() => assertAuthorizationServerIssuer())
            .toThrow(/authorizationServer\.issuer must be an origin with no path/);
    });

    it('an issuer carrying credentials → boot refused, message names the source', () =>
    {
        configureAuthorizationServer({ issuer: 'https://u:p@api.example.com', scopes: TEST_SCOPES });

        expect(() => assertAuthorizationServerIssuer())
            .toThrow(/authorizationServer\.issuer must not carry a username or a password/);
    });

    it('an issuer that is neither https nor loopback http → boot refused', () =>
    {
        configureAuthorizationServer({ scopes: TEST_SCOPES }, { SPFN_API_URL: 'http://api.example.com' });

        expect(() => assertAuthorizationServerIssuer()).toThrow(/SPFN_API_URL must be https/);
    });

    it('http on localhost, 127.0.0.1 and [::1] → boot proceeds, for development', () =>
    {
        for (const issuer of ['http://localhost:8790', 'http://127.0.0.1:8790', 'http://[::1]:8790'])
        {
            configureAuthorizationServer({ scopes: TEST_SCOPES }, { SPFN_API_URL: issuer });

            expect(() => assertAuthorizationServerIssuer()).not.toThrow();
        }
    });

    it('no authorizationServer at all → the boot check is silent', () =>
    {
        configureAuthorizationServer(undefined, { SPFN_API_URL: 'ftp://nonsense/with/a/path' });

        expect(() => assertAuthorizationServerIssuer()).not.toThrow();
    });

    it('no authorizationServer at all → every oauth2 endpoint answers 404', async () =>
    {
        configureAuthorizationServer(undefined);

        const metadata = await app.request(METADATA_PATH);
        const register = await app.request('/_auth/oauth2/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_name: 'nobody', redirect_uris: ['http://127.0.0.1:1/cb'] }),
        });
        const token = await app.request('/_auth/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=refresh_token&refresh_token=x&client_id=y',
        });

        expect([metadata.status, register.status, token.status]).toEqual([404, 404, 404]);
    });
});
