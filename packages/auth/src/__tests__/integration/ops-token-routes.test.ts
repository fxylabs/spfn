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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mfaTotp, mfaVerifications, opsTokens, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authenticate } from '@/server/middleware/authenticate';
import { issueOpsTokenService, revokeOpsTokenService, verifyOpsTokenService } from '@/server/services/ops-token.service';
import { registerPublicKeyService } from '@/server/services/key.service';
import { opsTokenIssuedEvent, opsTokenRevokedEvent } from '@/server/events';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { runInTransaction } = await import('@spfn/core/db');

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
        return (await signInWithKey(email)).authorization;
    }

    async function signInWithKey(email: string): Promise<{ authorization: string; keyId: string }>
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

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId };
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

    /**
     * Issuance and revocation are announced after commit, and only then.
     *
     * Each payload is recorded with whether the act it names was visible, at
     * the moment the subscriber ran, from this suite's own connection — so an
     * emit made inside the transaction reads as uncommitted. A row that asserts
     * nothing fired also makes an act that does fire, and waits for it: the
     * absence is then read after a delivery that would have come behind it, not
     * after a guessed delay.
     */
    describe('announcements', () =>
    {
        type Seen<T> = { payload: T; committed: boolean };

        let issued: Seen<typeof opsTokenIssuedEvent._payload>[];
        let revoked: Seen<typeof opsTokenRevokedEvent._payload>[];
        let unsubscribe: (() => void)[];

        async function tokenRow(tokenId: number)
        {
            const [row] = await getTestDb().select().from(opsTokens).where(eq(opsTokens.id, tokenId));

            return row;
        }

        async function userIdOf(email: string): Promise<string>
        {
            const [row] = await getTestDb().select({ id: users.id }).from(users).where(eq(users.email, email));

            return String(row!.id);
        }

        beforeEach(() =>
        {
            // These rows sign in more often than the login route's limiter allows one address.
            resetMemoryRateLimitStore();
            issued = [];
            revoked = [];
            unsubscribe = [
                opsTokenIssuedEvent.subscribe(async (payload) =>
                {
                    issued.push({ payload, committed: (await tokenRow(payload.tokenId)) !== undefined });
                }),
                opsTokenRevokedEvent.subscribe(async (payload) =>
                {
                    revoked.push({ payload, committed: (await tokenRow(payload.tokenId))?.revokedAt != null });
                }),
            ];
            // The TOTP secret is encrypted at rest.
            vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', `active:${Buffer.alloc(32, 7).toString('base64')}`);
        });

        afterEach(() =>
        {
            // Both events are module singletons, and every suite in this package runs in one fork.
            unsubscribe.forEach(stop => stop());
            vi.unstubAllEnvs();
        });

        it('E-M issuance: one auth.ops_token.issued after commit, naming the token, the issuer and the key that signed — never the secret', async () =>
        {
            const admin = await signInWithKey('admin@test.com');
            // A second device of the same account: `via` must name the key that signed the request, not one the account holds
            await signInWithKey('admin@test.com');

            const answer = await (await issue(admin.authorization, {
                name: 'deploy', scopes: ['waitlist:read'], expiresInDays: 30,
            })).json();
            await vi.waitFor(() => expect(issued).toHaveLength(1));

            expect(issued[0]).toEqual({
                committed: true,
                payload: {
                    userId: await userIdOf('admin@test.com'),
                    tokenId: answer.opsToken.id,
                    name: 'deploy',
                    scopes: ['waitlist:read'],
                    expiresAtMillis: new Date(answer.opsToken.expiresAt).getTime(),
                    createdAtMillis: new Date(answer.opsToken.createdAt).getTime(),
                    via: { keyId: admin.keyId },
                },
            });
            const text = JSON.stringify(issued[0]!.payload);
            expect(text).not.toContain(answer.token);
            expect(text).not.toContain(createHash('sha256').update(answer.token).digest('hex'));
        });

        it('E-R1 issuance refused with STEP_UP_REQUIRED: no announcement', async () =>
        {
            const admin = await signIn('admin@test.com');
            const code = (secret: string) => hotp(decodeBase32(secret), totpStep(Date.now()));
            const { secret } = await (await app.request('/_auth/mfa/totp/enroll', {
                method: 'POST', headers: { ...JSON_HEADERS, Authorization: admin }, body: '{}',
            })).json();
            expect((await app.request('/_auth/mfa/totp/confirm', {
                method: 'POST', headers: { ...JSON_HEADERS, Authorization: admin }, body: JSON.stringify({ code: code(secret) }),
            })).status).toBe(200);
            // The step-up window this device earned by confirming has passed
            await getTestDb().delete(mfaVerifications);

            const refused = await issue(admin, { name: 'refused', scopes: ['*'] });
            expect((await refused.json()).code).toBe('STEP_UP_REQUIRED');

            await getTestDb().update(mfaTotp).set({ lastUsedStep: null });
            expect((await app.request('/_auth/mfa/step-up', {
                method: 'POST', headers: { ...JSON_HEADERS, Authorization: admin }, body: JSON.stringify({ code: code(secret) }),
            })).status).toBe(204);
            const allowed = await (await issue(admin, { name: 'allowed', scopes: ['*'] })).json();
            await vi.waitFor(() => expect(issued).toHaveLength(1));

            expect(issued.map(({ payload }) => payload.tokenId)).toEqual([allowed.opsToken.id]);
        });

        it('E-R2 the caller\'s transaction throws after issueOpsTokenService returned: no announcement, no token', async () =>
        {
            const admin = await signInWithKey('admin@test.com');
            const issuer = { userId: Number(await userIdOf('admin@test.com')), credential: { kind: 'deviceKey' as const, keyId: admin.keyId } };
            let rolledBack = 0;

            await expect(runInTransaction(async () =>
            {
                rolledBack = (await issueOpsTokenService('rolled-back', ['*'], null, issuer)).record.id;

                throw new Error('rolled back after the token row was written');
            })).rejects.toThrow('rolled back');
            const kept = await runInTransaction(() => issueOpsTokenService('kept', ['*'], null, issuer));
            await vi.waitFor(() => expect(issued).toHaveLength(1));

            expect(issued.map(({ payload }) => payload.tokenId)).toEqual([kept.record.id]);
            expect(await tokenRow(rolledBack)).toBeUndefined();
        });

        it('E-V revocation: auth.ops_token.revoked names the revoker after commit; an unknown or spent id is 404 and announces nothing', async () =>
        {
            const issuer = await signIn('admin@test.com');
            const adminRole = await getRoleByName('admin');
            await getTestDb().insert(users).values({
                email: 'revoker@test.com',
                passwordHash: await hashPassword(PASSWORD),
                roleId: adminRole!.id,
                emailVerifiedAt: new Date(),
            });
            const revoker = await signInWithKey('revoker@test.com');
            const first = (await (await issue(issuer, { name: 'first', scopes: ['*'] })).json()).opsToken;
            const second = (await (await issue(issuer, { name: 'second', scopes: ['*'] })).json()).opsToken;
            const revoke = (id: number) => app.request(`/_auth/ops-tokens/${id}`, {
                method: 'DELETE', headers: { Authorization: revoker.authorization },
            });

            const answer = await (await revoke(first.id)).json();
            await vi.waitFor(() => expect(revoked).toHaveLength(1));
            expect(revoked[0]).toEqual({
                committed: true,
                payload: {
                    userId: await userIdOf('revoker@test.com'),
                    tokenId: first.id,
                    name: 'first',
                    issuedBy: await userIdOf('admin@test.com'),
                    revokedAtMillis: new Date(answer.opsToken.revokedAt).getTime(),
                    via: { keyId: revoker.keyId },
                },
            });

            expect((await revoke(999999)).status).toBe(404);
            expect((await revoke(first.id)).status).toBe(404);
            expect((await revoke(second.id)).status).toBe(200);
            await vi.waitFor(() => expect(revoked).toHaveLength(2));

            expect(revoked.map(({ payload }) => payload.tokenId)).toEqual([first.id, second.id]);
        });

        it('E-P issuance through an application profile: `via` names the profile and the key its verifier reported', async () =>
        {
            const issuer = { userId: Number(await userIdOf('admin@test.com')), credential: { kind: 'appProfile' as const, profile: 'mobile', keyId: 'verifier-key' } };

            await issueOpsTokenService('mobile', ['*'], null, issuer);
            await vi.waitFor(() => expect(issued).toHaveLength(1));

            expect(issued[0]!.payload.via).toEqual({ keyId: 'verifier-key', profile: 'mobile' });
        });

        it('E-R3 a key held to ops tokens issues and revokes: both announcements name it in `via` with its reach', async () =>
        {
            const keyPair = generateKeyPair('ES256');
            await registerPublicKeyService({
                userId: Number(await userIdOf('admin@test.com')),
                keyId: keyPair.keyId,
                publicKey: keyPair.publicKey,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
                channel: 'device-link',
                narrowing: { reach: 'opsTokens', lifetimeMs: 5 * 60_000 },
            });
            const terminal = `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`;

            const answer = await (await issue(terminal, { name: 'from-terminal', scopes: ['*'] })).json();
            expect((await app.request(`/_auth/ops-tokens/${answer.opsToken.id}`, {
                method: 'DELETE', headers: { Authorization: terminal },
            })).status).toBe(200);
            await vi.waitFor(() => expect(revoked).toHaveLength(1));

            expect(issued.map(({ payload }) => payload.via)).toEqual([{ keyId: keyPair.keyId, reach: 'opsTokens' }]);
            expect(revoked.map(({ payload }) => payload.via)).toEqual([{ keyId: keyPair.keyId, reach: 'opsTokens' }]);
        });

        it('E-A revocation by the application itself, no revoker: announced without `userId` or `via`, and no throw', async () =>
        {
            const issuer = { userId: Number(await userIdOf('admin@test.com')), credential: { kind: 'deviceKey' as const, keyId: 'cli-key' } };
            const { record } = await issueOpsTokenService('retired', ['*'], null, issuer);

            const answer = await revokeOpsTokenService(record.id);
            await vi.waitFor(() => expect(revoked).toHaveLength(1));

            expect(revoked[0]).toEqual({
                committed: true,
                payload: {
                    tokenId: record.id,
                    name: 'retired',
                    issuedBy: String(issuer.userId),
                    revokedAtMillis: answer!.revokedAt!.getTime(),
                },
            });
        });
    });
});
