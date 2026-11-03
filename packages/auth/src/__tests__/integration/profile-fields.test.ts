/**
 * @spfn/auth - Profile fields declared in code (fxylabs/spfn#161)
 *
 * Rows P1–P6 of the design's case table (§9): `user_profiles.metadata` stays
 * free-form and replaced wholesale without a `defineProfileFields` declaration,
 * and becomes strict, merged key by key, with one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { Type } from '@sinclair/typebox';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp } from '../helpers/oauth2';
import { userProfiles, users } from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';

const { resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { authLogger } = await import('@/server/logger');
const { getUserProfileService, updateUserProfileService } = await import('@/server/services/user-profile.service');
const { defineProfileFields, __resetProfileFieldsForTests } = await import('@/server/lib/profile-fields');

const dbAvailable = await isDatabaseAvailable();

const PASSWORD = 'SecurePassword123!';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const PROFILE_FIELDS = defineProfileFields([
    { key: 'department', schema: Type.String({ maxLength: 80 }) },
    { key: 'github', schema: Type.String({ pattern: '^[A-Za-z0-9-]+$' }) },
    { key: 'itFields.badgeCount', schema: Type.Integer({ minimum: 0 }), default: 0 },
]);

describe('defineProfileFields', () =>
{
    it.each(['displayName', 'firstName', 'bio', 'jobTitle', 'userId', 'createdAt'])(
        'P5: the basic column name %s cannot be a field',
        (key) =>
        {
            expect(() => defineProfileFields([{ key, schema: Type.String() }])).toThrow(/basic profile column/);
        },
    );

    it.each(['locale', 'timezone'])('P5: the setting %s cannot be a field', (key) =>
    {
        expect(() => defineProfileFields([{ key, schema: Type.String() }])).toThrow(/user setting/);
    });

    it('P5: the key rules of defineUserSettings apply too', () =>
    {
        expect(() => defineProfileFields([{ key: 'Department', schema: Type.String() }])).toThrow(/must match/);
        expect(() => defineProfileFields([{ key: 'github', schema: Type.String() }, { key: 'github', schema: Type.String() }]))
            .toThrow(/declared twice/);
        expect(() => defineProfileFields([{ key: 'team', schema: Type.String(), default: 7 as never }]))
            .toThrow(/does not pass its own schema/);
    });

    it('metadata itself and fields without a default are allowed', () =>
    {
        expect(defineProfileFields([{ key: 'metadata', schema: Type.String() }]).keys).toEqual(['metadata']);
    });
});

describe.skipIf(!dbAvailable)('profile metadata (case table #161, P1–P6)', () =>
{
    let userId: number;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
    });

    afterAll(async () =>
    {
        __resetProfileFieldsForTests();
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();

        const [row] = await getTestDb().insert(users).values({
            email: 'fields@test.com',
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            roleId: (await getRoleByName('user'))!.id,
        }).returning();
        userId = row.id;
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    async function storeMetadata(metadata: Record<string, unknown>)
    {
        await getTestDb().insert(userProfiles).values({ userId, displayName: 'Ada', metadata });
    }

    async function storedMetadata()
    {
        const [row] = await getTestDb()
            .select({ metadata: userProfiles.metadata })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId));

        return row?.metadata;
    }

    describe('without a declaration', () =>
    {
        beforeAll(() =>
        {
            __resetProfileFieldsForTests();
        });

        it('P1: a free-form metadata PATCH replaces the stored object, as before', async () =>
        {
            await storeMetadata({ theme: 'dark', team: 'core' });

            const profile = await updateUserProfileService(userId, { metadata: { anything: { nested: true } } });

            expect(profile.metadata).toEqual({ anything: { nested: true } });
            expect(await storedMetadata()).toEqual({ anything: { nested: true } });
        });
    });

    describe('with a declaration', () =>
    {
        let app: Hono;

        beforeAll(async () =>
        {
            __resetProfileFieldsForTests();
            await initializeAuth({ profileFields: PROFILE_FIELDS });
            app = await mountAuthApp();
        });

        async function signIn(): Promise<string>
        {
            const key = generateKeyPair('ES256');
            const response = await app.request('/_auth/login', {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    email: 'fields@test.com',
                    password: PASSWORD,
                    publicKey: key.publicKey,
                    keyId: key.keyId,
                    fingerprint: key.fingerprint,
                    algorithm: key.algorithm,
                }),
            });

            expect(response.status).toBe(200);

            return `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`;
        }

        function patchProfile(authorization: string, body: unknown)
        {
            return app.request('/_auth/users/profile', {
                method: 'PATCH',
                headers: { ...JSON_HEADERS, Authorization: authorization },
                body: JSON.stringify(body),
            });
        }

        it('P2: a declared key is merged and the other stored keys stay', async () =>
        {
            await storeMetadata({ department: 'Research', github: 'ada' });

            const profile = await updateUserProfileService(userId, { metadata: { github: 'ada-l' } });

            expect(await storedMetadata()).toEqual({ department: 'Research', github: 'ada-l' });
            expect(profile.metadata).toEqual({ department: 'Research', github: 'ada-l', 'itFields.badgeCount': 0 });
        });

        it('P2: the merge creates the profile when there is none', async () =>
        {
            await updateUserProfileService(userId, { metadata: { department: 'Ops' } });

            expect(await storedMetadata()).toEqual({ department: 'Ops' });
        });

        it('P3: an undeclared key is a 400 and nothing changes', async () =>
        {
            await storeMetadata({ department: 'Research' });

            await expect(updateUserProfileService(userId, { displayName: 'Bea', metadata: { theme: 'dark' } }))
                .rejects.toMatchObject({ name: 'ValidationError', statusCode: 400 });

            const response = await patchProfile(await signIn(), { metadata: { department: 'Ops', theme: 'dark' } });

            expect(response.status).toBe(400);
            expect(await storedMetadata()).toEqual({ department: 'Research' });
            const [row] = await getTestDb().select({ displayName: userProfiles.displayName }).from(userProfiles).where(eq(userProfiles.userId, userId));
            expect(row.displayName).toBe('Ada');
        });

        it('P4: a value failing its field\'s schema is a 400', async () =>
        {
            await storeMetadata({ github: 'ada' });

            await expect(updateUserProfileService(userId, { metadata: { github: 'not a handle!' } }))
                .rejects.toMatchObject({ statusCode: 400 });
            expect((await patchProfile(await signIn(), { metadata: { 'itFields.badgeCount': -1 } })).status).toBe(400);
            expect(await storedMetadata()).toEqual({ github: 'ada' });
        });

        it('P6: stored undeclared keys are left out of reads, reported once at boot, and kept', async () =>
        {
            await storeMetadata({ department: 'Research', theme: 'dark', 'itFields.badgeCount': 'many' });
            const warn = vi.spyOn(authLogger.service, 'warn');

            const { profile } = await getUserProfileService(userId);

            expect(profile!.metadata).toEqual({ department: 'Research', 'itFields.badgeCount': 0 });
            expect(Object.keys(profile!.metadata!)).not.toContain('theme');

            await initializeAuth();

            const reports = warn.mock.calls.filter(([message]) => /no profile field declares/.test(String(message)));
            expect(reports).toHaveLength(1);
            expect(String(reports[0][0])).toContain('theme (1)');
            expect(String(reports[0][0])).not.toContain('department');
            expect(await storedMetadata()).toEqual({ department: 'Research', theme: 'dark', 'itFields.badgeCount': 'many' });
        });
    });
});
