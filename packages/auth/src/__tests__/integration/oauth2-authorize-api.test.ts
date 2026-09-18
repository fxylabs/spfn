/**
 * @spfn/auth - OAuth 2.1 authorize, API side (design #93 v2, case table 8b)
 *
 * 8b's rows describe the whole consent flow, web page included. This file owns
 * the ones the API decides: which client, which redirect URI, whether PKCE and
 * `resource` are there, which scopes, and what approving or refusing produces.
 * The rows about the session redirect, `isSafeReturnPath`, the response headers
 * and the form CSRF token belong to the web handler and ship with it (PR C).
 *
 * The rows whose outcome column reads "302 error=..." are the API half of that
 * 302: this endpoint answers the web handler, not the browser, so what it owes
 * is the refusal carrying the error code AND the vetted redirect URI the handler
 * builds the 302 from. That split is the security property — a refusal with no
 * vetted URI (unknown client, mismatched redirect_uri) must produce a screen and
 * never a redirect, which is what "400 화면, 리다이렉트 없음" means here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    configureTestAuthorizationServer,
    createTestUser,
    decideAuthorize,
    describeAuthorize,
    mountAuthApp,
    pkcePair,
    registerLoopbackClient,
    resetMemoryRateLimitStore,
    signIn,
    TEST_RESOURCE,
} from '../helpers/oauth2';
import { oauth2GrantsRepository } from '@/server/repositories';

const dbAvailable = await isDatabaseAvailable();

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

/** Names unique to this file: one fork runs every suite. */
const EMAIL = 'authorize-api@test.com';
const NAME = 'authorize-api-cli';

/** The SPFN error envelope, as the web consent handler reads it. */
interface Envelope
{
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
    details?: Record<string, unknown>;
}

/** `details.error` wherever the envelope carries it. */
function refusalOf(body: Envelope): Record<string, unknown>
{
    return (body.error?.details ?? body.details ?? {}) as Record<string, unknown>;
}

