/**
 * @spfn/auth - OAuth 2.1 token endpoint, refresh_token (design #93 v2, case table 8d)
 *
 * One test per row of 8d. Rotation is the shape of the whole table: every
 * successful refresh issues a new pair and marks the presented one `replacedAt`,
 * and presenting a marked one again is a leak — so it revokes the grant, which
 * kills the replacement the rotation issued as well as the token that was
 * replayed. The row for `회전됨` asserts both halves, because revoking only the
 * replayed one would leave whoever stole it holding a live pair.
 *
 * The scope rows are the other half: a refresh may narrow, never widen, and
 * narrowing leaves the user's consent record exactly as they gave it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

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
import { oauth2Grants, oauth2Tokens } from '@/server/entities';
import { hashOAuth2Secret } from '@/server/lib/oauth2/tokens';
import { verifyAccessToken } from '@/server/services/oauth2-access-token.service';

const dbAvailable = await isDatabaseAvailable();

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

/** Names unique to this file: one fork runs every suite. */
const EMAIL = 'token-refresh@test.com';
const NAME = 'token-refresh-cli';

interface TokenBody
{
    error?: string;
    access_token?: string;
    refresh_token?: string;
    scope?: string;
}

describe.skipIf(!dbAvailable)('OAuth2 token, refresh_token (8d)', () =>
{
    let app: Hono;
    let clientId: string;
    let userId: number;
    let refreshToken: string;
    let accessToken: string;

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
        configureTestAuthorizationServer();

        userId = await createTestUser(EMAIL, (await getRoleByName('user'))!.id);

        const authorization = await signIn(app, EMAIL);

        clientId = await registerLoopbackClient(app, NAME, [TEST_REDIRECT_URI]);

        const { verifier, challenge } = pkcePair('refresh');
        const code = await obtainCode(app, authorization, { client_id: clientId }, challenge);
        const issued = await postToken(app, {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: TEST_REDIRECT_URI,
            resource: TEST_RESOURCE,
        });
        const body = await issued.json() as TokenBody;

        refreshToken = body.refresh_token!;
        accessToken = body.access_token!;
    });

    /** The refresh a well-behaved client sends, with one field per row varied. */
    async function refresh(overrides: Record<string, string> = {})
    {
        const response = await postToken(app, {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            ...overrides,
        });

        return { response, body: await response.json() as TokenBody };
    }

    /** The row the presented refresh token is stored in. */
    async function refreshRow(token: string)
    {
        const rows = await getTestDb()
            .select()
            .from(oauth2Tokens)
            .where(eq(oauth2Tokens.tokenHash, hashOAuth2Secret(token)));

        return rows[0] ?? null;
    }

    it('a live refresh token → 200 with a new access and refresh, the old one marked replacedAt', async () =>
    {
        const { response, body } = await refresh();

        expect(response.status).toBe(200);
        expect(body.access_token).not.toBe(accessToken);
        expect(body.refresh_token).not.toBe(refreshToken);
        expect((await refreshRow(refreshToken))!.replacedAt).not.toBeNull();
        expect((await refreshRow(body.refresh_token!))!.replacedAt).toBeNull();
    });

    it('a live refresh token asking for a scope wider than the grant → 400 invalid_scope', async () =>
    {
        const { response, body } = await refresh({ scope: 'mcp:read mcp:write mcp:admin mcp:everything' });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_scope');

        // Refused without spending the token: a client asking for too much must
        // be able to ask again for what it may have.
        expect((await refreshRow(refreshToken))!.replacedAt).toBeNull();
    });

    /**
     * Not a row of its own, but the reading of the narrow row that matters: the
     * narrowing is per request, so the chain can come back up to the grant.
     */
    it('a refresh narrowed once may ask for the full granted set again', async () =>
    {
        const narrowed = await refresh({ scope: 'mcp:read' });

        expect(narrowed.response.status).toBe(200);

        refreshToken = narrowed.body.refresh_token!;

        const widened = await refresh({ scope: 'mcp:read mcp:write mcp:admin' });

        expect(widened.response.status).toBe(200);
        expect(widened.body.scope).toBe('mcp:read mcp:write mcp:admin');
    });

    it('a live refresh token asking for a subset → 200 narrowed, and the grant unchanged', async () =>
    {
        const { response, body } = await refresh({ scope: 'mcp:read' });

        expect(response.status).toBe(200);
        expect(body.scope).toBe('mcp:read');
        expect((await verifyAccessToken(body.access_token!, TEST_RESOURCE))!.scopes).toEqual(['mcp:read']);

        const grants = await getTestDb().select().from(oauth2Grants).where(eq(oauth2Grants.user, userId));

        expect(grants[0]!.scopes).toEqual(['mcp:read', 'mcp:write', 'mcp:admin']);
    });

    it('a live refresh token with no resource → 200, and the grant resource is what applies', async () =>
    {
        const { response, body } = await refresh();

        expect(response.status).toBe(200);
        expect(await verifyAccessToken(body.access_token!, TEST_RESOURCE)).not.toBeNull();
    });

    it('a live refresh token naming a different resource → 400 invalid_target', async () =>
    {
        const { response, body } = await refresh({ resource: 'https://api.example.com/elsewhere' });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_target');
    });

    it('a rotated refresh token presented again → 400 invalid_grant, and the grant is revoked', async () =>
    {
        const rotated = await refresh();

        expect(rotated.response.status).toBe(200);

        const replay = await refresh();

        expect(replay.response.status).toBe(400);
        expect(replay.body.error).toBe('invalid_grant');

        // Both pairs are dead: the replayed one AND the one the rotation issued,
        // because there is no telling which of the two holders is the thief.
        expect(await verifyAccessToken(rotated.body.access_token!, TEST_RESOURCE)).toBeNull();

        refreshToken = rotated.body.refresh_token!;

        const successor = await refresh();

        expect(successor.response.status).toBe(400);
        expect(successor.body.error).toBe('invalid_grant');
    });

    it('an expired refresh token → 400 invalid_grant', async () =>
    {
        await getTestDb()
            .update(oauth2Tokens)
            .set({ expiresAt: sql`now() - interval '1 second'` })
            .where(eq(oauth2Tokens.tokenHash, hashOAuth2Secret(refreshToken)));

        const { response, body } = await refresh();

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });

    it('a refresh token whose grant was revoked → 400 invalid_grant', async () =>
    {
        await getTestDb()
            .update(oauth2Grants)
            .set({ revokedAt: sql`now()` })
            .where(eq(oauth2Grants.user, userId));

        const { response, body } = await refresh();

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });

    it('a refresh token that was never issued → 400 invalid_grant', async () =>
    {
        const { response, body } = await refresh({ refresh_token: `spfn_rt_${'a'.repeat(64)}` });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });

    it('a live refresh token presented under another client_id → 400 invalid_grant', async () =>
    {
        const other = await registerLoopbackClient(app, `${NAME}-other`, [TEST_REDIRECT_URI]);
        const { response, body } = await refresh({ client_id: other });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });
});
