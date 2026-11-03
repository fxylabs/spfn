/**
 * User Settings Repository
 *
 * Rows of `spfn_auth.user_settings`, one per (user, key). Knows nothing about
 * declarations or schemas: the settings service decides what a key may hold,
 * this class only stores and reads what it was given.
 */

import { and, count, eq, sql } from 'drizzle-orm';
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
