/**
 * @spfn/auth - the signed sign-out-everywhere link (design #94 v2, §7b)
 *
 * One `it` per row of §7b, in the table's order. Two calls are under test and
 * they are deliberately unlike each other: `confirm` describes a link and must
 * change nothing, `consume` is the only thing that revokes.
 *
 * Almost every row is about a refusal, and every refusal is the same one. So the
 * rows assert the state left behind — which keys still sign, where the account's
 * key generation stands, whether the row was spent — rather than reading a
 * difference out of a 404 that by design has none.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp } from '../helpers/oauth2';
import { keyRevokeAllTokens, userPublicKeys, users } from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: (...args: unknown[]) => sendEmail(...args),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { createRevokeAllLink, consumeRevokeAllLink } = await import('@/server/services/revoke-all-link.service');
const { revokeAllKeysService } = await import('@/server/services/key.service');
const { requestAccountDeletionService } = await import('@/server/services/account-deletion.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SecurePassword123!';
const NEW_PASSWORD = 'BrandNewPassword456!';

describe.skipIf(!dbAvailable)('signed revoke-all link (case table 7b)', () =>
{
    let app: Hono;
    let testIndex = 0;
    let clientIp: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
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
        await initializeAuth();
        sendEmail.mockClear();

        testIndex += 1;
        // Both endpoints are rate limited per address, and the store lives for the
        // life of the process, so each row gets an address of its own.
        clientIp = `192.0.2.${testIndex & 0xff}`;
    });

    // ========================================================================
    // Driving the two endpoints
    // ========================================================================

    function post(path: string, body: unknown, authorization?: string)
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': clientIp };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    const confirm = (token: unknown) => post('/_auth/keys/revoke-all/confirm', { token });
    const consume = (token: unknown) => post('/_auth/keys/revoke-all/consume', { token });

    /** Both endpoints refuse the same way; this is what "refused" means here. */
    async function expectRefused(response: Response)
    {
        expect(response.status).toBe(404);
        expect((await response.json()).error.code).toBe('RevokeAllLinkError');
    }

    // ========================================================================
    // Accounts, keys and links
    // ========================================================================

    async function seedUser(email: string, status: 'active' | 'suspended' | 'inactive' | 'pending_deletion' = 'active')
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            status,
            roleId: userRole!.id,
        }).returning();

        return row;
    }

    /** Sign in with a password and answer with what a client would then hold. */
    async function signIn(email: string)
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });

        expect(response.status).toBe(200);

        const bearer = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });

        return { key, authorization: `Bearer ${bearer}` };
    }

    /** The plaintext token out of the URL the app is handed. */
    function tokenOf(url: string): string
    {
        return new URL(url).searchParams.get('token')!;
    }

    async function issueLink(userId: number, ttlMinutes?: number)
    {
        const link = await createRevokeAllLink(userId, ttlMinutes === undefined ? {} : { ttlMinutes });

        return { ...link, token: tokenOf(link.url) };
    }

    /** An account with two signed-in devices and a live link for it. */
    async function accountWithLink(email: string)
    {
        const user = await seedUser(email);
        const first = await signIn(email);
        const second = await signIn(email);
        const link = await issueLink(user.id);

        return { user, first, second, ...link };
    }

    async function keyRows(userId: number)
    {
        return getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.userId, userId));
    }

    async function activeKeyCount(userId: number): Promise<number>
    {
        return (await keyRows(userId)).filter((row) => row.isActive).length;
    }

    async function keyEpoch(userId: number): Promise<number>
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.id, userId)).limit(1);

        return row.keyEpoch;
    }

    async function linkRows(userId: number)
    {
        return getTestDb().select().from(keyRevokeAllTokens).where(eq(keyRevokeAllTokens.userId, userId));
    }

    /** Move a link row's expiry into the past, which is what waiting out its TTL does. */
    async function expireLink(userId: number, byMinutes = 60)
    {
        await getTestDb().update(keyRevokeAllTokens)
            .set({ expiresAt: new Date(Date.now() - byMinutes * 60_000) })
            .where(eq(keyRevokeAllTokens.userId, userId));
    }

    // ========================================================================
    // 7b — token state x call
    // ========================================================================

    it('a live token: confirm answers expiresAt and activeKeyCount and changes nothing; consume revokes every key, refuses the pending device codes, moves the epoch and stamps consumedAt', async () =>
    {
        const { user, expiresAt, token } = await accountWithLink('b1@test.com');

        const described = await confirm(token);
        expect(described.status).toBe(200);
        expect(await described.json()).toEqual({
            expiresAt: expiresAt.toISOString(),
            activeKeyCount: 2,
        });
        expect(await activeKeyCount(user.id)).toBe(2);
        expect((await linkRows(user.id))[0].consumedAt).toBeNull();

        const epochBefore = await keyEpoch(user.id);
        const spent = await consume(token);

        expect(spent.status).toBe(200);
        expect(await spent.json()).toEqual({ revokedCount: 2 });
        expect(await activeKeyCount(user.id)).toBe(0);
        expect(await keyEpoch(user.id)).toBe(epochBefore + 1);
        expect((await linkRows(user.id))[0].consumedAt).not.toBeNull();
    });

    it('a live token for an account with no active keys: confirm answers activeKeyCount 0 and consume answers revokedCount 0, which is a success — the epoch still moves and the link is spent', async () =>
    {
        const user = await seedUser('b2@test.com');
        const { token } = await issueLink(user.id);

        expect(await (await confirm(token)).json()).toMatchObject({ activeKeyCount: 0 });

        const spent = await consume(token);

        expect(spent.status).toBe(200);
        expect(await spent.json()).toEqual({ revokedCount: 0 });
        expect(await keyEpoch(user.id)).toBe(1);
        expect((await linkRows(user.id))[0].consumedAt).not.toBeNull();
    });

    it('a token that was never issued: 404 from both', async () =>
    {
        await accountWithLink('b3@test.com');

        await expectRefused(await confirm('never-issued-token'));
        await expectRefused(await consume('never-issued-token'));
    });

    it('an expired token: 404 from both, and nothing is revoked', async () =>
    {
        const { user, token } = await accountWithLink('b4@test.com');
        await expireLink(user.id);

        await expectRefused(await confirm(token));
        await expectRefused(await consume(token));
        expect(await activeKeyCount(user.id)).toBe(2);
        expect(await keyEpoch(user.id)).toBe(0);
    });

    it('a token presented again after it was spent: 404 from both', async () =>
    {
        const { user, token } = await accountWithLink('b5@test.com');

        expect((await consume(token)).status).toBe(200);

        await expectRefused(await confirm(token));
        await expectRefused(await consume(token));
        expect(await keyEpoch(user.id)).toBe(1);
    });

    it('a spent token that has not expired and the sweep has not reached: still 404, because consumedAt is what refuses it and not the clock', async () =>
    {
        const { user, token } = await accountWithLink('b6@test.com');

        expect((await consume(token)).status).toBe(200);

        const [row] = await linkRows(user.id);
        expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(row.consumedAt).not.toBeNull();

        await expectRefused(await confirm(token));
        await expectRefused(await consume(token));
    });

    it('a second link issued while the first was unspent: the first is 404 from both and the second works, because issuing supersedes', async () =>
    {
        const { user, token: first } = await accountWithLink('b7@test.com');
        const { token: second } = await issueLink(user.id);

        await expectRefused(await confirm(first));
        await expectRefused(await consume(first));

        expect((await confirm(second)).status).toBe(200);
        expect((await consume(second)).status).toBe(200);

        const rows = await linkRows(user.id);
        expect(rows.filter((row) => row.supersededAt !== null)).toHaveLength(1);
    });

    it('a link issued before a password reset completed: 404 from both, because the reset moved the epoch', async () =>
    {
        const { user, token } = await accountWithLink('b8@test.com');

        expect((await post('/_auth/password/reset', { email: 'b8@test.com' })).status).toBe(200);
        const emailed = sendEmail.mock.calls.filter(([arg]) => arg?.template === 'password-reset').pop();
        const confirmed = await post('/_auth/password/reset/confirm', { token: tokenOf(emailed![0].data.confirmUrl) });
        const { setupSecret } = await confirmed.json();
        const device = generateKeyPair('ES256');

        expect((await post('/_auth/password/reset/complete', {
            setupSecret,
            password: NEW_PASSWORD,
            publicKey: device.publicKey,
            keyId: device.keyId,
            fingerprint: device.fingerprint,
            algorithm: device.algorithm,
        })).status).toBe(200);

        expect(await keyEpoch(user.id)).toBe(1);
        await expectRefused(await confirm(token));
        await expectRefused(await consume(token));
    });

    it('a link issued before a password change: 404 from both, for the same reason', async () =>
    {
        const { user, first, token } = await accountWithLink('b9@test.com');

        const changed = await app.request('/_auth/password', {
            method: 'PUT',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': clientIp, Authorization: first.authorization },
            body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
        });

        expect(changed.status).toBe(204);
        expect(await keyEpoch(user.id)).toBe(1);
        await expectRefused(await confirm(token));
        await expectRefused(await consume(token));
    });

    it('a link issued before a deletion request, still inside the grace period: 404 from both', async () =>
    {
        const { user, token } = await accountWithLink('b10@test.com');

        await requestAccountDeletionService(user.id, { requestedBy: 'self', password: PASSWORD });

        expect(await keyEpoch(user.id)).toBe(1);
        await expectRefused(await confirm(token));
        await expectRefused(await consume(token));
    });

    it('a link issued before the revoke-all route ran, in either mode: 404 from both — sparing the calling device still ends the generation', async () =>
    {
        const sparing = await accountWithLink('b11-spare@test.com');
        await post('/_auth/keys/revoke-all', {}, sparing.first.authorization);

        expect(await keyEpoch(sparing.user.id)).toBe(1);
        await expectRefused(await confirm(sparing.token));
        await expectRefused(await consume(sparing.token));

        const including = await accountWithLink('b11-all@test.com');
        await post('/_auth/keys/revoke-all', { includeCurrent: true }, including.first.authorization);

        expect(await keyEpoch(including.user.id)).toBe(1);
        await expectRefused(await confirm(including.token));
        await expectRefused(await consume(including.token));
    });

    it('a device that signed in after the link was issued: still 200 from both, the epoch did not move, and the new device is revoked with the rest', async () =>
    {
        const { user, token } = await accountWithLink('b12@test.com');
        const late = await signIn('b12@test.com');

        expect(await keyEpoch(user.id)).toBe(0);
        expect((await confirm(token)).status).toBe(200);

        const spent = await consume(token);

        expect(await spent.json()).toEqual({ revokedCount: 3 });
        expect(await activeKeyCount(user.id)).toBe(0);
        expect((await keyRows(user.id)).find((row) => row.keyId === late.key.keyId)!.isActive).toBe(false);
    });

    it('one key revoked, rotated or logged out after the link was issued: still 200 from both, because none of the three ends the generation', async () =>
    {
        const { user, first, second, token } = await accountWithLink('b13@test.com');

        expect((await post('/_auth/keys/revoke', { keyId: second.key.keyId }, first.authorization)).status).toBe(200);

        const rotated = generateKeyPair('ES256');
        expect((await post('/_auth/keys/rotate', {
            publicKey: rotated.publicKey,
            keyId: rotated.keyId,
            fingerprint: rotated.fingerprint,
            algorithm: rotated.algorithm,
        }, first.authorization)).status).toBe(200);

        const rotatedBearer = generateClientToken({ keyId: rotated.keyId }, rotated.privateKey, 'ES256', { expiresIn: '5m' });
        expect((await post('/_auth/logout', {}, `Bearer ${rotatedBearer}`)).status).toBe(204);

        expect(await keyEpoch(user.id)).toBe(0);
        expect((await confirm(token)).status).toBe(200);
        expect((await consume(token)).status).toBe(200);
    });

    it('an account anonymized by the deletion purge, whose users row survives: 404 from both, because the statement joins status active', async () =>
    {
        const { user, token } = await accountWithLink('b14@test.com');

        // What anonymize leaves behind: the row, marked deleted, with its keys gone
        // and its epoch untouched — which is why status has to be in the join.
        await getTestDb().delete(userPublicKeys).where(eq(userPublicKeys.userId, user.id));
        await getTestDb().update(users).set({ status: 'deleted', deletedAt: new Date() })
            .where(eq(users.id, user.id));

        expect(await keyEpoch(user.id)).toBe(0);
        await expectRefused(await confirm(token));
        await expectRefused(await consume(token));
    });

    it('an account removed by a hard-delete purge: 404 from both, and the link row went with it', async () =>
    {
        const { user, token } = await accountWithLink('b15@test.com');

        await getTestDb().delete(users).where(eq(users.id, user.id));

        await expectRefused(await confirm(token));
        await expectRefused(await consume(token));
        expect(await linkRows(user.id)).toHaveLength(0);
    });

    it('an account that is suspended, inactive or pending_deletion: 404 from both', async () =>
    {
        for (const status of ['suspended', 'inactive', 'pending_deletion'] as const)
        {
            const user = await seedUser(`b16-${status}@test.com`);
            const { token } = await issueLink(user.id);

            await getTestDb().update(users).set({ status }).where(eq(users.id, user.id));

            await expectRefused(await confirm(token));
            await expectRefused(await consume(token));
            expect(await keyEpoch(user.id)).toBe(0);
        }
    });

    it('two consume calls with the same token at once: exactly one 200 and one 404, because the claim is one statement', async () =>
    {
        const { user, token } = await accountWithLink('b17@test.com');

        const [left, right] = await Promise.all([consume(token), consume(token)]);
        const statuses = [left.status, right.status].sort();

        expect(statuses).toEqual([200, 404]);
        expect(await activeKeyCount(user.id)).toBe(0);
        expect(await keyEpoch(user.id)).toBe(1);
    });

    it('a consume racing a revoke-all from another path: only one of them can be the revocation, and the link is dead afterwards either way', async () =>
    {
        const { user, first, token } = await accountWithLink('b18@test.com');

        const [linkResult] = await Promise.allSettled([
            consumeRevokeAllLink(token),
            revokeAllKeysService({
                userId: user.id,
                currentKeyId: first.key.keyId,
                includeCurrent: true,
                reason: 'the other path',
            }),
        ]);

        // Whichever order the two land in, the account ends with nothing signed in
        // and the link cannot be presented again.
        expect(await activeKeyCount(user.id)).toBe(0);
        expect(await keyEpoch(user.id)).toBeGreaterThanOrEqual(1);
        expect(['fulfilled', 'rejected']).toContain(linkResult.status);
        await expectRefused(await consume(token));
    });

    it('a body with no token, or an empty one: 400 from both, refused by the route schema before anything is looked up', async () =>
    {
        for (const body of [{}, { token: '' }])
        {
            const described = await post('/_auth/keys/revoke-all/confirm', body);
            const spent = await post('/_auth/keys/revoke-all/consume', body);

            expect(described.status).toBe(400);
            expect(spent.status).toBe(400);
        }
    });

    it('the eleventh request from one address within the minute: 429, whether the token was valid or not', async () =>
    {
        const { token } = await accountWithLink('b20@test.com');

        // Ten answered requests, valid and invalid mixed: one counter, one
        // dimension, so a caller cannot tell the two apart by which one is left.
        for (let index = 0; index < 5; index += 1)
        {
            expect((await confirm(token)).status).toBe(200);
            expect((await confirm('not-a-token')).status).toBe(404);
        }

        expect((await confirm(token)).status).toBe(429);
        expect((await consume(token)).status).toBe(429);
    });

    it('a link issued with ttlMinutes 5: it expires five minutes out, and five minutes later both calls answer 404', async () =>
    {
        const user = await seedUser('b21@test.com');
        const { token, expiresAt } = await issueLink(user.id, 5);

        const minutesOut = (expiresAt.getTime() - Date.now()) / 60_000;
        expect(minutesOut).toBeGreaterThan(4.5);
        expect(minutesOut).toBeLessThanOrEqual(5);

        expect((await confirm(token)).status).toBe(200);

        // Five minutes later, which for a row judged against now() is the same
        // thing as the row's expiry being five minutes behind.
        await expireLink(user.id, 5);

        await expectRefused(await confirm(token));
        await expectRefused(await consume(token));
    });

    it('issuing with ttlMinutes 0 or negative: a ValidationError, and no row is written', async () =>
    {
        const user = await seedUser('b22@test.com');

        for (const ttlMinutes of [0, -5, 1.5])
        {
            await expect(createRevokeAllLink(user.id, { ttlMinutes })).rejects.toMatchObject({
                name: 'ValidationError',
            });
        }

        expect(await linkRows(user.id)).toHaveLength(0);
    });

    it('issuing for a userId that does not exist: an explicit refusal rather than a foreign-key failure surfacing as a 500', async () =>
    {
        await expect(createRevokeAllLink(9_999_999)).rejects.toMatchObject({
            name: 'NotFoundError',
            statusCode: 404,
        });
    });

    it('the token never reaches the request log: neither the path nor the logged body carries it', async () =>
    {
        const { RequestLogger } = await import('@spfn/core/middleware');
        const { logger } = await import('@spfn/core/logger');
        const { Hono } = await import('hono');
        const { registerRoutes } = await import('@spfn/core/route');
        const { ErrorHandler } = await import('@spfn/core/middleware');
        const { mainAuthRouter } = await import('@/server/routes');

        const lines: string[] = [];
        const child = logger.child('@spfn/core:api');
        const record = (message: string, meta?: unknown) => lines.push(`${message} ${JSON.stringify(meta ?? {})}`);

        vi.spyOn(child, 'info').mockImplementation(record as never);
        vi.spyOn(child, 'warn').mockImplementation(record as never);
        vi.spyOn(logger, 'child').mockReturnValue(child);

        const logged = new Hono();
        logged.use('*', RequestLogger());
        registerRoutes(logged, mainAuthRouter);
        logged.onError(ErrorHandler());

        const { token } = await accountWithLink('b24@test.com');

        const call = (path: string) => logged.request(path, {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': clientIp },
            body: JSON.stringify({ token }),
        });

        expect((await call('/_auth/keys/revoke-all/confirm')).status).toBe(200);
        // A refusal is the interesting one: the logger reads the request body back
        // on a 4xx, which is exactly where a bearer value would escape.
        expect((await call('/_auth/keys/revoke-all/consume')).status).toBe(200);
        expect((await call('/_auth/keys/revoke-all/consume')).status).toBe(404);

        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join('\n')).not.toContain(token);

        vi.restoreAllMocks();
    });

    // ========================================================================
    // The route map, which is what a typed client is built from
    // ========================================================================

    it('both endpoints are on mainAuthRouter and in the generated route map, so authApi exposes them', async () =>
    {
        const { mainAuthRouter } = await import('@/server/routes');
        const { routeMap } = await import('@/generated/route-map');

        const routes = mainAuthRouter.routes as unknown as Record<string, { method: string; path: string }>;

        expect(routes.confirmRevokeAllLink).toMatchObject({ method: 'POST', path: '/_auth/keys/revoke-all/confirm' });
        expect(routes.consumeRevokeAllLink).toMatchObject({ method: 'POST', path: '/_auth/keys/revoke-all/consume' });

        // The generator parses only the files `routes/index.ts` imports directly,
        // so a route reached through a re-export would be missing here and from
        // every typed client built on the map.
        expect(routeMap.confirmRevokeAllLink).toEqual({ method: 'POST', path: '/_auth/keys/revoke-all/confirm' });
        expect(routeMap.consumeRevokeAllLink).toEqual({ method: 'POST', path: '/_auth/keys/revoke-all/consume' });
    });
});
