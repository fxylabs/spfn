/**
 * User Settings Repository
 *
 * Rows of `spfn_auth.user_settings`, one per (user, key). Knows nothing about
 * declarations or schemas: the settings service decides what a key may hold,
 * this class only stores and reads what it was given.
 */

import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { BaseRepository } from '@spfn/core/db';
import { userSettings } from '../entities/user-settings';

export interface StoredUserSetting
{
    key: string;
    value: unknown;
    updatedAt: Date;
}

/**
 * A JSON `null` has to be written as the literal: a bare `null` parameter is
 * SQL NULL, which the NOT NULL column refuses.
 */
function jsonbValue(value: unknown)
{
    return value === null ? sql`'null'::jsonb` : value;
}

export class UserSettingsRepository extends BaseRepository
{
    /**
     * One stored setting, or null when the person has no row for the key
     */
    async findValue(userId: number, key: string): Promise<StoredUserSetting | null>
    {
        const result = await this.readDb
            .select({ key: userSettings.key, value: userSettings.value, updatedAt: userSettings.updatedAt })
            .from(userSettings)
            .where(and(eq(userSettings.userId, userId), eq(userSettings.key, key)))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * The stored language choice, or null when none was made
     *
     * The principal's locale is read on every authenticated request, so this is
     * the one unique-index lookup and nothing else. A stored value that is not
     * a string reads as "never chose".
     */
    async findLocaleByUserId(userId: number): Promise<string | null>
    {
        const stored = await this.findValue(userId, 'locale');

        return typeof stored?.value === 'string' ? stored.value : null;
    }

    /**
     * The two built-in keys the profile response still carries (deprecated
     * there), in one query: the language choice, null when none was made, and
     * the timezone, 'UTC' when none was set
     */
    async findLocaleAndTimezone(userId: number): Promise<{ chosenLocale: string | null; timezone: string }>
    {
        const rows = await this.readDb
            .select({ key: userSettings.key, value: userSettings.value })
            .from(userSettings)
            .where(and(eq(userSettings.userId, userId), inArray(userSettings.key, ['locale', 'timezone'])));
        const valueOf = (key: string) => rows.find(row => row.key === key)?.value;
        const locale = valueOf('locale');
        const timezone = valueOf('timezone');

        return {
            chosenLocale: typeof locale === 'string' ? locale : null,
            timezone: typeof timezone === 'string' ? timezone : 'UTC',
        };
    }

    /**
     * Every stored setting of one person
     */
    async listByUser(userId: number): Promise<StoredUserSetting[]>
    {
        return await this.readDb
            .select({ key: userSettings.key, value: userSettings.value, updatedAt: userSettings.updatedAt })
            .from(userSettings)
            .where(eq(userSettings.userId, userId));
    }

    /**
     * Insert or overwrite the value of (user, key)
     */
    async upsert(userId: number, key: string, value: unknown, updatedBy: number | null): Promise<void>
    {
        await this.db
            .insert(userSettings)
            .values({ userId, key, value: jsonbValue(value), updatedBy })
            .onConflictDoUpdate({
                target: [userSettings.userId, userSettings.key],
                set: { value: jsonbValue(value), updatedBy, updatedAt: sql`now()` },
            });
    }

    /**
     * Delete the row of (user, key); the key reads as its default afterwards
     */
    async deleteOne(userId: number, key: string): Promise<void>
    {
        await this.db
            .delete(userSettings)
            .where(and(eq(userSettings.userId, userId), eq(userSettings.key, key)));
    }

    /**
     * Delete every setting of one person (account anonymization)
     */
    async deleteAllByUserId(userId: number): Promise<void>
    {
        await this.db
            .delete(userSettings)
            .where(eq(userSettings.userId, userId));
    }

    /**
     * Rows per stored key across everyone, for the boot reconcile
     */
    async countByKey(): Promise<Array<{ key: string; count: number }>>
    {
        return await this.readDb
            .select({ key: userSettings.key, count: count() })
            .from(userSettings)
            .groupBy(userSettings.key);
    }
}

export const userSettingsRepository = new UserSettingsRepository();
