/**
 * Migration Status Inspection
 *
 * Compares what each migration folder ships (function packages, plus the
 * project's own `src/server/drizzle`) against what the database records as
 * applied. `spfn db status`, the server's boot gate and the detailed health
 * endpoint all read this one implementation, and the CLI's `spfn db push`
 * preview and every function-package apply take their pending list from
 * `pendingFunctionMigrations` here — one rule for "pending", never two.
 */

import { existsSync } from 'fs';
import { join } from 'path';

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { getMigrationsToRun } from 'drizzle-orm/migrator.utils';

import {
    discoverFunctionMigrations,
    functionMigrationsTable,
    readMigrationEntries,
    type FunctionMigrationEntry,
} from './discovery';

/**
 * Project migrations use drizzle's default table, in the `drizzle` schema.
 */
export const PROJECT_MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * The table every function package shared before each got its own. Read as a
 * package's record while its own table is missing or empty; never written or
 * dropped, so a package uninstalled today still finds its rows tomorrow.
 */
const LEGACY_FUNCTION_MIGRATIONS_TABLE = '__spfn_fn_migrations';

/**
 * The name `spfn db status` and health use for the project's own migrations.
 */
export const PROJECT_TARGET_NAME = 'project (src/server/drizzle)';

export type MigrationTargetStatus = {
    name: string;
    total: number;
    applied: number;
    pending: number;
    pendingTags: string[];
};

/**
 * A function package's migrations, as read from its folder.
 */
export type FunctionMigrationSource = {
    packageName: string;
    entries: FunctionMigrationEntry[];
};

/**
 * The entries of one function package that the database has not applied yet.
 */
export type PendingFunctionMigrations = {
    packageName: string;
    entries: FunctionMigrationEntry[];
};

/**
 * A row of the project's bookkeeping table, in the shape drizzle's own
 * `getMigrationsToRun` reads.
 */
type ProjectBookkeepingRow = Parameters<typeof getMigrationsToRun>[0]['dbMigrations'][number];

/**
 * The project's bookkeeping table cannot be matched to `src/server/drizzle` the
 * way `spfn db migrate` (drizzle-orm's migrator) matches it, so migrate will
 * refuse to run. Status reports it as an error rather than as a count, and the
 * boot gate refuses to start on it.
 */
export class MigrationBookkeepingMismatchError extends Error
{
    constructor(detail: string)
    {
        super(`${PROJECT_TARGET_NAME}: bookkeeping does not match local migrations; \`spfn db migrate\` will refuse. ${detail}`);
        this.name = 'MigrationBookkeepingMismatchError';
    }
}

export type MigrationStatus = {
    packages: MigrationTargetStatus[];
    project: MigrationTargetStatus | null;
};

/**
 * The minimum surface needed to read migration bookkeeping: anything that can
 * run a drizzle `sql` fragment. The server passes its own pool, the CLI passes
 * a short-lived connection.
 */
export interface MigrationStatusDb
{
    execute(query: SQL): Promise<unknown>;
}

/**
 * Every target the status covers, packages first, in the order `spfn db status`
 * prints them.
 */
export function migrationTargets(status: MigrationStatus): MigrationTargetStatus[]
{
    return [...status.packages, ...(status.project ? [status.project] : [])];
}

/**
 * The targets that still have migrations waiting.
 */
export function pendingMigrationTargets(status: MigrationStatus): MigrationTargetStatus[]
{
    return migrationTargets(status).filter(target => target.pending > 0);
}

/**
 * Total number of migrations waiting across every target.
 */
export function countPendingMigrations(status: MigrationStatus): number
{
    return migrationTargets(status).reduce((sum, target) => sum + target.pending, 0);
}

/**
 * Drivers disagree on the result shape: postgres.js returns the rows, node-postgres
 * wraps them in `{ rows }`, and a stub provider may return nothing at all.
 */
