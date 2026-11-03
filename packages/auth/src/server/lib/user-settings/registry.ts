/**
 * @spfn/auth - The active per-person settings declaration
 *
 * The library declares `locale` and `timezone`; an app adds its own keys with
 * `defineUserSettings` and installs them through `createAuthLifecycle({
 * userSettings })`. One install per process, before boot completes — the same
 * rule as `registerAuthProfile`: a second install or a late one throws.
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { authLogger } from '../../logger';
import { normalizeChosenLocale } from '../profile-locale';
import { containsNul, createDeclarationSlot, readOnlyEntries, type DeclaredEntries } from '../declared-keys';

export interface UserSettingEntry<TKey extends string = string, TValueSchema extends TSchema = TSchema>
{
    readonly key: TKey;
    readonly schema: TValueSchema;
    readonly default: Static<TValueSchema>;
}

/** One stored row of `spfn_auth.user_settings`, as the repository returns it */
export interface StoredUserSetting
{
    key: string;
    value: unknown;
    updatedAt: Date;
}

/** What a built-in key adds to its schema; app entries never carry either */
interface BuiltinRules
{
    /** Tidies a value before it is checked */
    readonly prepare?: (value: unknown) => unknown;
    /** Refuses a value the schema cannot express */
    readonly accepts?: (value: unknown) => boolean;
}

/**
 * A declared entry as the service sees it. `isValid` is the one definition of
 * a value the key may hold: a write is refused and a stored row reads as the
 * default by the same rule.
 */
export interface ActiveUserSettingEntry extends UserSettingEntry, BuiltinRules
{
    readonly isValid: (value: unknown) => boolean;
}

export interface UserSettingView
{
    key: string;
    value: unknown;
    isDefault: boolean;
    updatedAt: Date | null;
}

export interface SetUserSettingOptions
{
    /** Who is writing: the owner on the self-service routes */
    by?: string | number | bigint;
}

/** What `installUserSettings` takes: the frozen object `defineUserSettings` returns */
export interface InstallableUserSettings
{
    readonly entries: DeclaredEntries<UserSettingEntry>;
}

const SUPPORTED_TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

/**
 * An IANA zone name. `Intl.supportedValuesOf` lists canonical names only and,
 * on Node 22, neither `UTC` nor current aliases such as `Asia/Kolkata`, so the
 * name is resolved first and the resolved zone is what has to be listed.
 */
export function isIanaTimeZone(value: unknown): boolean
{
    if (typeof value !== 'string')
    {
        return false;
    }
    try
    {
        const resolved = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;

        return resolved === 'UTC' || SUPPORTED_TIME_ZONES.has(resolved);
    }
    catch
    {
        return false;
    }
}

function activeEntry(entry: UserSettingEntry, rules: BuiltinRules = {}): ActiveUserSettingEntry
{
    return Object.freeze({
        key: entry.key,
        schema: entry.schema,
        default: entry.default,
        ...rules,
        isValid: (value: unknown) => !containsNul(value)
            && Value.Check(entry.schema, value)
            && (rules.accepts?.(value) ?? true),
    });
}

/** BCP 47 tags in use fit in 35 characters; the longest IANA zone names in 32 */
export const LOCALE_MAX_LENGTH = 35;

const BUILTIN_USER_SETTINGS: ReadonlyMap<string, ActiveUserSettingEntry> = new Map([
    activeEntry(
        { key: 'locale', schema: Type.Union([Type.String({ maxLength: LOCALE_MAX_LENGTH }), Type.Null()]), default: null },
        { prepare: value => (typeof value === 'string' ? normalizeChosenLocale(value) : value) },
    ),
    activeEntry(
        { key: 'timezone', schema: Type.String({ maxLength: 64 }), default: 'UTC' },
        { accepts: isIanaTimeZone },
    ),
].map(entry => [entry.key, entry]));

/** The keys an app may not declare, with the reason the error gives */
export const BUILTIN_USER_SETTING_KEYS: ReadonlyMap<string, string> = new Map(
    [...BUILTIN_USER_SETTINGS.keys()].map(key => [key, 'is a built-in setting and cannot be redeclared']),
);

const slot = createDeclarationSlot<DeclaredEntries<ActiveUserSettingEntry>>('userSettings', 'defineUserSettings');

/**
 * Makes a declaration the active one. The registry keeps its own copy, so
 * nothing the app holds can change what was installed.
 *
 * @throws Error when a declaration is already installed, or boot already completed
 */
export function installUserSettings(declaration: InstallableUserSettings): void
{
    slot.install(readOnlyEntries([...declaration.entries.values()].map(entry => [entry.key, activeEntry(entry)])));
}

/** Called when `initializeAuth` completes: from here on nothing may be installed */
export function sealUserSettings(): void
{
    slot.seal();
}

/** The entry for a key, built-in or declared; undefined when nobody declared it */
export function findUserSettingEntry(key: string): ActiveUserSettingEntry | undefined
{
    return BUILTIN_USER_SETTINGS.get(key) ?? slot.current()?.get(key);
}

/** Every active entry: the built-ins first, then the app's in declaration order */
export function activeUserSettingEntries(): ActiveUserSettingEntry[]
{
    return [...BUILTIN_USER_SETTINGS.values(), ...(slot.current()?.values() ?? [])];
}

/** The library's own keys, `locale` and `timezone` */
export function builtinUserSettingEntries(): ActiveUserSettingEntry[]
{
    return [...BUILTIN_USER_SETTINGS.values()];
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
 * What stored rows read as, one view per entry: a row's own value when it is
 * still valid for its key, the default when there is no row or it is not.
 * Every read path goes through here, so a value no write would accept never
 * reads back as set.
 */
export function readUserSettingRows(entries: readonly ActiveUserSettingEntry[], rows: readonly StoredUserSetting[]): UserSettingView[]
{
    const byKey = new Map(rows.map(row => [row.key, row]));
    const views = entries.map((entry): UserSettingView =>
    {
        const stored = byKey.get(entry.key);

        return stored && entry.isValid(stored.value)
            ? { key: entry.key, value: stored.value, isDefault: false, updatedAt: stored.updatedAt }
            : { key: entry.key, value: Value.Clone(entry.default), isDefault: true, updatedAt: null };
    });

    warnStale(views.filter(view => view.isDefault && byKey.has(view.key)).map(view => view.key));

    return views;
}

/** Test-only: forget the installed declaration and the boot seal */
export function __resetUserSettingsForTests(): void
{
    slot.reset();
}
