/**
 * @spfn/auth - Per-person settings declared in code (fxylabs/spfn#161)
 *
 * Each test is one row of the design's case table (§9), driven against the real
 * schema: through the service functions, and through the four self-only routes
 * where the row is about what a caller can reach. Keys this file declares carry
 * the `itSettings.` prefix so they collide with nothing another file declares.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { Type } from '@sinclair/typebox';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp } from '../helpers/oauth2';
import { accountDeletionRequests, userProfiles, userSettings, users } from '@/server/entities';
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
const { resolveAuthenticatedUser } = await import('@/server/middleware/auth-profiles');
const { authLogger } = await import('@/server/logger');
const { configureDeletion } = await import('@/server/lib/deletion-config');
const { purgeUserService } = await import('@/server/services/account-deletion.service');
const { updateLocaleService, updateUserProfileService } = await import('@/server/services/user-profile.service');
const {
    getUserSetting,
    setUserSetting,
    listUserSettings,
    resetUserSetting,
} = await import('@/server/services/user-settings.service');
const { defineUserSettings } = await import('@/server/lib/user-settings');
const { __resetUserSettingsForTests } = await import('@/server/lib/user-settings/registry');

const dbAvailable = await isDatabaseAvailable();

const PASSWORD = 'SecurePassword123!';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const SETTINGS = defineUserSettings([
    {
        key: 'itSettings.digest',
        schema: Type.Union([Type.Literal('daily'), Type.Literal('weekly'), Type.Literal('off')]),
        default: 'daily',
    },
    { key: 'itSettings.lastTemplate', schema: Type.Union([Type.String(), Type.Null()]), default: 'blank' },
]);

describe.skipIf(!dbAvailable)('per-person settings (case table #161)', () =>
{
    let app: Hono;
    let userId: number;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        __resetUserSettingsForTests();
        await initializeAuth({ userSettings: SETTINGS });
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        __resetUserSettingsForTests();
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        configureDeletion();
        userId = await seedUser('settings@test.com');
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

    async function storeSetting(owner: number, key: string, value: unknown)
    {
        await getTestDb().insert(userSettings).values({ userId: owner, key, value });
    }

    async function storedRows(owner: number)
    {
        return await getTestDb()
            .select({ key: userSettings.key, value: userSettings.value, updatedBy: userSettings.updatedBy })
            .from(userSettings)
            .where(eq(userSettings.userId, owner));
    }

    async function storedValue(owner: number, key: string)
    {
        const [row] = await getTestDb()
            .select({ value: userSettings.value })
            .from(userSettings)
            .where(and(eq(userSettings.userId, owner), eq(userSettings.key, key)));

        return row;
    }

    async function markDueForPurge(owner: number)
    {
        const [user] = await getTestDb()
            .update(users)
            .set({ status: 'pending_deletion' })
            .where(eq(users.id, owner))
            .returning();

        await getTestDb().insert(accountDeletionRequests).values({
            userId: owner,
            userPublicId: user.publicId,
            purgeScheduledAt: new Date(Date.now() - 1000),
        });
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

    function warnings(pattern: RegExp, spy: { mock: { calls: unknown[][] } })
    {
        return spy.mock.calls.filter(([message]) => pattern.test(String(message)));
    }

    // ========================================================================
    // S1–S6: reading and writing through the service
    // ========================================================================

    it('S1: a declared key with no row reads as its default and lists as default', async () =>
    {
        expect(await getUserSetting(userId, 'itSettings.digest')).toBe('daily');
        expect((await listUserSettings(userId)).find(view => view.key === 'itSettings.digest'))
            .toEqual({ key: 'itSettings.digest', value: 'daily', isDefault: true, updatedAt: null });
    });

    it('S2: a declared key with a row reads as the stored value', async () =>
    {
        await setUserSetting(userId, 'itSettings.digest', 'weekly', { by: userId });

        expect(await getUserSetting(userId, 'itSettings.digest')).toBe('weekly');
        expect(await SETTINGS.get(userId, 'itSettings.digest')).toBe('weekly');
        expect((await listUserSettings(userId)).find(view => view.key === 'itSettings.digest'))
            .toMatchObject({ value: 'weekly', isDefault: false, updatedAt: expect.any(Date) });
        expect(await storedRows(userId)).toEqual([{ key: 'itSettings.digest', value: 'weekly', updatedBy: userId }]);
    });

    it('S3: an undeclared key is a 404 on get, set and reset, and nothing is written', async () =>
    {
        await expect(getUserSetting(userId, 'itSettings.nope')).rejects.toMatchObject({ name: 'UserSettingNotDeclaredError', statusCode: 404 });
        await expect(setUserSetting(userId, 'itSettings.nope', 'x')).rejects.toMatchObject({ statusCode: 404 });
        await expect(resetUserSetting(userId, 'itSettings.nope')).rejects.toMatchObject({ statusCode: 404 });
        expect(await storedRows(userId)).toEqual([]);

        const authorization = await signIn('settings@test.com');

        expect((await call('GET', '/_auth/users/settings/itSettings.nope', authorization)).status).toBe(404);
        expect((await call('PUT', '/_auth/users/settings/itSettings.nope', authorization, { value: 'x' })).status).toBe(404);
        expect(await storedRows(userId)).toEqual([]);
    });

    it('S4: a value failing the schema is a 400 and leaves the row as it was', async () =>
    {
        await setUserSetting(userId, 'itSettings.digest', 'weekly');

        await expect(setUserSetting(userId, 'itSettings.digest', 'hourly')).rejects.toMatchObject({ name: 'ValidationError', statusCode: 400 });
        expect(await storedValue(userId, 'itSettings.digest')).toEqual({ value: 'weekly' });

        const response = await call('PUT', '/_auth/users/settings/itSettings.digest', await signIn('settings@test.com'), { value: 42 });

        expect(response.status).toBe(400);
        expect(await storedValue(userId, 'itSettings.digest')).toEqual({ value: 'weekly' });
    });

    it('S5: writing the default deletes the row', async () =>
    {
        await setUserSetting(userId, 'itSettings.digest', 'weekly');
        await setUserSetting(userId, 'itSettings.digest', 'daily');

        expect(await storedValue(userId, 'itSettings.digest')).toBeUndefined();
        expect(await getUserSetting(userId, 'itSettings.digest')).toBe('daily');
    });

    it('S5 (D1): a JSON null that is not the default is stored as JSON null', async () =>
    {
        await setUserSetting(userId, 'itSettings.lastTemplate', null);

        expect(await storedValue(userId, 'itSettings.lastTemplate')).toEqual({ value: null });
        expect(await getUserSetting(userId, 'itSettings.lastTemplate')).toBeNull();
    });

    it('S6: a stored value failing the current schema reads as the default, warns once, and stays', async () =>
    {
        await storeSetting(userId, 'itSettings.digest', 'hourly');
        const warn = vi.spyOn(authLogger.service, 'warn');

        expect(await getUserSetting(userId, 'itSettings.digest')).toBe('daily');

        const stale = warnings(/fail the current schema/, warn);
        expect(stale).toHaveLength(1);
        expect(String(stale[0][0])).not.toContain(String(userId));
        expect(await storedValue(userId, 'itSettings.digest')).toEqual({ value: 'hourly' });
        expect((await listUserSettings(userId)).find(view => view.key === 'itSettings.digest'))
            .toMatchObject({ value: 'daily', isDefault: true });
    });

    // ========================================================================
    // S8–S9: boot
    // ========================================================================

    it('S8: installing a declaration once boot has completed throws', async () =>
    {
        await expect(initializeAuth({ userSettings: defineUserSettings([]) })).rejects.toThrow(/already installed/);
    });

    it('S9: boot reports stored keys nobody declares once, with counts, and keeps the rows', async () =>
    {
        const other = await seedUser('other@test.com');
        await storeSetting(userId, 'itSettings.gone', true);
        await storeSetting(other, 'itSettings.gone', false);
        await storeSetting(userId, 'itSettings.digest', 'weekly');
        const warn = vi.spyOn(authLogger.service, 'warn');

        await initializeAuth();

        const reports = warnings(/no declaration names/, warn);
        expect(reports).toHaveLength(1);
        expect(String(reports[0][0])).toContain('itSettings.gone (2)');
        expect(String(reports[0][0])).not.toContain('itSettings.digest');
        expect(await storedRows(userId)).toHaveLength(2);
        expect(await storedRows(other)).toHaveLength(1);
    });

    // ========================================================================
    // S10–S14: the built-in keys
    // ========================================================================

    it('S10: with no locale row the principal falls back to en and has no choice, whatever the old column says', async () =>
    {
        await getTestDb().insert(userProfiles).values({ userId, locale: 'ja' });

        expect(await resolveAuthenticatedUser(userId)).toMatchObject({ locale: 'en', chosenLocale: null });
    });

    it('S11: a locale row of ko is the principal\'s locale and choice', async () =>
    {
        await getTestDb().insert(userProfiles).values({ userId, locale: null });
        await storeSetting(userId, 'locale', 'ko');

        expect(await resolveAuthenticatedUser(userId)).toMatchObject({ locale: 'ko', chosenLocale: 'ko' });
    });

    it('S12: PATCH locale ko writes the settings row and leaves the profile column alone', async () =>
    {
        await getTestDb().insert(userProfiles).values({ userId, locale: null });

        const response = await call('PATCH', '/_auth/users/locale', await signIn('settings@test.com'), { locale: 'ko' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ locale: 'ko', chosenLocale: 'ko' });
        expect(await storedValue(userId, 'locale')).toEqual({ value: 'ko' });

        const [profile] = await getTestDb().select({ locale: userProfiles.locale }).from(userProfiles).where(eq(userProfiles.userId, userId));
        expect(profile.locale).toBeNull();
    });

    it('S13: PATCH locale null deletes the settings row and clears the choice', async () =>
    {
        await getTestDb().insert(userProfiles).values({ userId, locale: 'ko' });
        await storeSetting(userId, 'locale', 'ko');

        const response = await call('PATCH', '/_auth/users/locale', await signIn('settings@test.com'), { locale: null });

        expect(await response.json()).toEqual({ locale: 'en', chosenLocale: null });
        expect(await storedValue(userId, 'locale')).toBeUndefined();
        expect(await resolveAuthenticatedUser(userId)).toMatchObject({ chosenLocale: null });
        expect(await updateLocaleService(userId, '  ')).toEqual({ locale: 'en', chosenLocale: null });
    });

    it('S14: a timezone that is not an IANA zone is a 400 on every write path', async () =>
    {
        const authorization = await signIn('settings@test.com');

        await expect(setUserSetting(userId, 'timezone', 'Mars/Olympus')).rejects.toMatchObject({ statusCode: 400 });
        expect((await call('PUT', '/_auth/users/settings/timezone', authorization, { value: 'Mars/Olympus' })).status).toBe(400);
        expect((await call('PATCH', '/_auth/users/profile', authorization, { timezone: 'Mars/Olympus' })).status).toBe(400);
        expect(await storedValue(userId, 'timezone')).toBeUndefined();

        await setUserSetting(userId, 'timezone', 'Asia/Seoul');
        expect(await storedValue(userId, 'timezone')).toEqual({ value: 'Asia/Seoul' });
        await setUserSetting(userId, 'timezone', 'UTC');
        expect(await storedValue(userId, 'timezone')).toBeUndefined();
        expect((await updateUserProfileService(userId, { timezone: 'Asia/Seoul' })).timezone).toBe('Asia/Seoul');
    });

    // ========================================================================
    // S15–S16: whose rows
    // ========================================================================

    it('S15: the routes reach only the caller\'s own settings', async () =>
    {
        const other = await seedUser('other@test.com');
        await storeSetting(other, 'itSettings.digest', 'off');
        const authorization = await signIn('settings@test.com');

        const put = await call('PUT', '/_auth/users/settings/itSettings.digest', authorization, { value: 'weekly' });
        expect(put.status).toBe(200);
        expect(await put.json()).toEqual({ key: 'itSettings.digest', value: 'weekly' });

        const list = await (await call('GET', '/_auth/users/settings', authorization)).json();
        expect(list.settings.map((view: { key: string }) => view.key))
            .toEqual(['locale', 'timezone', 'itSettings.digest', 'itSettings.lastTemplate']);
        expect(list.settings.find((view: { key: string }) => view.key === 'itSettings.digest'))
            .toMatchObject({ value: 'weekly', isDefault: false });

        const one = await (await call('GET', '/_auth/users/settings/itSettings.digest', authorization)).json();
        expect(one).toEqual({ key: 'itSettings.digest', value: 'weekly' });

        expect((await call('DELETE', '/_auth/users/settings/itSettings.digest', authorization)).status).toBe(204);
        expect(await storedValue(userId, 'itSettings.digest')).toBeUndefined();
        expect(await storedValue(other, 'itSettings.digest')).toEqual({ value: 'off' });

        expect((await app.request('/_auth/users/settings')).status).toBe(401);
    });

    it('S16: a hard-delete purge removes the person\'s settings with the users row', async () =>
    {
        configureDeletion({ purgeStrategy: 'hard-delete' });
        await storeSetting(userId, 'itSettings.digest', 'weekly');
        await markDueForPurge(userId);

        expect(await purgeUserService(userId)).toEqual({ outcome: 'purged' });
        expect(await getTestDb().select().from(userSettings)).toEqual([]);
    });

    it('S16: an anonymizing purge deletes the person\'s settings and keeps the users row', async () =>
    {
        await storeSetting(userId, 'itSettings.digest', 'weekly');
        await markDueForPurge(userId);

        expect(await purgeUserService(userId)).toEqual({ outcome: 'purged' });
        expect(await storedRows(userId)).toEqual([]);
        expect(await getTestDb().select({ id: users.id }).from(users)).toEqual([{ id: userId }]);
    });
});
