/**
 * @spfn/auth - the grant is the one authority over an MCP client (au6, bundle 10)
 *
 * What a client may do now is decided by its grant: a token's own scopes are
 * only the ceiling it was issued with, revoking a grant is final, a grant ends
 * on its own after `grantLifetimeMs`, and a code is spent only by a request that
 * passed every check. Each row enters where a client does — the token endpoint,
 * the consent and disconnect routes, and `/mcp` as `createMcpRoute` serves it
 * with `verifyAccessToken` as its validator — and asserts what a copy of the
 * grant's state would have let through.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { registerRoutes } from '@spfn/core/route';
import { createMcpRoute } from '@spfn/mcp/server';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    configureTestAuthorizationServer,
    createTestUser,
    mountAuthApp,
    obtainCode,
    pkcePair,
    postToken,
    registerLoopbackClient,
    resetMemoryRateLimitStore,
    signIn,
    TEST_REDIRECT_URI,
    TEST_RESOURCE,
} from '../helpers/oauth2';
import { oauth2AuthorizationCodes, oauth2Grants } from '@/server/entities';
import { configureAuthorizationServer } from '@/server/lib/oauth2/config';
import { hashOAuth2Secret } from '@/server/lib/oauth2/tokens';
import { __resetSecondFactorPolicyForTests, configureSecondFactor } from '@/server/lib/second-factor-policy';
import { oauth2TokensRepository } from '@/server/repositories/oauth2-tokens.repository';
import { verifyAccessToken } from '@/server/services/oauth2-access-token.service';

const dbAvailable = await isDatabaseAvailable();

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

/** Names unique to this file: one fork runs every suite. */
const EMAIL = 'grant-authority@test.com';
const NAME = 'grant-authority-cli';

interface TokenBody
{
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error?: string;
}

