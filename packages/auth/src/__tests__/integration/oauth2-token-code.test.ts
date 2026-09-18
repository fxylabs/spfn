/**
 * @spfn/auth - OAuth 2.1 token endpoint, authorization_code (design #93 v2, case table 8c)
 *
 * One test per row of 8c. Every refusal but `invalid_target` is the same
 * `invalid_grant` with the same description, and that sameness is the property
 * under test: a caller holding a stolen code must not be able to tell it apart
 * from a caller holding a value that was never issued.
 *
 * Three rows carry more than a status. The concurrent pair is a real
 * `Promise.all` against Postgres, and it passes only because the code is spent
 * by the statement that reads it. The reuse row asserts that the tokens the
 * first exchange produced are dead afterwards, which is what revoking the grant
 * is for. Its mirror — a replay whose bindings do NOT match — asserts the
 * opposite, and it is the one that says the revocation is a consequence of the
 * real client presenting its code twice rather than of anyone presenting it at
 * all.
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
import { oauth2AuthorizationCodes, oauth2Grants, oauth2Tokens } from '@/server/entities';
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

    it('a fresh code with a mismatched code_verifier → 400 invalid_grant, the code still spendable', async () =>
    {
        const code = await freshCode();
        const refused = await exchange({ code_verifier: pkcePair('wrong').verifier }, code);

        expect(refused.response.status).toBe(400);
        expect(refused.body.error).toBe('invalid_grant');

        // The refusal proved nothing about who sent it, so it costs the real
        // client nothing: the code is still there and the grant is still live.
        const retry = await exchange({}, code);

        expect(retry.response.status).toBe(200);
        expect(await verifyAccessToken(retry.body.access_token!, TEST_RESOURCE)).not.toBeNull();
    });

    it('a fresh code with the verifier sent as a plain challenge → 400 invalid_grant', async () =>
    {
        // What a `plain`-method client sends: the challenge itself, unhashed.
        const { response, body } = await exchange({ code_verifier: challenge });

        expect(response.status).toBe(400);
        expect(body.error).toBe('invalid_grant');
    });

    it('a code_verifier outside RFC 7636\'s 43 to 128 characters → 400 invalid_grant', async () =>
    {
        for (const outOfBounds of ['too-short-for-rfc-7636', 'a'.repeat(129)])
        {
            const { response, body } = await exchange({ code_verifier: outOfBounds });

            expect(response.status).toBe(400);
            expect(body.error).toBe('invalid_grant');
        }
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

        const grants = await getTestDb().select().from(oauth2Grants);

        expect(grants.every(grant => grant.revokedAt !== null)).toBe(true);
    });

    it('a spent code replayed with a wrong verifier, another client or another redirect_uri → 400 invalid_grant, and the grant survives', async () =>
    {
        const code = await freshCode();
        const issued = await exchange({}, code);

        expect(issued.response.status).toBe(200);

        const other = await registerLoopbackClient(app, `${NAME}-replayer`, [TEST_REDIRECT_URI]);

        const replays: Record<string, string>[] = [
            { code_verifier: pkcePair('wrong').verifier },
            { client_id: other },
            { redirect_uri: 'http://127.0.0.1:7777/elsewhere' },
        ];

        for (const overrides of replays)
        {
            const replay = await exchange(overrides, code);

            expect(replay.response.status).toBe(400);
            expect(replay.body.error).toBe('invalid_grant');
        }

        // None of the three showed it was the client this code was issued to,
        // so none of them may take that client's connection down with it.
        expect(await verifyAccessToken(issued.body.access_token!, TEST_RESOURCE)).not.toBeNull();

        const grants = await getTestDb().select().from(oauth2Grants);

        expect(grants.every(grant => grant.revokedAt === null)).toBe(true);
    });

    it('two requests presenting one code at the same time → exactly one 200, and its tokens live', async () =>
    {
        const code = await freshCode();
        const [left, right] = await Promise.all([exchange({}, code), exchange({}, code)]);
        const statuses = [left.response.status, right.response.status].sort();

        expect(statuses).toEqual([200, 400]);

        // The loser is a client retrying a request it thought had timed out,
        // not a thief: the winner keeps the pair it was just handed.
        const winner = left.response.status === 200 ? left : right;

        expect(await verifyAccessToken(winner.body.access_token!, TEST_RESOURCE)).not.toBeNull();
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
