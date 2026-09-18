/**
 * @spfn/auth - OAuth 2.1 token endpoint, authorization_code (design #93 v2, case table 8c)
 *
 * One test per row of 8c. Every refusal but `invalid_target` is the same
 * `invalid_grant` with the same description, and that sameness is the property
 * under test: a caller holding a stolen code must not be able to tell it apart
 * from a caller holding a value that was never issued.
 *
 * Two rows carry more than a status. The concurrent pair is a real `Promise.all`
 * against Postgres, and it passes only because the code is spent by the
 * statement that reads it. The reuse row asserts that the tokens the first
 * exchange produced are dead afterwards, which is what revoking the grant is
 * for.
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
import { oauth2AuthorizationCodes, oauth2Tokens } from '@/server/entities';
import { hashOAuth2Secret } from '@/server/lib/oauth2/tokens';
import { verifyAccessToken } from '@/server/services/oauth2-access-token.service';

const dbAvailable = await isDatabaseAvailable();

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

/** Names unique to this file: one fork runs every suite. */
const EMAIL = 'token-code@test.com';
const NAME = 'token-code-cli';

interface TokenBody
{
    error?: string;
    error_description?: string;
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
}

describe.skipIf(!dbAvailable)('OAuth2 token, authorization_code (8c)', () =>
{
    let app: Hono;
    let authorization: string;
    let clientId: string;
    let verifier: string;
    let challenge: string;

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

        await createTestUser(EMAIL, (await getRoleByName('user'))!.id);
        authorization = await signIn(app, EMAIL);
        clientId = await registerLoopbackClient(app, NAME, [TEST_REDIRECT_URI]);
        ({ verifier, challenge } = pkcePair('code'));
    });

    /** Consent, and answer with the fresh code. */
    async function freshCode(scope?: string): Promise<string>
    {
        return await obtainCode(app, authorization, { client_id: clientId, scope }, challenge);
    }

    /** The exchange a well-behaved client sends, with one field per row varied. */
    async function exchange(overrides: Record<string, string> = {}, code?: string)
    {
        const response = await postToken(app, {
            grant_type: 'authorization_code',
            code: code ?? await freshCode(),
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: TEST_REDIRECT_URI,
            resource: TEST_RESOURCE,
            ...overrides,
        });

        return { response, body: await response.json() as TokenBody };
    }

    it('a fresh code with a matching verifier, client and redirect_uri → 200 with the full token response', async () =>
    {
        const { response, body } = await exchange();

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(body.access_token).toMatch(/^spfn_at_[0-9a-f]{64}$/);
        expect(body.token_type).toBe('Bearer');
        expect(body.expires_in).toBeGreaterThan(0);
        expect(body.refresh_token).toMatch(/^spfn_rt_[0-9a-f]{64}$/);
        expect(body.scope).toBe('mcp:read mcp:write mcp:admin');
    });

    it('a fresh code whose resource differs from the authorize request → 400 invalid_target', async () =>
    {
        const { response, body } = await exchange({ resource: 'https://api.example.com/other' });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_target');
    });

    it('a fresh code with no resource at all → 200, and the grant resource is what applies', async () =>
    {
        const code = await freshCode();
        const response = await postToken(app, {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: TEST_REDIRECT_URI,
        });
        const body = await response.json() as TokenBody;

        expect(response.status).toBe(200);
        expect(await verifyAccessToken(body.access_token!, TEST_RESOURCE)).not.toBeNull();
    });

    it('a fresh code with a mismatched code_verifier → 400 invalid_grant', async () =>
    {
        const { response, body } = await exchange({ code_verifier: pkcePair('wrong').verifier });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });

    it('a fresh code with the verifier sent as a plain challenge → 400 invalid_grant', async () =>
    {
        // What a `plain`-method client sends: the challenge itself, unhashed.
        const { response, body } = await exchange({ code_verifier: challenge });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });

    it('a fresh code presented by another client → 400 invalid_grant', async () =>
    {
        const other = await registerLoopbackClient(app, `${NAME}-other`, [TEST_REDIRECT_URI]);
        const { response, body } = await exchange({ client_id: other });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });

    it('a fresh code with a different redirect_uri → 400 invalid_grant', async () =>
    {
        const { response, body } = await exchange({ redirect_uri: 'http://127.0.0.1:7777/elsewhere' });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });

    it('a code older than its 60 seconds → 400 invalid_grant', async () =>
    {
        const code = await freshCode();

        // 61 seconds, written by the database so the TTL is judged by the clock
        // that stores it — the same clock the consuming statement asks.
        await getTestDb()
            .update(oauth2AuthorizationCodes)
            .set({ expiresAt: sql`now() - interval '1 second'` })
            .where(eq(oauth2AuthorizationCodes.codeHash, hashOAuth2Secret(code)));

        const { response, body } = await exchange({}, code);

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });

    it('a code presented a second time → 400 invalid_grant, and every token of that grant is revoked', async () =>
    {
        const code = await freshCode();
        const first = await exchange({}, code);

        expect(first.response.status).toBe(200);
        expect(await verifyAccessToken(first.body.access_token!, TEST_RESOURCE)).not.toBeNull();

        const second = await exchange({}, code);

        expect(second.response.status).toBe(400);
        expect(second.body.error).toBe('invalid_grant');

        // The whole point of the revocation: the tokens the FIRST exchange
        // produced are dead, because somebody else may be holding them.
        expect(await verifyAccessToken(first.body.access_token!, TEST_RESOURCE)).toBeNull();

        const revoked = await getTestDb().select().from(oauth2Tokens);

        expect(revoked.every(token => token.revokedAt !== null)).toBe(true);
    });

    it('two requests presenting one code at the same time → exactly one 200', async () =>
    {
        const code = await freshCode();
        const [left, right] = await Promise.all([exchange({}, code), exchange({}, code)]);
        const statuses = [left.response.status, right.response.status].sort();

        expect(statuses).toEqual([200, 400]);
    });

    it('a code that was never issued → 400 invalid_grant, the same answer a spent one gets', async () =>
    {
        const unknown = await exchange({}, 'this-code-was-never-issued-by-anybody-0');
        const spentCode = await freshCode();

        await exchange({}, spentCode);

        const spent = await exchange({}, spentCode);

        expect(unknown.response.status).toBe(400);
        expect(unknown.body).toEqual(spent.body);
    });
});
