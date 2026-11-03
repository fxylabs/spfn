/**
 * @spfn/auth - Profile locale: "chose a language" versus "never chose" (fxylabs/spfn#110)
 *
 * `locale` keeps answering `'en'` when nothing was chosen; `chosenLocale` is the
 * stored choice itself, `null` when there is none. Each test is one cell of the
 * design's case table, driven against the real schema so the dropped column
 * default is part of what is tested.
 *
 * Since #161 the choice is the built-in `locale` setting: a `user_settings` row,
 * and no row when nothing was chosen. The profile column is neither read nor
 * written any more, so these tests store and inspect the settings row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users, userProfiles, userSettings } from '@/server/entities';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { resolveAuthenticatedUser } = await import('@/server/middleware/auth-profiles');
const { userProfilesRepository } = await import('@/server/repositories');
const {
    getUserProfileService,
    updateLocaleService,
    updateUserProfileService,
} = await import('@/server/services/user-profile.service');

const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)('profile locale (case table #110)', () =>
{
    let userId: number;

    beforeAll(async () =>
    {
        await setupTestDb();
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

        const [row] = await db.insert(users).values({
            email: 'locale@test.com',
            roleId: (await getRoleByName('user'))!.id,
        }).returning();
        userId = row.id;
    });

    async function storeLocale(locale: string | null)
    {
        await getTestDb().insert(userProfiles).values({ userId });
        if (locale !== null)
        {
            await getTestDb().insert(userSettings).values({ userId, key: 'locale', value: locale });
        }
    }

    /** The stored choice: the settings row's value, null when there is no row */
    async function storedLocale()
    {
        const [row] = await getTestDb()
            .select({ value: userSettings.value })
            .from(userSettings)
            .where(and(eq(userSettings.userId, userId), eq(userSettings.key, 'locale')));

        return row ? row.value : null;
    }

    async function resolved()
    {
        const { locale, chosenLocale } = await resolveAuthenticatedUser(userId);

        return { locale, chosenLocale };
    }

    it('1: with no profile row, locale falls back and nothing is chosen', async () =>
    {
        expect(await resolved()).toEqual({ locale: 'en', chosenLocale: null });
        expect((await getUserProfileService(userId)).profile).toBeNull();
    });

    it('2: a NULL locale reads as "never chose"', async () =>
    {
        await storeLocale(null);

        expect(await resolved()).toEqual({ locale: 'en', chosenLocale: null });
        expect(await userProfilesRepository.fetchProfileData(userId))
            .toMatchObject({ locale: 'en', chosenLocale: null });
    });

    it('3: a stored choice reads back as both values', async () =>
    {
        await storeLocale('ko');

        expect(await resolved()).toEqual({ locale: 'ko', chosenLocale: 'ko' });
        expect(await userProfilesRepository.fetchProfileData(userId))
            .toMatchObject({ locale: 'ko', chosenLocale: 'ko' });
    });

    it('4: a legacy stored "en" still reads as a choice', async () =>
    {
        await storeLocale('en');

        expect(await resolved()).toEqual({ locale: 'en', chosenLocale: 'en' });
    });

    it('5: PATCH locale stores the choice', async () =>
    {
        expect(await updateLocaleService(userId, 'ko')).toEqual({ locale: 'ko', chosenLocale: 'ko' });
        expect(await storedLocale()).toBe('ko');
    });

    it('6: PATCH locale null clears the choice', async () =>
    {
        await storeLocale('ko');

        expect(await updateLocaleService(userId, null)).toEqual({ locale: 'en', chosenLocale: null });
        expect(await storedLocale()).toBeNull();
    });

    it('7: PATCH locale with only whitespace clears the choice', async () =>
    {
        await storeLocale('ko');

        expect(await updateLocaleService(userId, '  ')).toEqual({ locale: 'en', chosenLocale: null });
        expect(await storedLocale()).toBeNull();
    });

    it('8: PATCH locale trims the choice', async () =>
    {
        await storeLocale('ko');

        expect(await updateLocaleService(userId, ' ja ')).toEqual({ locale: 'ja', chosenLocale: 'ja' });
        expect(await storedLocale()).toBe('ja');
    });

    it('9: creating a profile without a locale stores no choice', async () =>
    {
        const profile = await updateUserProfileService(userId, { displayName: 'Ada' });

        expect(profile).toMatchObject({ displayName: 'Ada', locale: 'en', chosenLocale: null });
        expect(await storedLocale()).toBeNull();
    });

    it('10: a profile update with an empty locale clears the choice', async () =>
    {
        await storeLocale('ko');

        const profile = await updateUserProfileService(userId, { locale: '' });

        expect(profile).toMatchObject({ locale: 'en', chosenLocale: null });
        expect(await storedLocale()).toBeNull();
    });

    it('D7: the profile response keeps its shape and values for a user with a chosen locale', async () =>
    {
        await storeLocale('ko');

        const profile = (await getUserProfileService(userId)).profile!;

        // The key order is the pre-#161 response's, so the serialized body is byte-identical.
        expect(Object.keys(profile)).toEqual([
            'profileId', 'displayName', 'firstName', 'lastName', 'avatarUrl', 'bio',
            'locale', 'chosenLocale', 'timezone',
            'website', 'location', 'company', 'jobTitle', 'metadata', 'createdAt', 'updatedAt',
        ]);
        expect(profile).toMatchObject({ locale: 'ko', chosenLocale: 'ko', timezone: 'UTC', metadata: null });
    });
});
