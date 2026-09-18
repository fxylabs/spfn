/**
 * @spfn/auth - verifyAccessToken (design #93 v2, case table 8e)
 *
 * One test per row of 8e, less the three `/mcp` rows — those live in `@spfn/mcp`
 * (PR B), which owns the 401 challenge and the `createMcpRoute` wiring.
 *
 * `verifyAccessToken` is what an MCP server calls on every request, so the table
 * is almost entirely about refusals, and every one of them is the same `null`.
 * Four of the rows are not about the token at all: they are global revocations —
 * revoke-all, a password change, a completed password reset, a deletion request
 * — and what they assert is that the grant beneath the token dies with
 * everything else the account was signing out. A CLI holding a refresh token
 * through a "sign me out everywhere" would otherwise be back within the hour.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    configureTestAuthorizationServer,
    createTestUser,
    JSON_HEADERS,
    mountAuthApp,
    obtainCode,
    pkcePair,
    postToken,
    registerLoopbackClient,
    resetMemoryRateLimitStore,
    signIn,
    TEST_PASSWORD,
    TEST_REDIRECT_URI,
    TEST_RESOURCE,
} from '../helpers/oauth2';
import { oauth2Grants, oauth2Tokens } from '@/server/entities';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { hashOAuth2Secret, toEpochSeconds } from '@/server/lib/oauth2/tokens';
import { verifyAccessToken } from '@/server/services/oauth2-access-token.service';

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: (...args: unknown[]) => sendEmail(...args) };
});

const dbAvailable = await isDatabaseAvailable();

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

/** Names unique to this file: one fork runs every suite. */
const EMAIL = 'verify-access@test.com';
const NAME = 'verify-access-cli';
const NEW_PASSWORD = 'AnotherPassword456!';

describe.skipIf(!dbAvailable)('verifyAccessToken (8e)', () =>
{
    let app: Hono;
    let authorization: string;
    let userId: number;
    let clientId: string;
    let accessToken: string;
    let refreshToken: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_APP_URL = 'https://app.example.com';
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
        sendEmail.mockClear();
        await initializeAuth();
        configureTestAuthorizationServer();

        userId = await createTestUser(EMAIL, (await getRoleByName('user'))!.id);
        authorization = await signIn(app, EMAIL);
        clientId = await registerLoopbackClient(app, NAME, [TEST_REDIRECT_URI]);

        const { verifier, challenge } = pkcePair('verify');
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

    /** An authenticated POST from the signed-in account. */
    async function post(path: string, body: Record<string, unknown>): Promise<Response>
    {
        return await app.request(path, {
            method: 'POST',
            headers: { ...JSON_HEADERS, Authorization: authorization },
            body: JSON.stringify(body),
        });
    }

    it('a live access token against its own resource → the principal', async () =>
    {
        const principal = await verifyAccessToken(accessToken, TEST_RESOURCE);

        expect(principal).toEqual({
            clientId,
            scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
            expiresAt: expect.any(Number),
            userId: String(userId),
        });

        // Seconds since the epoch, not milliseconds: the row stores a timestamp
        // and `expires_in` counts seconds remaining, and one helper each keeps
        // the three units from drifting apart.
        const row = (await getTestDb()
            .select()
            .from(oauth2Tokens)
            .where(eq(oauth2Tokens.tokenHash, hashOAuth2Secret(accessToken))))[0]!;

        expect(principal!.expiresAt).toBe(toEpochSeconds(row.expiresAt));
    });

    it('a live access token against a different resource → null', async () =>
    {
        expect(await verifyAccessToken(accessToken, 'https://api.example.com/other')).toBeNull();
    });

    it('an expired access token → null', async () =>
    {
        await getTestDb()
            .update(oauth2Tokens)
            .set({ expiresAt: sql`now() - interval '1 second'` })
            .where(eq(oauth2Tokens.tokenHash, hashOAuth2Secret(accessToken)));

        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).toBeNull();
    });

    it('after DELETE /_auth/oauth2/grants/:id → null', async () =>
    {
        const grants = await getTestDb().select().from(oauth2Grants).where(eq(oauth2Grants.user, userId));
        const response = await app.request(`/_auth/oauth2/grants/${grants[0]!.id}`, {
            method: 'DELETE',
            headers: { Authorization: authorization },
        });

        expect(response.status).toBe(200);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).toBeNull();
    });

    it('after a password change → null', async () =>
    {
        const response = await app.request('/_auth/password', {
            method: 'PUT',
            headers: { ...JSON_HEADERS, Authorization: authorization },
            body: JSON.stringify({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }),
        });

        expect(response.status).toBe(204);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).toBeNull();
    });

    it('after a completed password reset → null', async () =>
    {
        expect((await app.request('/_auth/password/reset', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ email: EMAIL }),
        })).status).toBe(200);

        const confirmUrl = sendEmail.mock.calls
            .filter(([arg]) => arg?.template === 'password-reset')
            .at(-1)![0].data.confirmUrl as string;
        const confirmed = await app.request('/_auth/password/reset/confirm', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ token: new URL(confirmUrl).searchParams.get('token') }),
        });
        const { setupSecret } = await confirmed.json() as { setupSecret: string };
        const key = generateKeyPair('ES256');

        const completed = await app.request('/_auth/password/reset/complete', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                setupSecret,
                password: NEW_PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });

        expect(completed.status).toBe(200);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).toBeNull();
    });

    it('after POST /_auth/keys/revoke-all → null', async () =>
    {
        expect((await post('/_auth/keys/revoke-all', { includeCurrent: true })).status).toBe(200);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).toBeNull();
    });

    it('after an account deletion request → null', async () =>
    {
        expect((await post('/_auth/deletion/request', { password: TEST_PASSWORD })).status).toBe(200);
        expect(await verifyAccessToken(accessToken, TEST_RESOURCE)).toBeNull();
    });

    it('a refresh token presented as a bearer credential → null', async () =>
    {
        expect(await verifyAccessToken(refreshToken, TEST_RESOURCE)).toBeNull();
    });

    it('an ops token, a JWT and the empty string → null', async () =>
    {
        const key = generateKeyPair('ES256');
        const jwt = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });

        expect(await verifyAccessToken(`spfn_ops_${'a'.repeat(64)}`, TEST_RESOURCE)).toBeNull();
        expect(await verifyAccessToken(jwt, TEST_RESOURCE)).toBeNull();
        expect(await verifyAccessToken('', TEST_RESOURCE)).toBeNull();
    });
});