describe.skipIf(!dbAvailable)('OAuth2 grant authority (au6)', () =>
{
    let app: Hono;
    let authorization: string;
    let clientId: string;

    /** The scopes `/mcp` handed the application, one entry per admitted request. */
    const admittedScopes: string[][] = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        app = await mountAuthApp();

        registerRoutes(app, createMcpRoute({
            appUrl: 'https://api.example.com',
            serverInfo: { name: 'grant-authority', version: '1.0.0' },
            validateToken: verifyAccessToken,
            resolveContext: async (auth) =>
            {
                admittedScopes.push(auth.scopes);

                return {};
            },
            listTools: () => [],
        }));
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
        configureTestAuthorizationServer();
        admittedScopes.length = 0;

        await createTestUser(EMAIL, (await getRoleByName('user'))!.id);
        authorization = await signIn(app, EMAIL);
        clientId = await registerLoopbackClient(app, NAME, [TEST_REDIRECT_URI]);
    });

    afterEach(() =>
    {
        __resetSecondFactorPolicyForTests();
    });

    /** Consent with `scope` and answer with the code and the verifier that spends it. */
    async function consent(seed: string, scope?: string): Promise<{ code: string; verifier: string }>
    {
        const { verifier, challenge } = pkcePair(seed);

        return { code: await obtainCode(app, authorization, { client_id: clientId, scope }, challenge), verifier };
    }

    /** The exchange a well-behaved client sends, with any field overridden. */
    async function exchange(
        issued: { code: string; verifier: string },
        overrides: Record<string, string> = {},
    ): Promise<{ status: number; body: TokenBody }>
    {
        const response = await postToken(app, {
            grant_type: 'authorization_code',
            code: issued.code,
            code_verifier: issued.verifier,
            client_id: clientId,
            redirect_uri: TEST_REDIRECT_URI,
            resource: TEST_RESOURCE,
            ...overrides,
        });

        return { status: response.status, body: await response.json() as TokenBody };
    }

    /** Connect end to end and answer with the token pair. */
    async function connect(seed: string, scope?: string): Promise<TokenBody>
    {
        const { status, body } = await exchange(await consent(seed, scope));

        expect(status).toBe(200);

        return body;
    }

    async function refresh(refreshToken: string, scope?: string): Promise<{ status: number; body: TokenBody }>
    {
        const response = await postToken(app, {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            ...(scope ? { scope } : {}),
        });

        return { status: response.status, body: await response.json() as TokenBody };
    }

    /** One request to `/mcp` with a bearer token, as an MCP client sends it. */
    async function callMcp(accessToken: string): Promise<Response>
    {
        return await app.request('/mcp', {
            method: 'POST',
            headers: {
                authorization: `Bearer ${accessToken}`,
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
                'mcp-method': 'server/discover',
                'mcp-protocol-version': '2026-07-28',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: {
                    _meta: {
                        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                        'io.modelcontextprotocol/clientCapabilities': {},
                        'io.modelcontextprotocol/clientInfo': { name: 'grant-authority', version: '1.0.0' },
                    },
                },
            }),
        });
    }

    /** Age every grant to 181 days, as the default 180-day lifetime wrote it: one day past its end. */
    async function lapseGrants(): Promise<void>
    {
        await getTestDb()
            .update(oauth2Grants)
            .set({
                createdAt: sql`now() - interval '181 days'`,
                expiresAt: sql`now() - interval '1 day'`,
            });
    }

    async function grants()
    {
        return await getTestDb().select().from(oauth2Grants).orderBy(oauth2Grants.id);
    }

    it('T1: re-consent with fewer scopes → the earlier tokens carry only what the grant still holds', async () =>
    {
        const wide = await connect('wide', 'mcp:read mcp:write');

        await consent('narrow', 'mcp:read');

        const call = await callMcp(wide.access_token!);

        expect(call.status).toBe(200);
        expect(admittedScopes).toEqual([['mcp:read']]);

        const renewed = await refresh(wide.refresh_token!);

        expect(renewed.status).toBe(200);
        expect(renewed.body.scope).toBe('mcp:read');
    });

    it('T2: an exchange with a wrong resource → refused with the code unspent; the corrected retry succeeds', async () =>
    {
        const issued = await consent('resource');
        const wrong = await exchange(issued, { resource: 'https://api.example.com/other' });

        expect(wrong.status).toBe(400);
        expect(wrong.body.error).toBe('invalid_target');

        const [code] = await getTestDb()
            .select()
            .from(oauth2AuthorizationCodes)
            .where(eq(oauth2AuthorizationCodes.codeHash, hashOAuth2Secret(issued.code)));

        expect(code!.usedAt).toBeNull();

        const retry = await exchange(issued);

        expect(retry.status).toBe(200);
        expect((await grants()).every(grant => grant.revokedAt === null)).toBe(true);
    });

    it('T3: one code presented twice, one after the other or at once → the grant is revoked either way', async () =>
    {
        const sequential = await consent('sequential');

        expect((await exchange(sequential)).status).toBe(200);
        expect((await exchange(sequential)).status).toBe(400);
        expect((await grants()).every(grant => grant.revokedAt !== null)).toBe(true);

        // Each round reconnects, which is a new grant: the last one was revoked.
        for (const round of [1, 2, 3])
        {
            const concurrent = await consent(`concurrent-${round}`);
            const answers = await Promise.all([exchange(concurrent), exchange(concurrent)]);

            expect(answers.map(answer => answer.status).sort()).toEqual([200, 400]);
            expect((await grants()).every(grant => grant.revokedAt !== null)).toBe(true);
        }
    });

    it('T4: disconnect, then reconnect → a new grant; the earlier code, access and refresh token stay refused', async () =>
    {
        const before = await connect('before');
        const pendingCode = await consent('pending');
        const [grant] = await grants();

        const disconnected = await app.request(`/_auth/oauth2/grants/${grant!.id}`, {
            method: 'DELETE',
            headers: { Authorization: authorization },
        });

        expect(disconnected.status).toBe(200);

        await consent('after');

        const rows = await grants();

        expect(rows).toHaveLength(2);
        expect(rows[0]!.revokedAt).not.toBeNull();
        expect(rows[1]!.revokedAt).toBeNull();

        expect((await exchange(pendingCode)).status).toBe(400);
        expect((await refresh(before.refresh_token!)).status).toBe(400);
        expect((await callMcp(before.access_token!)).status).toBe(401);
    });

    it('T5: a refresh on a grant past its absolute lifetime → refused', async () =>
    {
        const issued = await connect('lifetime');

        await lapseGrants();

        const renewed = await refresh(issued.refresh_token!);

        expect(renewed.status).toBe(400);
        expect(renewed.body.error).toBe('invalid_grant');
    });

    it('T6: a database error while verifying → /mcp answers 5xx, not 401', async () =>
    {
        const issued = await connect('outage');
        const lookup = vi.spyOn(oauth2TokensRepository, 'findByTokenHash')
            .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

        const call = await callMcp(issued.access_token!);

        lookup.mockRestore();

        expect(call.status).toBeGreaterThanOrEqual(500);
        expect(call.headers.get('www-authenticate')).toBeNull();
    });

    it('T7: a grant created 181 days ago → not listed, not verified; the next consent is a new grant, the old one revoked', async () =>
    {
        const issued = await connect('lapsed');

        await lapseGrants();

        const listed = await app.request('/_auth/oauth2/grants', { headers: { Authorization: authorization } });

        expect(listed.status).toBe(200);
        expect((await listed.json() as { grants: unknown[] }).grants).toEqual([]);

        expect(await verifyAccessToken(issued.access_token!, TEST_RESOURCE)).toBeNull();
        expect((await callMcp(issued.access_token!)).status).toBe(401);

        await consent('reconsent');

        const rows = await grants();

        expect(rows).toHaveLength(2);
        expect(rows[0]!.revokedAt).not.toBeNull();
        expect(rows[1]!.revokedAt).toBeNull();
        expect(rows[1]!.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('T8: no authorization server configured → /mcp with any bearer answers 401, not 5xx', async () =>
    {
        const issued = await connect('unconfigured');

        configureAuthorizationServer(undefined);

        for (const bearer of [issued.access_token!, 'not-a-token-this-server-could-have-issued'])
        {
            const call = await callMcp(bearer);

            expect(call.status).toBe(401);
            expect(call.headers.get('www-authenticate')).toContain('invalid_token');
        }
    });

    it('T9: a valid token whose person may only enrol a second factor → /mcp answers 403 SECOND_FACTOR_ENROLMENT_REQUIRED, not 401', async () =>
    {
        const issued = await connect('enrolment-only');

        configureSecondFactor({ required: true, methods: ['passkey'], recoveryCodes: false });

        const call = await callMcp(issued.access_token!);
        const text = await call.text();

        expect(call.status, text).toBe(403);
        expect(JSON.parse(text)).toMatchObject({ code: 'SECOND_FACTOR_ENROLMENT_REQUIRED' });
        expect(admittedScopes).toEqual([]);
    });

    it('T10: a grant whose expires_at is now → not listed, not verified, not disconnectable', async () =>
    {
        const issued = await connect('boundary');
        const boundary = new Date(Date.now() + 1_000);

        await getTestDb().update(oauth2Grants).set({ expiresAt: boundary });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(boundary);

        try
        {
            const listed = await app.request('/_auth/oauth2/grants', { headers: { Authorization: authorization } });

            expect(listed.status).toBe(200);
            expect((await listed.json() as { grants: unknown[] }).grants).toEqual([]);
            expect(await verifyAccessToken(issued.access_token!, TEST_RESOURCE)).toBeNull();

            const [grant] = await grants();
            const disconnected = await app.request(`/_auth/oauth2/grants/${grant!.id}`, {
                method: 'DELETE',
                headers: { Authorization: authorization },
            });

            expect(disconnected.status).toBe(404);
        }
        finally
        {
            vi.useRealTimers();
        }
    });

    it('T11: grantLifetimeMs raised after a grant lapsed → the grant stays ended', async () =>
    {
        const issued = await connect('raised');

        await lapseGrants();
        configureTestAuthorizationServer({ grantLifetimeMs: 365 * 24 * 60 * 60 * 1000 });

        const listed = await app.request('/_auth/oauth2/grants', { headers: { Authorization: authorization } });

        expect((await listed.json() as { grants: unknown[] }).grants).toEqual([]);
        expect(await verifyAccessToken(issued.access_token!, TEST_RESOURCE)).toBeNull();
        expect((await refresh(issued.refresh_token!)).body.error).toBe('invalid_grant');
    });

    /**
     * The rule: a token's ceiling is fixed when it is issued, at the effective
     * scopes of the token it replaced. A refresh while the grant is narrowed
     * issues a pair whose ceiling is the narrowed set, and widening the grant
     * later does not lift it — the chain gets the removed scopes back only from
     * a new authorization. (A token not rotated while the grant was narrowed
     * kept its original ceiling and follows the grant back up: T1's reading.)
     */
    it('T12: grant narrowed between two refreshes, then widened → the chain never regains what the narrowing removed', async () =>
    {
        const wide = await connect('regain', 'mcp:read mcp:write');

        await consent('regain-narrow', 'mcp:read');

        const narrowed = await refresh(wide.refresh_token!);

        expect(narrowed.body.scope).toBe('mcp:read');

        await consent('regain-widen', 'mcp:read mcp:write');

        const after = await refresh(narrowed.body.refresh_token!);

        expect(after.status).toBe(200);
        expect(after.body.scope).toBe('mcp:read');
        expect((await callMcp(after.body.access_token!)).status).toBe(200);
        expect(admittedScopes).toEqual([['mcp:read']]);

        const asked = await refresh(after.body.refresh_token!, 'mcp:read mcp:write');

        expect(asked.status).toBe(400);
        expect(asked.body.error).toBe('invalid_scope');
    });

    it('T13: nothing left in common with the grant, refreshed with an explicit scope the grant holds → refused invalid_grant', async () =>
    {
        const writeOnly = await connect('disjoint', 'mcp:write');

        await consent('disjoint-narrow', 'mcp:read');

        const asked = await refresh(writeOnly.refresh_token!, 'mcp:read');

        expect(asked.status).toBe(400);
        expect(asked.body.error).toBe('invalid_grant');
        expect(asked.body.access_token).toBeUndefined();
    });
});