function toRows(result: unknown): Record<string, unknown>[]
{
    if (Array.isArray(result))
    {
        return result as Record<string, unknown>[];
    }

    const rows = (result as { rows?: unknown } | null | undefined)?.rows;

    return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

/**
 * Looked up in `pg_catalog`, which every role can read. `information_schema`
 * lists only tables the current role owns or holds a privilege on, so an app
 * role without grants on schema `drizzle` would find no table and be told every
 * migration is pending. Found here, the table is then read, and a missing
 * privilege surfaces as a permission error — "could not check", never "pending".
 */
async function tableExists(db: MigrationStatusDb, tableName: string): Promise<boolean>
{
    const rows = toRows(await db.execute(sql`
        SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'drizzle' AND c.relname = ${tableName} AND c.relkind IN ('r', 'p')
        ) AS "exists"`));

    return rows[0]?.exists === true;
}

/**
 * drizzle-orm 1.0 records a `name` column; a table without one was written by
 * an earlier drizzle-orm (bookkeeping version 0). The column is looked up in
 * `pg_catalog` for the same reason as the table.
 */
async function hasNameColumn(db: MigrationStatusDb, tableName: string): Promise<boolean>
{
    const rows = toRows(await db.execute(sql`
        SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute a
            JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'drizzle' AND c.relname = ${tableName}
                AND a.attname = 'name' AND a.attnum > 0 AND NOT a.attisdropped
        ) AS "exists"`));

    return rows[0]?.exists === true;
}

/**
 * The newest `created_at` in a package's own table, or undefined while the
 * table is missing or empty.
 */
async function readLastRecordedMillis(db: MigrationStatusDb, tableName: string): Promise<number | undefined>
{
    if (!await tableExists(db, tableName))
    {
        return undefined;
    }

    const rows = toRows(await db.execute(sql`
        SELECT max(created_at) AS "last" FROM drizzle.${sql.identifier(tableName)}`));

    return rows[0]?.last == null ? undefined : Number(rows[0].last);
}

/**
 * The hashes of migration SQL the legacy shared table records, empty when
 * there is no such table.
 */
async function readLegacyHashes(db: MigrationStatusDb): Promise<Set<string>>
{
    if (!await tableExists(db, LEGACY_FUNCTION_MIGRATIONS_TABLE))
    {
        return new Set();
    }

    const rows = toRows(await db.execute(sql`
        SELECT hash FROM drizzle.${sql.identifier(LEGACY_FUNCTION_MIGRATIONS_TABLE)}`));

    return new Set(rows.map(row => String(row.hash)));
}

/**
 * Each function package's pending migrations — the one rule for packages.
 *
 * An entry is pending when it is newer than the package's last record: the
 * newest `created_at` in its own table or, while that table is missing or
 * empty, the newest of its entries whose hash the legacy shared table holds.
 * There is no name rule: the CLI creates package tables without a `name`
 * column. An apply records each entry in the package's own table, so after it
 * that table's newest row is newer than every legacy row it supersedes.
 *
 * The legacy table is read only for a package with entries and no rows of its
 * own, at most once per call; a database where every package has its own rows
 * never touches it, so a role without SELECT on it can still read status. A
 * needed legacy read that fails throws, like any other status read.
 *
 * Reads only, so a read-only connection (`spfn db push --dry-run`) can run it.
 */
export async function pendingFunctionMigrations(
    db: MigrationStatusDb,
    packages: FunctionMigrationSource[],
): Promise<PendingFunctionMigrations[]>
{
    let legacyHashes: Promise<Set<string>> | undefined;
    const pending: PendingFunctionMigrations[] = [];

    for (const { packageName, entries } of packages)
    {
        if (entries.length === 0)
        {
            pending.push({ packageName, entries });
            continue;
        }

        const lastMillis = await readLastRecordedMillis(db, functionMigrationsTable(packageName))
            ?? newestLegacyMillis(entries, await (legacyHashes ??= readLegacyHashes(db)));

        pending.push({ packageName, entries: entries.filter(entry => entry.millis > lastMillis) });
    }

    return pending;
}

/** The newest entry the legacy table records, or -Infinity when it records none. */
function newestLegacyMillis(entries: FunctionMigrationEntry[], legacyHashes: Set<string>): number
{
    return Math.max(
        Number.NEGATIVE_INFINITY,
        ...entries.filter(entry => legacyHashes.has(entry.hash)).map(entry => entry.millis),
    );
}

function toTargetStatus(
    name: string,
    entries: { name: string }[],
    pendingEntries: { name: string }[],
): MigrationTargetStatus
{
    return {
        name,
        total: entries.length,
        applied: entries.length - pendingEntries.length,
        pending: pendingEntries.length,
        pendingTags: pendingEntries.map(entry => entry.name),
    };
}

/**
 * The project's own migrations, decided by drizzle-orm's own code: the folder
 * is read with `readMigrationFiles` and the pending list is `getMigrationsToRun`
 * over the bookkeeping rows — the same two calls `spfn db migrate` makes, so the
 * two cannot disagree. drizzle decides by name alone: an older-stamped
 * migration that was never applied, or a folder renamed after it was applied,
 * is pending.
 *
 * @throws MigrationBookkeepingMismatchError when `spfn db migrate` would refuse
 */
async function collectProjectStatus(db: MigrationStatusDb, migrationsDir: string): Promise<MigrationTargetStatus>
{
    const localMigrations = readProjectMigrations(migrationsDir);
    const pendingMigrations = getMigrationsToRun({
        localMigrations,
        dbMigrations: await readProjectBookkeeping(db, localMigrations),
    });

    return toTargetStatus(PROJECT_TARGET_NAME, localMigrations, pendingMigrations);
}

/**
 * `readMigrationFiles` refuses the drizzle-kit ≤0.31 layout with a plain Error;
 * checked first so it is reported as the mismatch it is, not as an unreadable
 * database.
 */
function readProjectMigrations(migrationsDir: string): MigrationMeta[]
{
    if (existsSync(join(migrationsDir, 'meta', '_journal.json')))
    {
        throw new MigrationBookkeepingMismatchError(
            'The folder uses the old drizzle-kit layout (meta/_journal.json); run `drizzle-kit up`.',
        );
    }

    return readMigrationFiles({ migrationsFolder: migrationsDir });
}

/**
 * The bookkeeping rows drizzle would compare against. A fresh database has no
 * table yet — every migration is pending, which is exactly what a first boot
 * should be told.
 */
async function readProjectBookkeeping(
    db: MigrationStatusDb,
    localMigrations: MigrationMeta[],
): Promise<ProjectBookkeepingRow[]>
{
    if (!await tableExists(db, PROJECT_MIGRATIONS_TABLE))
    {
        return [];
    }

    const table = sql`drizzle.${sql.identifier(PROJECT_MIGRATIONS_TABLE)}`;

    if (await hasNameColumn(db, PROJECT_MIGRATIONS_TABLE))
    {
        return toRows(await db.execute(sql`SELECT id, hash, created_at, name FROM ${table}`)) as ProjectBookkeepingRow[];
    }

    const rows = toRows(await db.execute(sql`SELECT id, hash, created_at FROM ${table} ORDER BY id ASC`));

    return nameVersionZeroRows(rows, localMigrations);
}

/**
 * Names a version-0 table's rows the way drizzle-orm will before it migrates.
 * drizzle's `upgradeIfNeeded` (`drizzle-orm/up-migrations/pg.js`) writes the
 * names it finds, so status cannot call it; this mirrors its matcher without
 * writing. drizzle throws when any row matches no local migration, so status
 * does too.
 */
function nameVersionZeroRows(rows: Record<string, unknown>[], localMigrations: MigrationMeta[]): ProjectBookkeepingRow[]
{
    const match = versionZeroMatcher(localMigrations);
    const named = rows.map(row => ({ ...row, name: match(row)?.name ?? null }) as ProjectBookkeepingRow);
    const unmatchedIds = named.filter(row => row.name === null).map(row => row.id);

    if (unmatchedIds.length > 0)
    {
        throw new MigrationBookkeepingMismatchError(
            `drizzle.${PROJECT_MIGRATIONS_TABLE} was written before drizzle-orm 1.0 and its rows `
            + `(ids: ${unmatchedIds.join(', ')}) match no folder in src/server/drizzle.`,
        );
    }

    return named;
}

/**
 * drizzle's version-0 matcher: a row's `created_at`, truncated to the second,
 * selects the local migrations stamped then. One candidate matches outright,
 * several are told apart by hash, none falls back to the hash alone. Sorted as
 * drizzle sorts, so a hash two folders share resolves to the same folder.
 */
function versionZeroMatcher(localMigrations: MigrationMeta[]): (row: Record<string, unknown>) => MigrationMeta | undefined
{
    const sorted = [...localMigrations].sort((a, b) => a.folderMillis !== b.folderMillis
        ? a.folderMillis - b.folderMillis
        : a.name.localeCompare(b.name));
    const byMillis = new Map<number, MigrationMeta[]>();

    sorted.forEach(migration => byMillis.set(migration.folderMillis, [...byMillis.get(migration.folderMillis) ?? [], migration]));

    const byHash = new Map(sorted.map(migration => [migration.hash, migration]));

    return (row) =>
    {
        const stamp = String(row.created_at);
        const candidates = byMillis.get(Number(`${stamp.substring(0, stamp.length - 3)}000`)) ?? [];

        if (candidates.length > 1)
        {
            return candidates.find(candidate => candidate.hash === row.hash);
        }

        return candidates[0] ?? byHash.get(row.hash as string);
    };
}

/**
 * True when the project has nothing whose migration state could be inspected —
 * no function package ships migrations and there is no project migrations
 * folder. Callers use this to skip the database round-trip entirely.
 */
export function hasMigrationTargets(cwd: string = process.cwd()): boolean
{
    return discoverFunctionMigrations(cwd).length > 0 || existsSync(projectMigrationsDir(cwd));
}

export function projectMigrationsDir(cwd: string = process.cwd()): string
{
    return join(cwd, 'src', 'server', 'drizzle');
}

/**
 * Read applied/pending counts for every function package and for the project.
 *
 * The project's own migrations are included when `src/server/drizzle` exists.
 * A built server image usually does not ship that folder, so the project target
 * is simply absent there — never reported as drift.
 *
 * @throws MigrationBookkeepingMismatchError when `spfn db migrate` would refuse
 * the project's bookkeeping
 */
export async function collectMigrationStatus(
    db: MigrationStatusDb,
    cwd: string = process.cwd(),
): Promise<MigrationStatus>
{
    const sources = discoverFunctionMigrations(cwd).map(func => ({
        packageName: func.packageName,
        entries: readMigrationEntries(func.migrationsDir, func.packageName),
    }));
    const pending = await pendingFunctionMigrations(db, sources);
    const packages = sources.map((source, i) => toTargetStatus(source.packageName, source.entries, pending[i]!.entries));

    const projectDir = projectMigrationsDir(cwd);
    const project = existsSync(projectDir) ? await collectProjectStatus(db, projectDir) : null;

    return { packages, project: project && project.total > 0 ? project : null };
}
