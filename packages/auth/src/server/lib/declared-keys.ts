/**
 * @spfn/auth - Rules shared by the key declarations
 *
 * `defineUserSettings` and `defineProfileFields` both take a list of
 * `{ key, schema, default }` and refuse a bad list when it is declared, at
 * module load, rather than on the first request that reads it.
 */

import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const DECLARED_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

export const DECLARED_KEY_MAX_LENGTH = 120;

export interface DeclaredEntry
{
    key: string;
    schema: TSchema;
    default?: unknown;
}

/**
 * Declared entries by key, with no way to add, replace or remove one.
 * `ReadonlyMap` would only be a promise of the type: the object behind it
 * here has no mutator at all, so a declaration installed at boot stays
 * exactly what boot checked.
 */
export interface DeclaredEntries<T>
{
    readonly size: number;
    get(key: string): T | undefined;
    has(key: string): boolean;
    keys(): IterableIterator<string>;
    values(): IterableIterator<T>;
}

/**
 * A private copy of the entries behind a frozen read-only facade. Each entry
 * is copied and frozen too, so no schema can be swapped after the check.
 */
export function readOnlyEntries<T extends DeclaredEntry>(source: Iterable<[string, T]>): DeclaredEntries<T>
{
    const own = new Map<string, T>([...source].map(([key, entry]) => [key, Object.freeze({ ...entry })]));

    return Object.freeze({
        size: own.size,
        get: (key: string) => own.get(key),
        has: (key: string) => own.has(key),
        keys: () => own.keys(),
        values: () => own.values(),
    });
}

/** The serialized size cap of one setting value */
export const SETTING_VALUE_MAX_BYTES = 16 * 1024;

/** The serialized size cap of one profile `metadata` patch */
export const PROFILE_METADATA_MAX_BYTES = 64 * 1024;

/** The UTF-8 byte length of a value as JSON */
export function serializedBytes(value: unknown): number
{
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * Whether a NUL character appears in any string of a JSON value, keys
 * included. PostgreSQL `jsonb` refuses one, after every schema has passed.
 */
export function containsNul(value: unknown): boolean
{
    if (typeof value === 'string')
    {
        return value.includes('\u0000');
    }
    if (Array.isArray(value))
    {
        return value.some(containsNul);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.entries(value).some(([key, inner]) => key.includes('\u0000') || containsNul(inner));
    }

    return false;
}

function assertKeyFormat(label: string, key: string): void
{
    if (typeof key !== 'string' || key.length > DECLARED_KEY_MAX_LENGTH || !DECLARED_KEY_PATTERN.test(key))
    {
        throw new Error(
            `${label}: key '${key}' must match ${DECLARED_KEY_PATTERN} and be at most ${DECLARED_KEY_MAX_LENGTH} characters`,
        );
    }
}

function assertDefaultPasses(label: string, entry: DeclaredEntry): void
{
    if ('default' in entry && !Value.Check(entry.schema, entry.default))
    {
        throw new Error(`${label}: the default of '${entry.key}' does not pass its own schema`);
    }
}

/**
 * Checks a declaration list and indexes it by key
 *
 * @param label - The declaring function's name, for the error message
 * @param reservedKeys - Keys the declaration may not use, with the reason
 * @throws Error on a malformed key, a duplicate, a reserved key, or a default that fails its schema
 */
export function indexDeclaredEntries<T extends DeclaredEntry>(
    label: string,
    entries: readonly T[],
    reservedKeys: ReadonlyMap<string, string>,
): DeclaredEntries<T>
{
    const byKey = new Map<string, T>();

    for (const entry of entries)
    {
        assertKeyFormat(label, entry.key);
        if (reservedKeys.has(entry.key))
        {
            throw new Error(`${label}: '${entry.key}' ${reservedKeys.get(entry.key)}`);
        }
        if (byKey.has(entry.key))
        {
            throw new Error(`${label}: '${entry.key}' is declared twice`);
        }
        assertDefaultPasses(label, entry);
        byKey.set(entry.key, entry);
    }

    return readOnlyEntries(byKey);
}

/**
 * Where one active declaration lives: installed once, before boot completes.
 * The same rule as `registerAuthProfile` — a second install or a late one throws.
 */
export interface DeclarationSlot<T>
{
    install(declaration: T): void;
    /** Called when `initializeAuth` completes: from here on nothing may be installed */
    seal(): void;
    current(): T | null;
    /** Test-only: the vitest config runs every file in one fork, so module state outlives a file */
    reset(): void;
}

export function createDeclarationSlot<T>(option: string, definer: string): DeclarationSlot<T>
{
    let installed: T | null = null;
    let sealed = false;

    return {
        install(declaration)
        {
            if (installed !== null)
            {
                throw new Error(`${option}: a declaration is already installed; pass one ${definer} result to createAuthLifecycle`);
            }
            if (sealed)
            {
                throw new Error(`${option}: auth has already initialized; declare ${option} on createAuthLifecycle, before boot`);
            }
            installed = declaration;
        },
        seal()
        {
            sealed = true;
        },
        current()
        {
            return installed;
        },
        reset()
        {
            installed = null;
            sealed = false;
        },
    };
}
