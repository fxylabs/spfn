/**
 * @spfn/auth - Scoped review of the review-round-1 fix commit 542e9e95 (#161)
 *
 * Probes the reviewer wrote; each names the brief's claim it checks. Keys carry
 * the `itRv.` prefix so they collide with nothing another file declares.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
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
const { updateLocaleService, updateUserProfileService } = await import('@/server/services/user-profile.service');
const { userProfilesRepository, userSettingsRepository } = await import('@/server/repositories');
const { defineUserSettings } = await import('@/server/lib/user-settings');
const { __resetUserSettingsForTests } = await import('@/server/lib/user-settings/registry');
const { defineProfileFields, __resetProfileFieldsForTests } = await import('@/server/lib/profile-fields');

const dbAvailable = await isDatabaseAvailable();

const PASSWORD = 'SecurePassword123!';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe.skipIf(!dbAvailable)('scoped review probes of 542e9e95 (#161)', () =>
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

    function rawCall(method: string, path: string, authorization: string, rawBody: string)
    {
        return app.request(path, { method, headers: { ...JSON_HEADERS, Authorization: authorization }, body: rawBody });
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
        const [row] = await getTestDb().select({ metadata: userProfiles.metadata }).from(userProfiles).where(eq(userProfiles.userId, owner));

        return row?.metadata;
    }

    function staleWarnings(spy: { mock: { calls: unknown[][] } })
    {
        return spy.mock.calls.filter(([message]) => /fail the current schema/.test(String(message)));
    }

    // ------------------------------------------------------------------------
    // Claim 1: hot path
    // ------------------------------------------------------------------------

    it('C1: an authenticated request reads settings once, through findLocaleByUserId only', async () =>
    {
        await initializeAuth();
        await seedUser('hot@test.com');
        const authorization = await signIn('hot@test.com');
        // the middleware imports the repository through the package entry, not `@/server/repositories`
        const { userSettingsRepository: middlewareRepository } = await import('@spfn/auth/server');
        const findValue = vi.spyOn(middlewareRepository, 'findValue');
        const byKeys = vi.spyOn(middlewareRepository, 'listByUserAndKeys');
        const byUser = vi.spyOn(middlewareRepository, 'listByUser');
        const byLocale = vi.spyOn(middlewareRepository, 'findLocaleByUserId');

        const response = await app.request('/_auth/mfa/status', { headers: { Authorization: authorization } });

        expect(response.status).toBe(200);
        const counts = {
            byLocale: byLocale.mock.calls.length,
            findValue: findValue.mock.calls.length,
            byKeys: byKeys.mock.calls.length,
            byUser: byUser.mock.calls.length,
        };
        // findValue is reached through `this` inside the spied findLocaleByUserId wrapper
        expect(counts).toEqual({ byLocale: 1, findValue: 1, byKeys: 0, byUser: 0 });
    });

    // ------------------------------------------------------------------------
    // Claim 3: immutability
    // ------------------------------------------------------------------------

    it('C3a: the schema reachable through the installed facade cannot be loosened after install', async () =>
    {
        const declaration = defineUserSettings([{ key: 'itRv.code', schema: Type.String({ maxLength: 3 }), default: 'abc' }]);
        await initializeAuth({ userSettings: declaration });
        const userId = await seedUser('schema-mutate@test.com');

        try
        {
            (declaration.entries.get('itRv.code')!.schema as any).maxLength = 1000;
        }
        catch
        {
            // a deep-frozen schema refuses the write: that is the pass
        }

        await expect(setUserSetting(userId, 'itRv.code', 'way-too-long')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('C3b: a profile field schema reachable through the facade cannot be loosened after install', async () =>
    {
        const fields = defineProfileFields([{ key: 'itRv.level', schema: Type.Integer({ maximum: 5 }) }]);
        await initializeAuth({ profileFields: fields });
        const userId = await seedUser('field-mutate@test.com');

        try
        {
            (fields.entries.get('itRv.level')!.schema as any).maximum = 1000;
        }
        catch
        {
            // frozen: pass
        }

        await expect(updateUserProfileService(userId, { metadata: { 'itRv.level': 999 } })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('C3c: a caller mutating what getUserSetting returned does not change the default for everyone', async () =>
    {
        await initializeAuth({
            userSettings: defineUserSettings([{
                key: 'itRv.tags',
                schema: Type.Object({ tags: Type.Array(Type.String()) }),
                default: { tags: [] },
            }]),
        });
        const alice = await seedUser('alice@test.com');
        const bob = await seedUser('bob@test.com');

        const mine = await getUserSetting(alice, 'itRv.tags') as { tags: string[] };
        try
        {
            mine.tags.push('leaked');
        }
        catch
        {
            // a frozen default refuses the push: pass
        }

        expect(await getUserSetting(bob, 'itRv.tags')).toEqual({ tags: [] });
    });

    it('C3d: the facade exposes no mutator, and keys() is an iterator over a private map', async () =>
    {
        const declaration = defineUserSettings([{ key: 'itRv.a', schema: Type.String(), default: '' }]);

        expect(Object.isFrozen(declaration.entries)).toBe(true);
        expect(Object.isFrozen(declaration.entries.get('itRv.a'))).toBe(true);
        expect(Object.getPrototypeOf(declaration.entries)).toBe(Object.prototype);
        expect(Array.isArray(declaration.entries.keys())).toBe(false);
        expect((declaration.entries as any).set).toBeUndefined();
        expect((declaration.entries as any).delete).toBeUndefined();
    });

    // ------------------------------------------------------------------------
    // Claim 4: size caps
    // ------------------------------------------------------------------------

    it('C4: the 16 KiB cap is UTF-8 bytes, checked before any DB call', async () =>
    {
        await initializeAuth({ userSettings: defineUserSettings([{ key: 'itRv.notes', schema: Type.String(), default: '' }]) });
        const userId = await seedUser('bytes@test.com');
        const upsert = vi.spyOn(userSettingsRepository, 'upsert');

        // 6000 characters, 18000 bytes: over by bytes, under by characters
        await expect(setUserSetting(userId, 'itRv.notes', '한'.repeat(6000))).rejects.toMatchObject({ statusCode: 400 });
        expect(upsert).not.toHaveBeenCalled();
        expect(await storedSettings(userId)).toEqual([]);
    });

    it('C4: declared metadata grows past 64 KiB through merges each under the cap (documented: pre-merge)', async () =>
    {
        await initializeAuth({ profileFields: defineProfileFields([
            { key: 'itRv.a', schema: Type.String() },
            { key: 'itRv.b', schema: Type.String() },
        ]) });
        const userId = await seedUser('grow@test.com');

        await updateUserProfileService(userId, { metadata: { 'itRv.a': 'a'.repeat(60 * 1024) } });
        await updateUserProfileService(userId, { metadata: { 'itRv.b': 'b'.repeat(60 * 1024) } });

        expect(Buffer.byteLength(JSON.stringify(await storedMetadata(userId)))).toBeGreaterThan(64 * 1024);
    });

    // ------------------------------------------------------------------------
    // Claim 5: NUL walk, through the HTTP route with the JSON escape
    // ------------------------------------------------------------------------

    it('C5: NUL deep in arrays/objects/keys, sent as the JSON escape, is a 400 on both routes', async () =>
    {
        await initializeAuth({ userSettings: defineUserSettings([{ key: 'itRv.any', schema: Type.Unknown(), default: null }]) });
        const userId = await seedUser('nul-deep@test.com');
        const authorization = await signIn('nul-deep@test.com');
        const nestedValue = '{"value":{"a":[[{"b":["ok","x\\u0000y"]}]]}}';
        const nulKey = '{"value":{"k\\u0000":1}}';
        const metadataDeep = '{"metadata":{"a":[{"b":[["x\\u0000"]]}]}}';
        const metadataKey = '{"metadata":{"nest":{"k\\u0000":true}}}';

        for (const body of [nestedValue, nulKey])
        {
            expect((await rawCall('PUT', '/_auth/users/settings/itRv.any', authorization, body)).status).toBe(400);
        }
        for (const body of [metadataDeep, metadataKey])
        {
            expect((await rawCall('PATCH', '/_auth/users/profile', authorization, body)).status).toBe(400);
        }
        expect(await storedSettings(userId)).toEqual([]);
        expect(await storedMetadata(userId)).toBeUndefined();
    });

    // ------------------------------------------------------------------------
    // Claim 6: read path
    // ------------------------------------------------------------------------

    it('C6: stale rows read as default with updatedAt null, one warning per list; an undeclared row is ignored', async () =>
    {
        await initializeAuth({ userSettings: defineUserSettings([{ key: 'itRv.n', schema: Type.Integer(), default: 7 }]) });
        const userId = await seedUser('stale@test.com');
        await getTestDb().insert(userSettings).values([
            { userId, key: 'itRv.n', value: 'not-a-number' },
            { userId, key: 'timezone', value: 'Mars/Olympus' },
            { userId, key: 'itRv.gone', value: 'left by an old deploy' },
        ] as never);
        const warn = vi.spyOn(authLogger.service, 'warn');

        const listed = await listUserSettings(userId);

        expect(listed.map(view => view.key).sort()).toEqual(['itRv.n', 'locale', 'timezone']);
        expect(listed.find(view => view.key === 'itRv.n')).toEqual({ key: 'itRv.n', value: 7, isDefault: true, updatedAt: null });
        expect(listed.find(view => view.key === 'timezone')).toEqual({ key: 'timezone', value: 'UTC', isDefault: true, updatedAt: null });
        expect(staleWarnings(warn)).toHaveLength(1);
        expect(String(staleWarnings(warn)[0][0])).toMatch(/^2 stored setting/);
        await expect(getUserSetting(userId, 'itRv.gone')).rejects.toMatchObject({ name: 'UserSettingNotDeclaredError' });
    });

    // ------------------------------------------------------------------------
    // Claim 7: R3 transaction and idempotence
    // ------------------------------------------------------------------------

    it('C7: two concurrent PATCH /locale both succeed and leave one profile row', async () =>
    {
        await initializeAuth();
        const userId = await seedUser('twice@test.com');
        const authorization = await signIn('twice@test.com');
        const patch = (locale: string) => app.request('/_auth/users/locale', {
            method: 'PATCH',
            headers: { ...JSON_HEADERS, Authorization: authorization },
            body: JSON.stringify({ locale }),
        });

        const statuses = (await Promise.all([patch('ko'), patch('ja'), patch('en'), patch('ko')])).map(response => response.status);

        expect(statuses).toEqual([200, 200, 200, 200]);
        const profiles = await getTestDb().select().from(userProfiles).where(eq(userProfiles.userId, userId));
        expect(profiles).toHaveLength(1);
        expect((await storedSettings(userId)).map(row => row.key)).toEqual(['locale']);
    });

    it('C7: when the profile row creation fails, the locale setting is rolled back', async () =>
    {
        await initializeAuth();
        const userId = await seedUser('rollback@test.com');
        vi.spyOn(userProfilesRepository, 'createIfAbsent').mockRejectedValueOnce(new Error('boom'));

        await expect(updateLocaleService(userId, 'ko')).rejects.toThrow('boom');
        expect(await storedSettings(userId)).toEqual([]);
    });

    // ------------------------------------------------------------------------
    // Claim 8: R5 under concurrency
    // ------------------------------------------------------------------------

    it('C8: concurrent declared-field patches on a legacy scalar metadata both land', async () =>
    {
        await initializeAuth({ profileFields: defineProfileFields([
            { key: 'itRv.x', schema: Type.String() },
            { key: 'itRv.y', schema: Type.String() },
        ]) });

        for (let round = 0; round < 5; round++)
        {
            const userId = await seedUser(`race${round}@test.com`);
            await getTestDb().insert(userProfiles).values({ userId, displayName: 'X', metadata: sql`'"legacy"'::jsonb` as never });

            await Promise.all([
                updateUserProfileService(userId, { metadata: { 'itRv.x': 'one' } }),
                updateUserProfileService(userId, { metadata: { 'itRv.y': 'two' } }),
            ]);

            expect(await storedMetadata(userId)).toEqual({ 'itRv.x': 'one', 'itRv.y': 'two' });
        }
    });

    // ------------------------------------------------------------------------
    // Claim 9: does the R6 timezone line prove the 64 cap?
    // ------------------------------------------------------------------------

    it('C9: a 65-character timezone is refused before the IANA resolver runs (proves maxLength 64)', async () =>
    {
        await initializeAuth();
        const userId = await seedUser('tz-cap@test.com');
        const resolver = vi.spyOn(Intl, 'DateTimeFormat');

        await expect(setUserSetting(userId, 'timezone', `Asia/${'a'.repeat(60)}`)).rejects.toMatchObject({ statusCode: 400 });
        expect(resolver).not.toHaveBeenCalled();
    });
});
