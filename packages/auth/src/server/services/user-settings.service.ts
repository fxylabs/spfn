/**
 * @spfn/auth - User Settings Service
 *
 * Reads and writes per-person settings against the active declaration. A key
 * nobody declared is refused; a value is checked against its key's schema on
 * the way in and again on the way out, so a deploy that narrows a schema never
 * hands an old value to code that no longer expects it.
 */

import { Value } from '@sinclair/typebox/value';
import { ValidationError } from '@spfn/core/errors';
import { UserSettingNotDeclaredError } from '@spfn/auth/errors';
import { userSettingsRepository, type StoredUserSetting } from '../repositories';
import {
    activeUserSettingEntries,
    findUserSettingEntry,
    type ActiveUserSettingEntry,
    type SetUserSettingOptions,
    type UserSettingView,
} from '../lib/user-settings/registry';
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

function passesSchema(entry: ActiveUserSettingEntry, value: unknown): boolean
{
    return Value.Check(entry.schema, value);
}

/**
 * The value a stored row reads as: its own when it still passes the schema,
 * the default when there is no row or the row no longer passes.
 */
function readStored(entry: ActiveUserSettingEntry, stored: StoredUserSetting | undefined): UserSettingView
{
    if (stored && passesSchema(entry, stored.value))
    {
        return { key: entry.key, value: stored.value, isDefault: false, updatedAt: stored.updatedAt };
    }

    return { key: entry.key, value: entry.default, isDefault: true, updatedAt: null };
}

/** One warning per read, naming the keys and how many — never whose */
function warnStale(keys: string[]): void
{
    if (keys.length > 0)
    {
        authLogger.service.warn(
            `${keys.length} stored setting value(s) fail the current schema and read as the default: ${keys.join(', ')}`,
        );
    }
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
    const view = readStored(entry, stored ?? undefined);

    warnStale(stored && view.isDefault ? [key] : []);

    return view.value;
}

function assertSettable(entry: ActiveUserSettingEntry, value: unknown): void
{
    if (!passesSchema(entry, value))
    {
        throw new ValidationError({
            message: `Invalid value for setting '${entry.key}'`,
            fields: [...Value.Errors(entry.schema, value)].map(error => ({ path: error.path, message: error.message })),
        });
    }
    if (entry.accepts && !entry.accepts(value))
    {
        throw new ValidationError({ message: `Invalid value for setting '${entry.key}'` });
    }
}

/**
 * Write one setting
 *
 * A value deep-equal to the default deletes the row instead, so a later change
 * of the default reaches this person too.
 *
 * @throws UserSettingNotDeclaredError (404) when the key is not declared
 * @throws ValidationError (400) when the value fails the key's schema; nothing is written
 */
export async function setUserSetting(
    userId: string | number | bigint,
    key: string,
    value: unknown,
    options: SetUserSettingOptions = {},
): Promise<void>
{
    const entry = declaredEntry(key);
    const prepared = entry.prepare ? entry.prepare(value) : value;

    assertSettable(entry, prepared);
    if (Value.Equal(prepared, entry.default))
    {
        await userSettingsRepository.deleteOne(Number(userId), key);

        return;
    }
    await userSettingsRepository.upsert(Number(userId), key, prepared, options.by === undefined ? null : Number(options.by));
}

/**
 * Every declared setting of one person, built-ins included, in one query
 */
export async function listUserSettings(userId: string | number | bigint): Promise<UserSettingView[]>
{
    const entries = activeUserSettingEntries();
    const rows = new Map((await userSettingsRepository.listByUser(Number(userId))).map(row => [row.key, row]));
    const views = entries.map(entry => readStored(entry, rows.get(entry.key)));

    warnStale(views.filter(view => view.isDefault && rows.has(view.key)).map(view => view.key));

    return views;
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
