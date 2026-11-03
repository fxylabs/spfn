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
): Map<string, T>
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

    return byKey;
}
