/**
 * @spfn/auth - OAuth 2.1 revocation (design #93 v2, §3 and RFC 7009)
 *
 * The design gives this endpoint one line — "알 수 없는 토큰도 200" — and every
 * answer it gives is that same 200 with an empty body. So no test here asserts a
 * response: what each one asserts is the state left behind, which is the only
 * place the endpoint's behaviour is visible.
 *
 * Two of those states are the point. A refresh token takes its grant and every
 * token under it; an access token goes alone, because a client discarding one it
 * has finished with is not disconnecting. And a `client_id` that is not the
 * token's revokes nothing at all: the endpoint has no client authentication to
 * lean on, so the id cannot protect a token from whoever holds it — what it
 * stops is one client tearing down another's connection with a value it came
 * across.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    configureTestAuthorizationServer,
    createTestUser,
    FORM_HEADERS,
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
const EMAIL = 'revoke@test.com';
const NAME = 'revoke-cli';

describe.skipIf(!dbAvailable)('OAuth2 revoke (RFC 7009)', () =>
{
    let app: Hono;
    let clientId: string;
    let userId: number;
    let accessToken: string;
    let refreshToken: string;

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

        const { verifier, challenge } = pkcePair('revoke');
        const code = await obtainCode(app, authorization, { client_id: clientId }, challenge);
        const issued = await postToken(app, {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: TEST_REDIRECT_URI,
            resource: TEST_RESOURCE,
        });
        const body = await issued.json() as { access_token: string; refresh_token: string };

        accessToken = body.access_token;
        refreshToken = body.refresh_token;
    });

    /** POST /_auth/oauth2/revoke, form-encoded as RFC 7009 §2.1 requires. */
    async function revoke(fields: Record<string, string>): Promise<Response>
    {
        return await app.request('/_auth/oauth2/revoke', {
            method: 'POST',
            headers: FORM_HEADERS,
            body: new URLSearchParams(fields).toString(),
        });
    }

    /** Whether the grant this suite's tokens hang off is still live. */
    async function grantIsLive(): Promise<boolean>
    {
        const grants = await getTestDb().select().from(oauth2Grants).where(eq(oauth2Grants.user, userId));

        return grants.every(grant => grant.revokedAt === null);
    }

    /** Whether the refresh token row is still live. */
    async function refreshIsLive(): Promise<boolean>
    {
        const rows = await getTestDb()
            .select()
            .from(oauth2Tokens)
            .where(eq(oauth2Tokens.tokenHash, hashOAuth2Secret(refreshToken)));

        return rows[0]?.revokedAt === null;
    }

    it('an access token → 200, that token dead and the grant left standing', async () =>
    {
        const response = await revoke({ token: accessToken, client_id: clientId });

        expect(response.status).toBe(200);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).toBeNull();
        expect(await grantIsLive()).toBe(true);
        expect(await refreshIsLive()).toBe(true);
    });

    it('a refresh token → 200, the grant and every token under it dead', async () =>
    {
        const response = await revoke({ token: refreshToken, client_id: clientId });

        expect(response.status).toBe(200);
        expect(await grantIsLive()).toBe(false);
        expect(await refreshIsLive()).toBe(false);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).toBeNull();
    });

    it('a token that was never issued → 200, and nothing is revoked', async () =>
    {
        const response = await revoke({ token: `spfn_rt_${'a'.repeat(64)}`, client_id: clientId });

        expect(response.status).toBe(200);
        expect(await grantIsLive()).toBe(true);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).not.toBeNull();
    });

    it('a client_id that is not the token\'s → 200, and nothing is revoked', async () =>
    {
        const other = await registerLoopbackClient(app, `${NAME}-other`, [TEST_REDIRECT_URI]);
        const response = await revoke({ token: refreshToken, client_id: other });

        // The same 200 an unknown token gets: a caller must not learn from this
        // endpoint whether the value it presented belongs to somebody.
        expect(response.status).toBe(200);
        expect(await grantIsLive()).toBe(true);
        expect(await refreshIsLive()).toBe(true);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).not.toBeNull();
    });

    it('no client_id at all → 200, and the token is revoked', async () =>
    {
        const response = await revoke({ token: accessToken });

        expect(response.status).toBe(200);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).toBeNull();
    });
});
