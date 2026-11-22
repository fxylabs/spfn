/**
 * The package's committed migrations (./migrations), read by the reader
 * `spfn db migrate` applies them with: `readMigrationEntries` from
 * `@spfn/core/db`. A test sees the migrations a consumer's database gets, in
 * the order it gets them — and not the other files the folder holds, such as
 * `privileges.json`.
 */

import { fileURLToPath } from 'node:url';
import { readMigrationEntries, type FunctionMigrationEntry } from '@spfn/core/db';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));

/** Every migration of @spfn/auth, oldest first */
export function authMigrations(): FunctionMigrationEntry[]
{
    return readMigrationEntries(MIGRATIONS_FOLDER, '@spfn/auth');
}

/** The one migration with a statement containing `text` */
export function authMigrationContaining(text: string): FunctionMigrationEntry
{
    const matches = authMigrations().filter(migration => migration.statements.some(statement => statement.includes(text)));

    if (matches.length !== 1)
    {
        throw new Error(`${matches.length} migrations contain ${text}, expected 1`);
    }

    return matches[0]!;
}
