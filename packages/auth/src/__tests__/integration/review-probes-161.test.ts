/**
 * @spfn/auth - Review round 1 of PR #305 (fxylabs/spfn#161)
 *
 * Each test is one blocking finding of the review, named by its id (R1–R8):
 * what main (6aa55d97) or the design guarantees, driven against the real
 * schema. Keys this file declares carry the `itProbe.` prefix so they collide
 * with nothing another file declares.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { Type } from '@sinclair/typebox';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp } from '../helpers/oauth2';
import { userProfiles, userSettings, users } from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: vi.fn().mockResolvedValue({ success: true }),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { authLogger } = await import('@/server/logger');
const { getUserSetting, listUserSettings, setUserSetting } = await import('@/server/services/user-settings.service');
const {
    getUserProfileService,
    updateLocaleService,
    updateUserProfileService,
} = await import('@/server/services/user-profile.service');
const { resolveAuthenticatedUser } = await import('@/server/middleware/auth-profiles');
const { userProfilesRepository } = await import('@/server/repositories');
const { defineUserSettings } = await import('@/server/lib/user-settings');
const { __resetUserSettingsForTests } = await import('@/server/lib/user-settings/registry');
const {
    defineProfileFields,
    activeProfileFields,
    assertProfileFieldsPatch,
    __resetProfileFieldsForTests,
} = await import('@/server/lib/profile-fields');

const dbAvailable = await isDatabaseAvailable();

const PASSWORD = 'SecurePassword123!';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));

/** The backfill statements of the migration that creates user_settings */
function backfillStatements(): string[]
{
    const folder = readdirSync(MIGRATIONS_FOLDER)
        .find(name => readFileSync(join(MIGRATIONS_FOLDER, name, 'migration.sql'), 'utf8')
            .includes('CREATE TABLE "spfn_auth"."user_settings"'))!;

    return readFileSync(join(MIGRATIONS_FOLDER, folder, 'migration.sql'), 'utf8')
        .split('--> statement-breakpoint')
        .map(statement => statement.trim())
        .filter(statement => statement.startsWith('INSERT INTO "spfn_auth"."user_settings"'));
}

