/**
 * @spfn/auth - User Settings Service
 *
 * Reads and writes per-person settings against the active declaration. A key
 * nobody declared is refused; a value is checked against its key's schema on
 * the way in and again on the way out, by the one rule each entry carries
 * (`isValid`), so a deploy that narrows a schema never hands an old value to
 * code that no longer expects it.
 */

import { Value } from '@sinclair/typebox/value';
import { ValidationError } from '@spfn/core/errors';
import { UserSettingNotDeclaredError } from '@spfn/auth/errors';
import { userSettingsRepository } from '../repositories';
import {
    activeUserSettingEntries,
    findUserSettingEntry,
    readUserSettingRows,
    type ActiveUserSettingEntry,
    type SetUserSettingOptions,
    type UserSettingView,
} from '../lib/user-settings/registry';
import { containsNul, serializedBytes, SETTING_VALUE_MAX_BYTES } from '../lib/declared-keys';
import { authLogger } from '../logger';

function declaredEntry(key: string): ActiveUserSettingEntry
{
    const entry = findUserSettingEntry(key);
    if (!entry)
    {
        throw new UserSettingNotDeclaredError({ details: { key } });
    }

    return entry;
}

/**
 * Read one setting
 *
 * @returns The stored value, or the declared default when there is no row or the row fails the schema
 * @throws UserSettingNotDeclaredError (404) when the key is not declared
 */
export async function getUserSetting(userId: string | number | bigint, key: string): Promise<unknown>
{
    const entry = declaredEntry(key);
    const stored = await userSettingsRepository.findValue(Number(userId), key);

    return readUserSettingRows([entry], stored ? [stored] : [])[0].value;
}

/** Why a value is not valid for its key, for the 400's `fields` */
function settingProblems(entry: ActiveUserSettingEntry, value: unknown): Array<{ path: string; message: string }>
{
    if (containsNul(value))
    {
        return [{ path: '', message: 'must not contain a NUL character' }];
    }

    return [...Value.Errors(entry.schema, value)].map(error => ({ path: error.path, message: error.message }));
}

/** The size cap comes first, so an oversized value is never walked by the schema */
function assertSettable(entry: ActiveUserSettingEntry, value: unknown): void
{
    if (serializedBytes(value) > SETTING_VALUE_MAX_BYTES)
    {
        throw new ValidationError({
            message: `Invalid value for setting '${entry.key}'`,
            fields: [{ path: '', message: `must serialize to at most ${SETTING_VALUE_MAX_BYTES} bytes of JSON` }],
        });
    }
    if (!entry.isValid(value))
    {
        throw new ValidationError({ message: `Invalid value for setting '${entry.key}'`, fields: settingProblems(entry, value) });
    }
}

/**
 * Write one setting
 *
 * A value deep-equal to the default deletes the row instead, so a later change
 * of the default reaches this person too.
 *
 * @returns The value the setting reads as now: the written value, after a
 * built-in key tidied it
 * @throws UserSettingNotDeclaredError (404) when the key is not declared
 * @throws ValidationError (400) when the value serializes to more than 16 KiB,
 * holds a NUL character, or is not valid for the key; nothing is written
 */
export async function setUserSetting(
    userId: string | number | bigint,
    key: string,
    value: unknown,
    options: SetUserSettingOptions = {},
): Promise<unknown>
{
    const entry = declaredEntry(key);
    const prepared = entry.prepare ? entry.prepare(value) : value;

    assertSettable(entry, prepared);
    if (Value.Equal(prepared, entry.default))
    {
        await userSettingsRepository.deleteOne(Number(userId), key);
    }
    else
    {
        await userSettingsRepository.upsert(Number(userId), key, prepared, options.by === undefined ? null : Number(options.by));
    }

    return prepared;
}

/**
 * Every declared setting of one person, built-ins included, in one query
 */
export async function listUserSettings(userId: string | number | bigint): Promise<UserSettingView[]>
{
    return readUserSettingRows(activeUserSettingEntries(), await userSettingsRepository.listByUser(Number(userId)));
}

/**
 * Return one setting to its default by deleting the row
 *
 * @throws UserSettingNotDeclaredError (404) when the key is not declared
 */
export async function resetUserSetting(userId: string | number | bigint, key: string): Promise<void>
{
    declaredEntry(key);
    await userSettingsRepository.deleteOne(Number(userId), key);
}

/**
 * Boot reconcile: report stored keys nobody declares, once, and keep the rows
 *
 * A key removed from code keeps its rows; declaring it again reads them again.
 */
export async function reconcileUserSettings(): Promise<void>
{
    const undeclared = (await userSettingsRepository.countByKey())
        .filter(row => !findUserSettingEntry(row.key));

    if (undeclared.length > 0)
    {
        authLogger.service.warn(
            `user_settings holds keys no declaration names (rows kept): ${undeclared.map(row => `${row.key} (${row.count})`).join(', ')}`,
        );
    }
}
