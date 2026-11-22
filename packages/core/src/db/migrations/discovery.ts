/**
 * Function Package Migration Discovery
 *
 * Finds the migrations shipped by installed SPFN function packages (e.g.
 * `@spfn/auth`) and reads their entries. Both drizzle-kit layouts are
 * supported — `NNNN_name.sql` + `meta/_journal.json` (≤0.31) and
 * `<YYYYMMDDHHMMSS>_name/migration.sql` (1.0) — so an installed package keeps
 * working regardless of which drizzle-kit generated it.
 *
 * This module only reads the filesystem. Applying migrations is the CLI's job
 * (`spfn db migrate`); the server and `spfn db status` share the reading half.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { logger } from '@spfn/core/logger';

const discoveryLogger = logger.child('@spfn/core:migrations');

export type FunctionMigrationInfo = {
    packageName: string;
    migrationsDir: string;
    packagePath: string;
};

export type FunctionMigrationEntry = {
    name: string;
    statements: string[];
    hash: string;
    millis: number;
};

/**
 * Per-package migrations table name — must match the CLI's migration runner.
 */
export function functionMigrationsTable(packageName: string): string
{
    return `__spfn_fn_${packageName.replace('@spfn/', '')}_migrations`;
}

/**
 * Discover all installed SPFN function packages that ship migrations.
 *
 * A package opts in with a `spfn.migrations.dir` field in its package.json.
 * Returns an empty list when the project has no `node_modules/@spfn` at all,
 * which is also the "nothing to check" answer for apps without function packages.
 */
export function discoverFunctionMigrations(cwd: string = process.cwd()): FunctionMigrationInfo[]
{
    const spfnDir = join(cwd, 'node_modules', '@spfn');

    if (!existsSync(spfnDir))
    {
        return [];
    }

    const functions: FunctionMigrationInfo[] = [];

    for (const pkg of readdirSync(spfnDir))
    {
        const packagePath = join(spfnDir, pkg);
        const packageJsonPath = join(packagePath, 'package.json');

        if (!existsSync(packageJsonPath))
        {
            continue;
        }

        try
        {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
            const migrationsConfig = packageJson.spfn?.migrations;

            if (!migrationsConfig)
            {
                continue;
            }

            const migrationsDir = join(packagePath, migrationsConfig.dir);

            if (!existsSync(migrationsDir))
            {
                discoveryLogger.warn(
                    `@spfn/${pkg} declares migrations but the directory is missing: ${migrationsDir}`,
                );
                continue;
            }

            functions.push({ packageName: `@spfn/${pkg}`, migrationsDir, packagePath });
        }
        catch
        {
            discoveryLogger.warn(`Failed to parse package.json for @spfn/${pkg}`);
        }
    }

    return functions;
}

/**
 * Read a package's migration entries, auto-detecting the folder layout.
 *
 * A `meta/_journal.json` marks the drizzle-kit ≤0.31 layout; without it the
 * directory is read as the drizzle-kit 1.0 layout, where a migration is a
 * directory holding `migration.sql`; any other entry of the folder — the
 * `privileges.json` manifest `spfn db generate` writes beside them — is not one.
 */
export function readMigrationEntries(migrationsDir: string, packageName: string): FunctionMigrationEntry[]
{
    const journalPath = join(migrationsDir, 'meta', '_journal.json');

    return existsSync(journalPath)
        ? readJournalEntries(migrationsDir, journalPath, packageName)
        : readFolderEntries(migrationsDir, packageName);
}

function readJournalEntries(
    migrationsDir: string,
    journalPath: string,
    packageName: string,
): FunctionMigrationEntry[]
{
    let journal: { entries?: unknown };

    try
    {
        journal = JSON.parse(readFileSync(journalPath, 'utf-8'));
    }
    catch
    {
        journal = {};
    }

    if (!Array.isArray(journal.entries))
    {
        throw new Error(`${packageName}: invalid migration journal at ${journalPath}`);
    }

    const entries = [...journal.entries] as { idx: number; tag: string; when: number }[];
    entries.sort((a, b) => a.idx - b.idx);

    return entries.map(entry =>
    {
        if (typeof entry?.tag !== 'string' || typeof entry?.when !== 'number')
        {
            throw new Error(`${packageName}: invalid journal entry in ${journalPath}`);
        }

        const sqlPath = join(migrationsDir, `${entry.tag}.sql`);

        if (!existsSync(sqlPath))
        {
            throw new Error(`${packageName}: migration file not found: ${entry.tag}.sql`);
        }

        return toEntry(entry.tag, readFileSync(sqlPath, 'utf-8'), entry.when);
    });
}

function readFolderEntries(migrationsDir: string, packageName: string): FunctionMigrationEntry[]
{
    const folders = readdirSync(migrationsDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)
        .filter(name => existsSync(join(migrationsDir, name, 'migration.sql')))
        .sort((a, b) => a.localeCompare(b));

    return folders.map(name => toEntry(
        name,
        readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf-8'),
        folderTimestampMillis(name, packageName),
    ));
}

/**
 * Folder names in the drizzle-kit 1.0 layout start with a UTC YYYYMMDDHHMMSS
 * timestamp — the same interpretation drizzle-orm's own migrator uses.
 */
function folderTimestampMillis(name: string, packageName: string): number
{
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name);

    if (!match)
    {
        throw new Error(`${packageName}: migration folder name must start with a YYYYMMDDHHMMSS timestamp: ${name}`);
    }

    const [, year, month, day, hour, minute, second] = match;

    return Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
    );
}

function toEntry(name: string, content: string, millis: number): FunctionMigrationEntry
{
    return {
        name,
        millis,
        hash: createHash('sha256').update(content).digest('hex'),
        statements: content
            .split('--> statement-breakpoint')
            .map(statement => statement.trim())
            .filter(statement => statement.length > 0),
    };
}
