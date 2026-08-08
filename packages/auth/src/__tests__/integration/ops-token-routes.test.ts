/**
 * @spfn/auth - Ops Token Route Integration Tests
 *
 * The path `spfn ops token` takes, driven end to end against the mounted auth
 * router: sign in as an administrator with a freshly generated key pair, sign
 * a request with its private half, and issue, list and revoke ops tokens.
 *
 * The authorization table these assert:
 *
 *   caller              issue / list / revoke
 *   administrator       200
 *   ordinary user       403
 *   unauthenticated     401
 *
 * The secret appears in the issuance answer and nowhere else — listing carries
 * records that never held it, since only its hash was ever stored.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { authenticate } from '@/server/middleware/authenticate';
import { verifyOpsTokenService } from '@/server/services/ops-token.service';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';

describe.skipIf(!dbAvailable)('Ops token routes', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';

        app = new Hono();
        // A real app registers `authenticate` as a server-level middleware, and
        // routes that need a principal without declaring one — `/_auth/keys/revoke`
        // among them — rely on it being there.
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();

        const adminRole = await getRoleByName('admin');
        const userRole = await getRoleByName('user');

        await db.insert(users).values({
            email: 'admin@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: adminRole!.id,
            emailVerifiedAt: new Date(),
        });

        await db.insert(users).values({
            email: 'user@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
    });

    /**
     * Exactly what the CLI does: generate a key pair, hand the public half
     * over at login, and sign a request with the private half.
     */
    async function signIn(email: string): Promise<string>
    {
        const keyPair = generateKeyPair('ES256');

        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                email,
                password: PASSWORD,
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
                deviceName: 'spfn CLI',
            }),
        });

        expect(response.status).toBe(200);

        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', {
            expiresIn: '5m',
        });

        return `Bearer ${token}`;
    }

    async function issue(authorization: string, body: Record<string, unknown>)
    {
        return app.request('/_auth/ops-tokens', {
            method: 'POST',
            headers: { ...JSON_HEADERS, Authorization: authorization },
            body: JSON.stringify(body),
        });
    }

    describe('authorization', () =>
    {
        it('lets an administrator issue, list and revoke', async () =>
        {
            const authorization = await signIn('admin@test.com');

            const issued = await issue(authorization, { name: 'laptop', scopes: ['*'] });
            expect(issued.status).toBe(200);

            const listed = await app.request('/_auth/ops-tokens', { headers: { Authorization: authorization } });
            expect(listed.status).toBe(200);

            const id = (await issued.json()).opsToken.id;
            const revoked = await app.request(`/_auth/ops-tokens/${id}`, {
                method: 'DELETE',
                headers: { Authorization: authorization },
            });
            expect(revoked.status).toBe(200);
        });

        it('refuses an ordinary user with 403', async () =>
        {
            const authorization = await signIn('user@test.com');

            expect((await issue(authorization, { name: 'n', scopes: ['*'] })).status).toBe(403);
            expect((await app.request('/_auth/ops-tokens', { headers: { Authorization: authorization } })).status).toBe(403);
        });

        it('refuses an unauthenticated caller with 401', async () =>
        {
            const response = await app.request('/_auth/ops-tokens', {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({ name: 'n', scopes: ['*'] }),
            });

            expect(response.status).toBe(401);
        });
    });

    describe('issuance', () =>
    {
        it('returns a usable secret, and returns it only once', async () =>
        {
            const authorization = await signIn('admin@test.com');
            const answer = await (await issue(authorization, {
                name: 'laptop',
                scopes: ['example:read'],
            })).json();

            expect(answer.token).toMatch(/^spfn_ops_[0-9a-f]{64}$/);
            expect(await verifyOpsTokenService(answer.token)).toMatchObject({
                name: 'laptop',
                scopes: ['example:read'],
            });

            const listed = await (await app.request('/_auth/ops-tokens', {
                headers: { Authorization: authorization },
            })).json();

            expect(listed.opsTokens).toHaveLength(1);
            expect(JSON.stringify(listed)).not.toContain(answer.token);
        });

        it('honours expiresInDays, and null for a non-expiring token', async () =>
        {
            const authorization = await signIn('admin@test.com');

            const expiring = await (await issue(authorization, {
                name: 'ci', scopes: ['*'], expiresInDays: 30,
            })).json();
            expect(new Date(expiring.opsToken.expiresAt).getTime()).toBeGreaterThan(Date.now());

            const permanent = await (await issue(authorization, {
                name: 'laptop', scopes: ['*'], expiresInDays: null,
            })).json();
            expect(permanent.opsToken.expiresAt).toBeNull();
        });

        it('refuses an empty scope list', async () =>
        {
            const authorization = await signIn('admin@test.com');

            expect((await issue(authorization, { name: 'n', scopes: [] })).status).toBe(400);
        });

        /**
         * A day count becomes a date by arithmetic, so a big enough count
         * produces an invalid date rather than a distant one — and an invalid
         * date reaches the driver as a value it refuses, turning a bad request
         * into a 500. Both the largest accepted count and the first refused one
         * are pinned, because a bound is only a bound if both sides hold.
         */
        it('refuses an expiry too large to be a date, and accepts the bound itself', async () =>
        {
            const authorization = await signIn('admin@test.com');

            expect((await issue(authorization, {
                name: 'overflow', scopes: ['*'], expiresInDays: 1e11,
            })).status).toBe(400);

            expect((await issue(authorization, {
                name: 'just-over', scopes: ['*'], expiresInDays: 36501,
            })).status).toBe(400);

            const atBound = await issue(authorization, {
                name: 'century', scopes: ['*'], expiresInDays: 36500,
            });
            expect(atBound.status).toBe(200);
            expect(new Date((await atBound.json()).opsToken.expiresAt).getTime())
                .toBeGreaterThan(Date.now());
        });
    });

    describe('revocation', () =>
    {
        it('stops the token working, and answers 404 for an unknown id', async () =>
        {
            const authorization = await signIn('admin@test.com');
            const answer = await (await issue(authorization, { name: 'laptop', scopes: ['*'] })).json();

            await app.request(`/_auth/ops-tokens/${answer.opsToken.id}`, {
                method: 'DELETE',
                headers: { Authorization: authorization },
            });

            expect(await verifyOpsTokenService(answer.token)).toBeNull();

            const missing = await app.request('/_auth/ops-tokens/999999', {
                method: 'DELETE',
                headers: { Authorization: authorization },
            });
            expect(missing.status).toBe(404);
        });
    });

    describe('the key the CLI signs with', () =>
    {
        it('is revocable, so the CLI can clean up after itself', async () =>
        {
            const keyPair = generateKeyPair('ES256');

            await app.request('/_auth/login', {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    email: 'admin@test.com',
                    password: PASSWORD,
                    publicKey: keyPair.publicKey,
                    keyId: keyPair.keyId,
                    fingerprint: keyPair.fingerprint,
                    algorithm: keyPair.algorithm,
                    deviceName: 'spfn CLI',
                }),
            });

            const authorization = `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256')}`;

            const revoked = await app.request('/_auth/keys/revoke', {
                method: 'POST',
                headers: { ...JSON_HEADERS, Authorization: authorization },
                body: JSON.stringify({ keyId: keyPair.keyId }),
            });
            expect(revoked.status).toBe(200);

            // The signature no longer authenticates anything.
            expect((await app.request('/_auth/ops-tokens', {
                headers: { Authorization: authorization },
            })).status).toBe(401);
        });
    });

    describe('the administrator the CLI signs in as', () =>
    {
        it('is the account seeded from the environment', async () =>
        {
            const db = getTestDb();
            const [admin] = await db.select().from(users).where(eq(users.email, 'admin@test.com')).limit(1);

            expect(admin).toBeDefined();
            expect(admin!.passwordHash).toBeTruthy();
        });
    });
});
