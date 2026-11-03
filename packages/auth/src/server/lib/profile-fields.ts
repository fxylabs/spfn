/**
 * @spfn/auth - Profile fields declared in code (fxylabs/spfn#161)
 *
 * `user_profiles.metadata` holds who a person is beyond the basic columns:
 * a department, a GitHub handle. An app declares those keys with
 * `defineProfileFields` and installs them through `createAuthLifecycle({
 * profileFields })`. With a declaration, `metadata` is strict — only declared
 * keys, each checked against its schema, merged key by key. Without one it
 * stays free-form and is replaced wholesale, as it always was.
 *
 * How a person uses the app (a theme, a dismissed tip) is a setting, not a
 * profile field: see `defineUserSettings`.
 */

import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { getTableColumns } from 'drizzle-orm';
import { ValidationError } from '@spfn/core/errors';
import { userProfiles } from '../entities/user-profiles';
import { createDeclarationSlot, indexDeclaredEntries } from './declared-keys';

export interface ProfileFieldEntry<TKey extends string = string, TValueSchema extends TSchema = TSchema>
{
    readonly key: TKey;
    readonly schema: TValueSchema;
    readonly default?: Static<TValueSchema>;
}

/** A frozen set of profile field declarations */
export interface ProfileFieldsDeclaration<TEntries extends readonly ProfileFieldEntry[] = readonly ProfileFieldEntry[]>
{
    readonly keys: readonly TEntries[number]['key'][];
    readonly entries: ReadonlyMap<string, ProfileFieldEntry>;
}

/**
 * Every basic profile column, which a field may not shadow, and the two keys
 * that are settings rather than profile — a field named `locale` would put a
 * usage preference back into the profile.
 */
const RESERVED_PROFILE_FIELD_KEYS: ReadonlyMap<string, string> = new Map([
    ...Object.keys(getTableColumns(userProfiles))
        .filter(column => column !== 'metadata')
        .map(column => [column, 'is a basic profile column and cannot be a profile field'] as const),
    ['locale', 'is a user setting (defineUserSettings built-in), not a profile field'],
    ['timezone', 'is a user setting (defineUserSettings built-in), not a profile field'],
]);

/**
 * Declare the keys `user_profiles.metadata` may hold
 *
 * Checked here, at module load: the key rules of `defineUserSettings`, a
 * default (optional here) that passes its schema, and no key that is a basic
 * profile column (`displayName`, `bio`, …) or `locale`/`timezone`. Install the
 * result with `createAuthLifecycle({ profileFields })`.
 *
 * @throws Error on any of the violations above
 *
 * @example
 * ```typescript
 * export const PROFILE_FIELDS = defineProfileFields([
 *     { key: 'department', schema: Type.String({ maxLength: 80 }) },
 *     { key: 'github', schema: Type.String({ pattern: '^[A-Za-z0-9-]+$' }) },
 * ]);
 * ```
 */
export function defineProfileFields<const TEntries extends readonly ProfileFieldEntry[]>(
    entries: TEntries,
): ProfileFieldsDeclaration<TEntries>
{
    return Object.freeze({
        keys: Object.freeze(entries.map(entry => entry.key)),
        entries: indexDeclaredEntries('defineProfileFields', entries, RESERVED_PROFILE_FIELD_KEYS),
    });
}

const slot = createDeclarationSlot<ReadonlyMap<string, ProfileFieldEntry>>('profileFields', 'defineProfileFields');

/** @throws Error when a declaration is already installed, or boot already completed */
export function installProfileFields(declaration: ProfileFieldsDeclaration): void
{
    slot.install(declaration.entries);
}

export function sealProfileFields(): void
{
    slot.seal();
}

/** The installed fields, or null when metadata is free-form */
export function activeProfileFields(): ReadonlyMap<string, ProfileFieldEntry> | null
{
    return slot.current();
}

/** Test-only: forget the installed declaration and the boot seal */
export function __resetProfileFieldsForTests(): void
{
    slot.reset();
}

/**
 * Checks a metadata patch against the declaration
 *
 * @throws ValidationError (400) naming every undeclared key and every value that fails its schema
 */
export function assertProfileFieldsPatch(fields: ReadonlyMap<string, ProfileFieldEntry>, patch: Record<string, unknown>): void
{
    const problems = Object.entries(patch).flatMap(([key, value]) =>
    {
        const entry = fields.get(key);
        if (!entry)
        {
            return [{ path: `/metadata/${key}`, message: 'is not a declared profile field' }];
        }

        return [...Value.Errors(entry.schema, value)].map(error => ({ path: `/metadata/${key}${error.path}`, message: error.message }));
    });

    if (problems.length > 0)
    {
        throw new ValidationError({ message: 'Invalid profile metadata', fields: problems });
    }
}

/**
 * What a reader sees of stored metadata: as stored when nothing is declared;
 * otherwise every declared key with its stored value, or its default when the
 * value is missing or no longer passes, and no undeclared key.
 */
export function projectProfileMetadata(stored: Record<string, any> | null): Record<string, any> | null
{
    const fields = activeProfileFields();
    if (!fields)
    {
        return stored;
    }

    const projected: Record<string, unknown> = {};
    for (const entry of fields.values())
    {
        const value = stored?.[entry.key];
        projected[entry.key] = value !== undefined && Value.Check(entry.schema, value) ? value : entry.default;
    }

    return projected;
}
