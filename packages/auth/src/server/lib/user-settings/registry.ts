/**
 * @spfn/auth - The active per-person settings declaration
 *
 * The library declares `locale` and `timezone`; an app adds its own keys with
 * `defineUserSettings` and installs them through `createAuthLifecycle({
 * userSettings })`. One install per process, before boot completes — the same
 * rule as `registerAuthProfile`: a second install or a late one throws.
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { normalizeChosenLocale } from '../profile-locale';

export interface UserSettingEntry<TKey extends string = string, TValueSchema extends TSchema = TSchema>
{
    readonly key: TKey;
    readonly schema: TValueSchema;
    readonly default: Static<TValueSchema>;
}

/**
 * A declared entry as the service sees it. Built-in keys may tidy a value
 * before it is checked (`prepare`) and refuse one the schema cannot express
 * (`accepts`); app entries never carry either.
 */
export interface ActiveUserSettingEntry extends UserSettingEntry
{
    readonly prepare?: (value: unknown) => unknown;
    readonly accepts?: (value: unknown) => boolean;
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
    readonly entries: ReadonlyMap<string, UserSettingEntry>;
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

const BUILTIN_USER_SETTINGS: ReadonlyMap<string, ActiveUserSettingEntry> = new Map<string, ActiveUserSettingEntry>([
    ['locale', {
        key: 'locale',
        schema: Type.Union([Type.String(), Type.Null()]),
        default: null,
        prepare: value => (typeof value === 'string' ? normalizeChosenLocale(value) : value),
    }],
    ['timezone', {
        key: 'timezone',
        schema: Type.String(),
        default: 'UTC',
        accepts: isIanaTimeZone,
    }],
]);

/** The keys an app may not declare, with the reason the error gives */
export const BUILTIN_USER_SETTING_KEYS: ReadonlyMap<string, string> = new Map(
    [...BUILTIN_USER_SETTINGS.keys()].map(key => [key, 'is a built-in setting and cannot be redeclared']),
);

let installed: ReadonlyMap<string, UserSettingEntry> | null = null;
let sealed = false;

/**
 * Makes a declaration the active one
 *
 * @throws Error when a declaration is already installed, or boot already completed
 */
export function installUserSettings(declaration: InstallableUserSettings): void
{
    if (installed !== null)
    {
        throw new Error('userSettings: a declaration is already installed; pass one defineUserSettings result to createAuthLifecycle');
    }
    if (sealed)
    {
        throw new Error('userSettings: auth has already initialized; settings are declared on createAuthLifecycle, before boot');
    }
    installed = declaration.entries;
}

/** Called when `initializeAuth` completes: from here on nothing may be installed */
export function sealUserSettings(): void
{
    sealed = true;
}

/** The entry for a key, built-in or declared; undefined when nobody declared it */
export function findUserSettingEntry(key: string): ActiveUserSettingEntry | undefined
{
    return BUILTIN_USER_SETTINGS.get(key) ?? installed?.get(key);
}

/** Every active entry: the built-ins first, then the app's in declaration order */
export function activeUserSettingEntries(): ActiveUserSettingEntry[]
{
    return [...BUILTIN_USER_SETTINGS.values(), ...(installed?.values() ?? [])];
}

/**
 * Test-only: forget the installed declaration and the boot seal. The vitest
 * config runs every file in one fork, so module state outlives a file.
 */
export function __resetUserSettingsForTests(): void
{
    installed = null;
    sealed = false;
}
