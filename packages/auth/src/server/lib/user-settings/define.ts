/**
 * @spfn/auth - defineUserSettings
 */

import type { Static } from '@sinclair/typebox';
import { indexDeclaredEntries, type DeclaredEntries } from '../declared-keys';
import {
    getUserSetting,
    listUserSettings,
    setUserSetting,
} from '../../services/user-settings.service';
import {
    BUILTIN_USER_SETTING_KEYS,
    type SetUserSettingOptions,
    type UserSettingEntry,
    type UserSettingView,
} from './registry';

type UserId = string | number | bigint;

type DeclaredKey<TEntries extends readonly UserSettingEntry[]> = TEntries[number]['key'];

type DeclaredValue<TEntries extends readonly UserSettingEntry[], TKey> =
    Static<Extract<TEntries[number], { key: TKey }>['schema']>;

/**
 * A frozen set of per-person setting declarations, with typed access to them
 */
export interface UserSettingsDeclaration<TEntries extends readonly UserSettingEntry[] = readonly UserSettingEntry[]>
{
    readonly keys: readonly DeclaredKey<TEntries>[];
    /** Read-only: the object has no mutator, and installing copies it */
    readonly entries: DeclaredEntries<UserSettingEntry>;
    get<TKey extends DeclaredKey<TEntries>>(userId: UserId, key: TKey): Promise<DeclaredValue<TEntries, TKey>>;
    set<TKey extends DeclaredKey<TEntries>>(
        userId: UserId,
        key: TKey,
        value: DeclaredValue<TEntries, TKey>,
        options?: SetUserSettingOptions,
    ): Promise<void>;
    list(userId: UserId): Promise<UserSettingView[]>;
}

/**
 * Declare the per-person settings an app keeps
 *
 * Checked here, at module load: a key must match
 * `^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$` (at most 120 characters), appear
 * once, not be a built-in key (`locale`, `timezone`), and have a default that
 * passes its own schema. Install the result with
 * `createAuthLifecycle({ userSettings })`.
 *
 * @throws Error on any of the violations above
 *
 * @example
 * ```typescript
 * export const USER_SETTINGS = defineUserSettings([
 *     {
 *         key: 'notifications.digest',
 *         schema: Type.Union([Type.Literal('daily'), Type.Literal('weekly'), Type.Literal('off')]),
 *         default: 'daily',
 *     },
 * ]);
 *
 * const digest = await USER_SETTINGS.get(userId, 'notifications.digest'); // 'daily' | 'weekly' | 'off'
 * ```
 */
export function defineUserSettings<const TEntries extends readonly UserSettingEntry[]>(
    entries: TEntries,
): UserSettingsDeclaration<TEntries>
{
    return Object.freeze({
        keys: Object.freeze(entries.map(entry => entry.key)),
        entries: indexDeclaredEntries('defineUserSettings', entries, BUILTIN_USER_SETTING_KEYS),
        get: async (userId: UserId, key: string) => await getUserSetting(userId, key) as never,
        set: async (userId: UserId, key: string, value: unknown, options?: SetUserSettingOptions) =>
        {
            await setUserSetting(userId, key, value, options);
        },
        list: async (userId: UserId) => await listUserSettings(userId),
    });
}
