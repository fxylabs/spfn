/**
 * @spfn/auth - key registration provenance and the key epoch (design #94 v2,
 * §7c and §7d)
 *
 * §7c is about two fields that are written once and never again: where a device
 * was registered from, as the registering request stated it. Every row is a
 * variation on "what does `listKeys` show, and does anything later move it".
 *
 * §7d is the counter those fields have nothing to do with — `users.key_epoch`,
 * which is what an outstanding sign-out-everywhere link is bound to. The rows
 * are a list of what ends a key generation and what does not, and the two halves
 * share a file because the second is read straight off the same account the
 * first builds.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp } from '../helpers/oauth2';
import { userPublicKeys, users } from '@/server/entities';
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
const { buildMobileContractBundle, CONTRACT_VERSION } = await import('@/server/client-proof/contract-bundle');
const { requestAccountDeletionService } = await import('@/server/services/account-deletion.service');
const { createRevokeAllLink } = await import('@/server/services/revoke-all-link.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SecurePassword123!';
const NEW_PASSWORD = 'BrandNewPassword456!';
const USER_AGENT = 'ProvenanceSuite/1.0 (test)';

interface KeySummaryShape
{
    keyId: string;
    isActive: boolean;
    registeredIp?: string;
    registeredUserAgent?: string;
}

describe.skipIf(!dbAvailable)('key registration provenance and the key epoch (case tables 7c, 7d)', () =>
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
        clientIp = `203.0.113.${testIndex & 0xff}`;
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function post(path: string, body: unknown, options: { authorization?: string; headers?: Record<string, string> } = {})
    {
        const headers: Record<string, string> = {
            ...JSON_HEADERS,
            'x-forwarded-for': clientIp,
            'user-agent': USER_AGENT,
            ...options.headers,
        };

        if (options.authorization)
        {
            headers.Authorization = options.authorization;
        }

        return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    async function seedUser(email: string)
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            roleId: userRole!.id,
        }).returning();

        return row;
    }

    async function signIn(email: string, headers: Record<string, string> = {})
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        }, { headers });

        expect(response.status).toBe(200);

        const bearer = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });

        return { key, authorization: `Bearer ${bearer}` };
    }

    async function listKeys(authorization: string, includeRevoked = false): Promise<KeySummaryShape[]>
    {
        const response = await post('/_auth/keys/list', includeRevoked ? { includeRevoked } : {}, { authorization });

        expect(response.status).toBe(200);

        return (await response.json()).keys;
    }

    function entryFor(keys: KeySummaryShape[], keyId: string): KeySummaryShape
    {
        const entry = keys.find((key) => key.keyId === keyId);

        if (!entry)
        {
            throw new Error(`no key entry for ${keyId}`);
        }

        return entry;
    }

    async function keyEpoch(userId: number): Promise<number>
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.id, userId)).limit(1);

        return row.keyEpoch;
    }

    // ========================================================================
    // 7c — listKeys
    // ========================================================================

    it('a key registered since this release: the values the registering request carried, and they do not move when the device authenticates from somewhere else', async () =>
    {
        await seedUser('c1@test.com');
        const session = await signIn('c1@test.com');

        expect(entryFor(await listKeys(session.authorization), session.key.keyId)).toMatchObject({
            registeredIp: clientIp,
            registeredUserAgent: USER_AGENT,
        });

        // The same device, now on another network and a newer build.
        const elsewhere = await post('/_auth/keys/list', {}, {
            authorization: session.authorization,
            headers: { 'x-forwarded-for': '198.51.100.9', 'user-agent': 'Somewhere/2.0' },
        });

        expect(elsewhere.status).toBe(200);
        expect(entryFor((await elsewhere.json()).keys, session.key.keyId)).toMatchObject({
            registeredIp: clientIp,
            registeredUserAgent: USER_AGENT,
        });
    });

    it('a key registered before this release, whose columns are null: neither field is present, because the schema declares both optional', async () =>
    {
        await seedUser('c2@test.com');
        const session = await signIn('c2@test.com');

        // What a row written before the columns existed looks like.
        await getTestDb().update(userPublicKeys)
            .set({ registeredIp: null, registeredUserAgent: null })
            .where(eq(userPublicKeys.keyId, session.key.keyId));

        const entry = entryFor(await listKeys(session.authorization), session.key.keyId);

        expect(entry).not.toHaveProperty('registeredIp');
        expect(entry).not.toHaveProperty('registeredUserAgent');
    });

    it('a request getClientIp cannot resolve an address for: no registeredIp, and never the literal word unknown', async () =>
    {
        await seedUser('c3@test.com');

        const key = generateKeyPair('ES256');
        // No forwarding header of any kind, and no node socket behind
        // `app.request`, which is what makes getClientIp answer 'unknown'.
        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'user-agent': USER_AGENT },
            body: JSON.stringify({
                email: 'c3@test.com',
                password: PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });

        expect(response.status).toBe(200);

        const [row] = await getTestDb().select().from(userPublicKeys)
            .where(eq(userPublicKeys.keyId, key.keyId)).limit(1);

        expect(row.registeredIp).toBeNull();

        const bearer = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });
        const entry = entryFor(await listKeys(`Bearer ${bearer}`), key.keyId);

        expect(entry).not.toHaveProperty('registeredIp');
        expect(entry.registeredUserAgent).toBe(USER_AGENT);
    });

    it('a user-agent longer than 512 characters: stored truncated at 512, with no marker', async () =>
    {
        await seedUser('c4@test.com');
        const long = `Long/${'a'.repeat(800)}`;
        const session = await signIn('c4@test.com', { 'user-agent': long });

        const entry = entryFor(await listKeys(session.authorization), session.key.keyId);

        expect(entry.registeredUserAgent).toHaveLength(512);
        expect(entry.registeredUserAgent).toBe(long.slice(0, 512));
    });

    it('a request with no user-agent header: no registeredUserAgent field', async () =>
    {
        await seedUser('c5@test.com');

        const key = generateKeyPair('ES256');
        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': clientIp },
            body: JSON.stringify({
                email: 'c5@test.com',
                password: PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });

        expect(response.status).toBe(200);

        const bearer = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });
        const entry = entryFor(await listKeys(`Bearer ${bearer}`), key.keyId);

        expect(entry).not.toHaveProperty('registeredUserAgent');
        expect(entry.registeredIp).toBe(clientIp);
    });

    it('a key registered through device-code login: the address of the device that polled, not of the device that approved', async () =>
    {
        await seedUser('c6@test.com');
        const approver = await signIn('c6@test.com');

        const device = generateKeyPair('ES256');
        const started = await post('/_auth/device/start', {
            publicKey: device.publicKey,
            keyId: device.keyId,
            fingerprint: device.fingerprint,
            algorithm: device.algorithm,
            deviceName: 'Living room TV',
            platform: 'desktop',
        });
        const { deviceCode, userCode } = await started.json();

        expect((await post('/_auth/device/approve', { userCode }, { authorization: approver.authorization })).status).toBe(200);

        const pollingIp = '198.51.100.200';
        const polled = await post('/_auth/device/poll', { deviceCode }, {
            headers: { 'x-forwarded-for': pollingIp, 'user-agent': 'LivingRoomTV/3.0' },
        });

        expect(polled.status).toBe(200);

        const entry = entryFor(await listKeys(approver.authorization), device.keyId);

        expect(entry.registeredIp).toBe(pollingIp);
        expect(entry.registeredUserAgent).toBe('LivingRoomTV/3.0');
        // The approving device's own entry still carries its own registration.
        expect(entryFor(await listKeys(approver.authorization), approver.key.keyId).registeredIp).toBe(clientIp);
    });

    it('includeRevoked: a revoked key carries the same two values it was registered with', async () =>
    {
        await seedUser('c7@test.com');
        const first = await signIn('c7@test.com');
        const second = await signIn('c7@test.com');

        expect((await post('/_auth/keys/revoke', { keyId: second.key.keyId }, { authorization: first.authorization })).status).toBe(200);

        expect(await listKeys(first.authorization)).toHaveLength(1);

        const entry = entryFor(await listKeys(first.authorization, true), second.key.keyId);

        expect(entry.isActive).toBe(false);
        expect(entry).toMatchObject({ registeredIp: clientIp, registeredUserAgent: USER_AGENT });
    });

    it('the contract: KeySummary declares the two fields and the bundle is at 0.12.0', async () =>
    {
        const bundle = buildMobileContractBundle();
        const summary = (bundle.types as { name: string; fields: { name: string; optional: boolean }[] }[])
            .find((type) => type.name === 'KeySummary')!;

        expect(summary.fields.find((field) => field.name === 'registeredIp')).toMatchObject({ optional: true });
        expect(summary.fields.find((field) => field.name === 'registeredUserAgent')).toMatchObject({ optional: true });
        expect(CONTRACT_VERSION).toBe('0.12.0');
        expect(bundle.contractVersion).toBe('0.12.0');
    });

    // ========================================================================
    // 7d — the key epoch
    // ========================================================================

    it('the revoke-all route, sparing the calling device or not: +1 either way', async () =>
    {
        const sparing = await seedUser('d1-spare@test.com');
        const sparingSession = await signIn('d1-spare@test.com');
        await signIn('d1-spare@test.com');

        expect((await post('/_auth/keys/revoke-all', {}, { authorization: sparingSession.authorization })).status).toBe(200);
        expect(await keyEpoch(sparing.id)).toBe(1);

        const including = await seedUser('d1-all@test.com');
        const includingSession = await signIn('d1-all@test.com');

        expect((await post('/_auth/keys/revoke-all', { includeCurrent: true }, { authorization: includingSession.authorization })).status).toBe(200);
        expect(await keyEpoch(including.id)).toBe(1);
    });

    it('a link consume: +1', async () =>
    {
        const user = await seedUser('d2@test.com');
        await signIn('d2@test.com');

        const link = await createRevokeAllLink(user.id);
        const token = new URL(link.url).searchParams.get('token')!;

        expect((await post('/_auth/keys/revoke-all/consume', { token })).status).toBe(200);
        expect(await keyEpoch(user.id)).toBe(1);
    });

    it('a password reset completing, a password change and a deletion request: +1 each, because all three go through the repository method', async () =>
    {
        const reset = await seedUser('d3-reset@test.com');
        await signIn('d3-reset@test.com');

        expect((await post('/_auth/password/reset', { email: 'd3-reset@test.com' })).status).toBe(200);
        const emailed = sendEmail.mock.calls.filter(([arg]) => arg?.template === 'password-reset').pop();
        const confirmed = await post('/_auth/password/reset/confirm', {
            token: new URL(emailed![0].data.confirmUrl).searchParams.get('token'),
        });
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
        expect(await keyEpoch(reset.id)).toBe(1);

        const changed = await seedUser('d3-change@test.com');
        const changeSession = await signIn('d3-change@test.com');

        const changeResponse = await app.request('/_auth/password', {
            method: 'PUT',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': clientIp, Authorization: changeSession.authorization },
            body: JSON.stringify({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
        });

        expect(changeResponse.status).toBe(204);
        expect(await keyEpoch(changed.id)).toBe(1);

        const deleting = await seedUser('d3-delete@test.com');
        await signIn('d3-delete@test.com');

        await requestAccountDeletionService(deleting.id, { requestedBy: 'self', password: PASSWORD });
        expect(await keyEpoch(deleting.id)).toBe(1);
    });

    it('one key revoked, a rotation and a logout: the epoch does not move — none of the three ends a generation', async () =>
    {
        const user = await seedUser('d4@test.com');
        const first = await signIn('d4@test.com');
        const second = await signIn('d4@test.com');

        expect((await post('/_auth/keys/revoke', { keyId: second.key.keyId }, { authorization: first.authorization })).status).toBe(200);

        const rotated = generateKeyPair('ES256');
        expect((await post('/_auth/keys/rotate', {
            publicKey: rotated.publicKey,
            keyId: rotated.keyId,
            fingerprint: rotated.fingerprint,
            algorithm: rotated.algorithm,
        }, { authorization: first.authorization })).status).toBe(200);

        const rotatedBearer = generateClientToken({ keyId: rotated.keyId }, rotated.privateKey, 'ES256', { expiresIn: '5m' });
        expect((await post('/_auth/logout', {}, { authorization: `Bearer ${rotatedBearer}` })).status).toBe(204);

        expect(await keyEpoch(user.id)).toBe(0);
    });

    it('an anonymize purge: the users row stays with its epoch untouched and its key rows gone, so the link dies on the status condition instead', async () =>
    {
        const user = await seedUser('d5@test.com');
        await signIn('d5@test.com');

        const link = await createRevokeAllLink(user.id);
        const token = new URL(link.url).searchParams.get('token')!;

        await getTestDb().delete(userPublicKeys).where(eq(userPublicKeys.userId, user.id));
        await getTestDb().update(users).set({ status: 'deleted', deletedAt: new Date() }).where(eq(users.id, user.id));

        const [row] = await getTestDb().select().from(users).where(eq(users.id, user.id)).limit(1);
        expect(row.keyEpoch).toBe(0);
        expect((await post('/_auth/keys/revoke-all/consume', { token })).status).toBe(404);
    });

    it('a hard-delete purge: the users row goes and the link rows cascade with it', async () =>
    {
        const { keyRevokeAllTokens } = await import('@/server/entities');

        const user = await seedUser('d6@test.com');
        await signIn('d6@test.com');
        await createRevokeAllLink(user.id);

        expect(await getTestDb().select().from(keyRevokeAllTokens).where(eq(keyRevokeAllTokens.userId, user.id))).toHaveLength(1);

        await getTestDb().delete(users).where(eq(users.id, user.id));

        expect(await getTestDb().select().from(keyRevokeAllTokens).where(eq(keyRevokeAllTokens.userId, user.id))).toHaveLength(0);
        expect(await getTestDb().select().from(users).where(eq(users.id, user.id))).toHaveLength(0);
    });
});