describe.skipIf(!dbAvailable)('review round 1 probes (#161)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        __resetUserSettingsForTests();
        __resetProfileFieldsForTests();
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        __resetUserSettingsForTests();
        __resetProfileFieldsForTests();
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    // ========================================================================
    // Fixtures
    // ========================================================================

    async function seedUser(email: string): Promise<number>
    {
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            roleId: (await getRoleByName('user'))!.id,
        }).returning();

        return row.id;
    }

    async function runBackfill(): Promise<void>
    {
        for (const statement of backfillStatements())
        {
            await getTestDb().execute(sql.raw(statement));
        }
    }

    async function storedSettings(owner: number)
    {
        return await getTestDb()
            .select({ key: userSettings.key, value: userSettings.value })
            .from(userSettings)
            .where(eq(userSettings.userId, owner));
    }

    async function storedMetadata(owner: number)
    {
        const [row] = await getTestDb()
            .select({ metadata: userProfiles.metadata })
            .from(userProfiles)
            .where(eq(userProfiles.userId, owner));

        return row?.metadata;
    }

    async function signIn(email: string): Promise<string>
    {
        const key = generateKeyPair('ES256');
        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                email,
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

    function call(method: string, path: string, authorization: string, body?: unknown)
    {
        return app.request(path, {
            method,
            headers: { ...JSON_HEADERS, Authorization: authorization },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }

    function staleWarnings(spy: { mock: { calls: unknown[][] } })
    {
        return spy.mock.calls.filter(([message]) => /fail the current schema/.test(String(message)));
    }

    /** A mutation attempt that may throw (no such function) or be a no-op; either is fine */
    function attempt(mutate: () => unknown): void
    {
        try
        {
            mutate();
        }
        catch
        {
            // a read-only facade has no mutator to call
        }
    }

    // ========================================================================
    // R1–R3: what main returned
    // ========================================================================

    it('R1: a backfilled timezone that fails the IANA check reads as UTC everywhere, with one warning a read', async () =>
    {
        await initializeAuth();
        const userId = await seedUser('tz-garbage@test.com');
        await getTestDb().insert(userProfiles).values({ userId, displayName: 'X', timezone: 'Mars/Olympus' });
        await runBackfill();
        expect(await storedSettings(userId)).toEqual([{ key: 'timezone', value: 'Mars/Olympus' }]);
        const warn = vi.spyOn(authLogger.service, 'warn');

        expect(await getUserSetting(userId, 'timezone')).toBe('UTC');
        expect(staleWarnings(warn)).toHaveLength(1);

        const listed = (await listUserSettings(userId)).find(view => view.key === 'timezone');
        expect(listed).toMatchObject({ value: 'UTC', isDefault: true });
        expect(staleWarnings(warn)).toHaveLength(2);

        expect((await userProfilesRepository.fetchProfileData(userId))?.timezone).toBe('UTC');
        expect(staleWarnings(warn).map(([message]) => message)).toEqual(
            Array(3).fill('1 stored setting value(s) fail the current schema and read as the default: timezone'),
        );
    });

    it('R2: a blank timezone column is not copied by the backfill and still reads as UTC', async () =>
    {
        await initializeAuth();
        const empty = await seedUser('tz-empty@test.com');
        const spaces = await seedUser('tz-spaces@test.com');
        await getTestDb().insert(userProfiles).values([
            { userId: empty, displayName: 'X', timezone: '' },
            { userId: spaces, displayName: 'Y', timezone: '  ' },
        ]);

        await runBackfill();

        expect(await storedSettings(empty)).toEqual([]);
        expect(await storedSettings(spaces)).toEqual([]);
        expect((await userProfilesRepository.fetchProfileData(empty))?.timezone).toBe('UTC');
        expect((await userProfilesRepository.fetchProfileData(spaces))?.timezone).toBe('UTC');
    });

    it('R3: PATCH /locale creates the profile row main created, and leaves its locale column alone', async () =>
    {
        await initializeAuth();
        const userId = await seedUser('locale-only@test.com');

        const response = await call('PATCH', '/_auth/users/locale', await signIn('locale-only@test.com'), { locale: 'ko' });
        expect(response.status).toBe(200);

        const { profile } = await getUserProfileService(userId);
        expect({ displayName: profile?.displayName, locale: profile?.locale, chosenLocale: profile?.chosenLocale })
            .toEqual({ displayName: 'User', locale: 'ko', chosenLocale: 'ko' });

        const [row] = await getTestDb().select({ locale: userProfiles.locale }).from(userProfiles).where(eq(userProfiles.userId, userId));
        expect(row.locale).toBeNull();
    });

    // ========================================================================
    // R4–R5: declarations and the metadata merge
    // ========================================================================

    it('R4: a user settings declaration gains no key after install', async () =>
    {
        const declaration = defineUserSettings([{ key: 'itProbe.theme', schema: Type.String(), default: 'light' }]);
        await initializeAuth({ userSettings: declaration });
        const userId = await seedUser('frozen-settings@test.com');

        attempt(() => (declaration.entries as any).set('itProbe.late', { key: 'itProbe.late', schema: Type.String(), default: '' }));

        expect(declaration.entries.has('itProbe.late')).toBe(false);
        await expect(getUserSetting(userId, 'itProbe.late')).rejects.toMatchObject({ name: 'UserSettingNotDeclaredError' });
        expect(await getUserSetting(userId, 'itProbe.theme')).toBe('light');
    });

    it('R4: a profile fields declaration gains no key after install', async () =>
    {
        const declaration = defineProfileFields([{ key: 'itProbe.department', schema: Type.String() }]);
        await initializeAuth({ profileFields: declaration });

        attempt(() => (declaration.entries as any).set('itProbe.late', { key: 'itProbe.late', schema: Type.String() }));

        expect(declaration.entries.has('itProbe.late')).toBe(false);
        expect(() => assertProfileFieldsPatch(activeProfileFields()!, { 'itProbe.late': 'x' }))
            .toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it('R5: the declared metadata merge turns a stored scalar or array into an object', async () =>
    {
        await initializeAuth({ profileFields: defineProfileFields([{ key: 'department', schema: Type.String() }]) });
        const scalar = await seedUser('meta-scalar@test.com');
        const array = await seedUser('meta-array@test.com');
        await getTestDb().insert(userProfiles).values({ userId: scalar, displayName: 'X', metadata: sql`'1'::jsonb` as never });
        await getTestDb().insert(userProfiles).values({ userId: array, displayName: 'Y', metadata: sql`'[1,2]'::jsonb` as never });

        for (const owner of [scalar, array])
        {
            const profile = await updateUserProfileService(owner, { metadata: { department: 'Engineering' } });

            expect(profile.metadata).toEqual({ department: 'Engineering' });
            expect(await storedMetadata(owner)).toEqual({ department: 'Engineering' });
        }
    });

    // ========================================================================
    // R6–R8: limits and stale metadata
    // ========================================================================

    it('R6: a setting over 16 KiB, a metadata patch over 64 KiB and a 40-character locale are 400s, nothing written', async () =>
    {
        await initializeAuth({ userSettings: defineUserSettings([{ key: 'itProbe.notes', schema: Type.String(), default: '' }]) });
        const userId = await seedUser('limits@test.com');
        await getTestDb().insert(userProfiles).values({ userId, displayName: 'X', metadata: { kept: true } });

        await expect(setUserSetting(userId, 'itProbe.notes', 'a'.repeat(16 * 1024 - 1))).rejects.toMatchObject({ statusCode: 400 });
        expect(await storedSettings(userId)).toEqual([]);
        await setUserSetting(userId, 'itProbe.notes', 'a'.repeat(16 * 1024 - 2));
        expect(await storedSettings(userId)).toHaveLength(1);

        const overhead = JSON.stringify({ blob: '' }).length;
        await expect(updateUserProfileService(userId, { metadata: { blob: 'a'.repeat(64 * 1024 + 1 - overhead) } }))
            .rejects.toMatchObject({ statusCode: 400 });
        expect(await storedMetadata(userId)).toEqual({ kept: true });

        await expect(updateLocaleService(userId, 'a'.repeat(40))).rejects.toMatchObject({ statusCode: 400 });
        // The 64-character timezone cap is proved by C9 (review-probes-161-scoped.test.ts), which
        // spies on Intl.DateTimeFormat: no string over 64 characters can reach the IANA resolver
        // regardless of the cap, so a line here could not tell the cap apart from its absence.
        expect((await storedSettings(userId)).map(row => row.key)).toEqual(['itProbe.notes']);
    });

    it('R7: a NUL inside a string value is a 400, not a 500, and nothing is written', async () =>
    {
        await initializeAuth({ userSettings: defineUserSettings([{ key: 'itProbe.label', schema: Type.String(), default: '' }]) });
        const userId = await seedUser('nul@test.com');
        const authorization = await signIn('nul@test.com');

        await expect(setUserSetting(userId, 'itProbe.label', 'a\u0000b')).rejects.toMatchObject({ statusCode: 400 });
        expect((await call('PUT', '/_auth/users/settings/itProbe.label', authorization, { value: 'a\u0000b' })).status).toBe(400);
        expect(await storedSettings(userId)).toEqual([]);

        expect((await call('PATCH', '/_auth/users/profile', authorization, { metadata: { note: 'a\u0000b' } })).status).toBe(400);
        expect(await storedMetadata(userId)).toBeUndefined();
    });

    it('R7: a NUL inside a declared metadata value is refused by the patch check', async () =>
    {
        const fields = defineProfileFields([{ key: 'itProbe.tags', schema: Type.Array(Type.String()) }]);

        expect(() => assertProfileFieldsPatch(fields.entries, { 'itProbe.tags': ['ok', 'a\u0000b'] }))
            .toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it('R8: a stored declared metadata value failing its schema reads as the default, with one warning naming the key', async () =>
    {
        await initializeAuth({
            profileFields: defineProfileFields([{ key: 'itFields.level', schema: Type.Integer(), default: 1 }]),
        });
        const userId = await seedUser('stale-meta@test.com');
        await getTestDb().insert(userProfiles).values({ userId, displayName: 'X', metadata: { 'itFields.level': 'high' } });
        const warn = vi.spyOn(authLogger.service, 'warn');

        const profile = await userProfilesRepository.fetchProfileData(userId);

        expect(profile?.metadata?.['itFields.level']).toBe(1);
        expect(warn.mock.calls.map(([message]) => message).filter(message => String(message).includes('itFields.level'))).toEqual(
            ['1 stored profile field value(s) fail the current schema and read as the default: itFields.level'],
        );
    });

    it('R9: an over-long legacy locale row reads as "never chose" on the hot path and the profile alike', async () =>
    {
        await initializeAuth();
        const userId = await seedUser('long-locale@test.com');
        await getTestDb().insert(userProfiles).values({ userId, displayName: 'X' });
        await getTestDb().insert(userSettings).values({ userId, key: 'locale', value: 'a'.repeat(40) } as never);

        const resolved = await resolveAuthenticatedUser(userId);
        expect(resolved.chosenLocale).toBeNull();
        expect(resolved.locale).toBe('en');

        const { profile } = await getUserProfileService(userId);
        expect(profile?.chosenLocale).toBeNull();
    });
});