describe.skipIf(!dbAvailable)('OAuth2 authorize, API side (8b)', () =>
{
    let app: Hono;
    let authorization: string;
    let userId: number;
    let clientId: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        configureTestAuthorizationServer({ defaultScopes: ['mcp:read'] });

        userId = await createTestUser(EMAIL, (await getRoleByName('user'))!.id);
        authorization = await signIn(app, EMAIL);
        clientId = await registerLoopbackClient(app, NAME, ['http://127.0.0.1:7777/callback']);
    });

    /** Register a client whose redirect list is exactly what a row is about. */
    async function clientWith(uris: string[], suffix: string): Promise<string>
    {
        return await registerLoopbackClient(app, `${NAME}-${suffix}`, uris);
    }

    it('signed in, unregistered client_id → screen error, no redirect', async () =>
    {
        const response = await describeAuthorize(app, authorization, { client_id: 'spfn_client_nope' });
        const body = await response.json() as Envelope;

        expect(response.status).toBe(400);
        expect(refusalOf(body).error).toBe('unknown_client');
        expect(refusalOf(body).redirectUri).toBeUndefined();
    });

    it('signed in, redirect_uri whose host does not match the registration → screen error, no redirect', async () =>
    {
        const response = await describeAuthorize(app, authorization, {
            client_id: clientId,
            redirect_uri: 'http://198.51.100.9:7777/callback',
        });
        const body = await response.json() as Envelope;

        expect(response.status).toBe(400);
        expect(refusalOf(body).error).toBe('redirect_uri_mismatch');
        expect(refusalOf(body).redirectUri).toBeUndefined();
    });

    it('signed in, 127.0.0.1 registered and localhost requested → screen error, no redirect', async () =>
    {
        const only127 = await clientWith(['http://127.0.0.1:7777/cb'], 'only127');
        const response = await describeAuthorize(app, authorization, {
            client_id: only127,
            redirect_uri: 'http://localhost:7777/cb',
        });

        expect(response.status).toBe(400);
        expect(refusalOf(await response.json() as Envelope).error).toBe('redirect_uri_mismatch');
    });

    it('signed in, localhost registered and [::1] requested → screen error, no redirect', async () =>
    {
        const onlyLocalhost = await clientWith(['http://localhost:7777/cb'], 'onlyLocalhost');
        const response = await describeAuthorize(app, authorization, {
            client_id: onlyLocalhost,
            redirect_uri: 'http://[::1]:7777/cb',
        });

        expect(response.status).toBe(400);
        expect(refusalOf(await response.json() as Envelope).error).toBe('redirect_uri_mismatch');
    });

    it('signed in, [::1] registered and 127.0.0.1 requested → screen error, no redirect', async () =>
    {
        const onlyV6 = await clientWith(['http://[::1]:7777/cb'], 'onlyV6');
        const response = await describeAuthorize(app, authorization, {
            client_id: onlyV6,
            redirect_uri: 'http://127.0.0.1:7777/cb',
        });

        expect(response.status).toBe(400);
        expect(refusalOf(await response.json() as Envelope).error).toBe('redirect_uri_mismatch');
    });

    it('signed in, loopback with the same port and a different path → screen error, no redirect', async () =>
    {
        const response = await describeAuthorize(app, authorization, {
            client_id: clientId,
            redirect_uri: 'http://127.0.0.1:7777/somewhere-else',
        });

        expect(response.status).toBe(400);
        expect(refusalOf(await response.json() as Envelope).error).toBe('redirect_uri_mismatch');
    });

    it('signed in, [::1] registered and [0:0:0:0:0:0:0:1] requested → normalised, match, consent screen', async () =>
    {
        const onlyV6 = await clientWith(['http://[::1]:7777/cb'], 'v6norm');
        const response = await describeAuthorize(app, authorization, {
            client_id: onlyV6,
            redirect_uri: 'http://[0:0:0:0:0:0:0:1]:7777/cb',
        });

        expect(response.status).toBe(200);
        expect((await response.json() as { redirectHost: string }).redirectHost).toBe('[::1]:7777');
    });

    it('signed in, loopback differing only in port → consent screen', async () =>
    {
        const response = await describeAuthorize(app, authorization, {
            client_id: clientId,
            redirect_uri: 'http://127.0.0.1:61234/callback',
        });

        expect(response.status).toBe(200);
    });

    it('signed in, no code_challenge_method → invalid_request on the registered redirect URI', async () =>
    {
        const response = await describeAuthorize(app, authorization, { client_id: clientId, omitPkce: true });
        const refusal = refusalOf(await response.json() as Envelope);

        expect(response.status).toBe(400);
        expect(refusal.error).toBe('invalid_request');
        expect(refusal.redirectUri).toBe('http://127.0.0.1:7777/callback');
    });

    it('signed in, code_challenge_method=plain → invalid_request on the registered redirect URI', async () =>
    {
        const response = await describeAuthorize(app, authorization, {
            client_id: clientId,
            code_challenge_method: 'plain',
        });
        const refusal = refusalOf(await response.json() as Envelope);

        expect(response.status).toBe(400);
        expect(refusal.error).toBe('invalid_request');
        expect(refusal.redirectUri).toBe('http://127.0.0.1:7777/callback');
    });

    it('signed in, a code_challenge that is not 43 base64url characters → invalid_request', async () =>
    {
        // The verifier in the challenge field is what a client sends when it
        // means `plain` and says S256, and it is the wrong length for S256.
        const response = await describeAuthorize(app, authorization, {
            client_id: clientId,
            code_challenge: pkcePair('short').verifier,
        });
        const refusal = refusalOf(await response.json() as Envelope);

        expect(response.status).toBe(400);
        expect(refusal.error).toBe('invalid_request');
        expect(refusal.redirectUri).toBe('http://127.0.0.1:7777/callback');
    });

    it('signed in, a redirect_uri reaching the registered path through ".." → screen error, no redirect', async () =>
    {
        const registered = await clientWith(['http://127.0.0.1/cb'], 'dotsegment');
        const response = await describeAuthorize(app, authorization, {
            client_id: registered,
            redirect_uri: 'http://127.0.0.1:5/x/../cb',
        });

        // `new URL(...).pathname` is `/cb` for both, and the port may vary on
        // loopback — so without the raw-path rule this is a match.
        expect(response.status).toBe(400);
        expect(refusalOf(await response.json() as Envelope).error).toBe('redirect_uri_mismatch');
    });

    it('signed in, no resource → invalid_target on the registered redirect URI', async () =>
    {
        const response = await describeAuthorize(app, authorization, {
            client_id: clientId,
            omitResource: true,
        });
        const refusal = refusalOf(await response.json() as Envelope);

        expect(response.status).toBe(400);
        expect(refusal.error).toBe('invalid_target');
        expect(refusal.redirectUri).toBe('http://127.0.0.1:7777/callback');
    });

    it('signed in, no scope → consent screen showing the default scope set', async () =>
    {
        const response = await describeAuthorize(app, authorization, { client_id: clientId });
        const view = await response.json() as { scopes: { name: string; description: string }[] };

        expect(response.status).toBe(200);
        expect(view.scopes).toEqual([{ name: 'mcp:read', description: 'Read your projects' }]);
    });

    it('signed in, a scope the configuration does not describe → invalid_scope', async () =>
    {
        const response = await describeAuthorize(app, authorization, {
            client_id: clientId,
            scope: 'mcp:read mcp:teleport',
        });
        const refusal = refusalOf(await response.json() as Envelope);

        expect(response.status).toBe(400);
        expect(refusal.error).toBe('invalid_scope');
        expect(refusal.redirectUri).toBe('http://127.0.0.1:7777/callback');
    });

    it('signed in, POST approve → a code, and the state echoed back verbatim', async () =>
    {
        const { challenge } = pkcePair('approve');
        const response = await decideAuthorize(app, authorization, {
            client_id: clientId,
            state: 'opaque state with spaces & symbols',
            approve: true,
        }, challenge);
        const issued = await response.json() as { code: string; redirectUri: string; state?: string };

        expect(response.status).toBe(200);
        expect(issued.code).toHaveLength(43);
        expect(issued.redirectUri).toBe('http://127.0.0.1:7777/callback');
        expect(issued.state).toBe('opaque state with spaces & symbols');
    });

    it('signed in, POST approve with no state → a code and no state', async () =>
    {
        const response = await decideAuthorize(app, authorization, {
            client_id: clientId,
            approve: true,
        }, pkcePair('nostate').challenge);
        const issued = await response.json() as { code: string; state?: string };

        expect(response.status).toBe(200);
        expect(issued.code).toHaveLength(43);
        expect(issued.state).toBeUndefined();
    });

    it('signed in, POST deny → access_denied on the registered redirect URI, with the state', async () =>
    {
        const response = await decideAuthorize(app, authorization, {
            client_id: clientId,
            state: 'deny-state',
            approve: false,
        });
        const refusal = refusalOf(await response.json() as Envelope);

        expect(response.status).toBe(400);
        expect(refusal.error).toBe('access_denied');
        expect(refusal.redirectUri).toBe('http://127.0.0.1:7777/callback');
        expect(refusal.state).toBe('deny-state');
    });

    it('signed in, POST deny on a malformed request → the validation error, not access_denied', async () =>
    {
        const response = await decideAuthorize(app, authorization, {
            client_id: clientId,
            code_challenge_method: 'plain',
            state: 'deny-state',
            approve: false,
        });
        const refusal = refusalOf(await response.json() as Envelope);

        // A request that never asked properly was not refused by the user, and
        // telling the waiting client it was would be telling it something false.
        expect(response.status).toBe(400);
        expect(refusal.error).toBe('invalid_request');
    });

    it('an existing grant re-approved with wider scopes → one grant, scopes updated', async () =>
    {
        await decideAuthorize(app, authorization, {
            client_id: clientId,
            scope: 'mcp:read',
            approve: true,
        }, pkcePair('narrow').challenge);

        await decideAuthorize(app, authorization, {
            client_id: clientId,
            scope: 'mcp:read mcp:write',
            approve: true,
        }, pkcePair('wide').challenge);

        const grants = await oauth2GrantsRepository.listActiveByUserId(userId);

        expect(grants).toHaveLength(1);
        expect(grants[0]!.grant.scopes).toEqual(['mcp:read', 'mcp:write']);
        expect(grants[0]!.grant.resource).toBe(TEST_RESOURCE);
    });
});
