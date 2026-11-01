/**
 * Migration Status Inspection
 *
 * Compares what each migration folder ships (function packages, plus the
 * project's own `src/server/drizzle`) against what the database records as
 * applied. `spfn db status`, the server's boot gate and the detailed health
 * endpoint all read this one implementation.
 */

import { existsSync } from 'fs';
import { join } from 'path';

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

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
 * An entry counts as applied when its name is recorded (drizzle-orm 1.0
 * projects) or its timestamp is not newer than the last applied record —
 * the rule the CLI's function-migration runner and drizzle-orm ≤0.45 share.
 */
export function filterPendingEntries(
    entries: FunctionMigrationEntry[],
    lastAppliedMillis: number,
    appliedNames: Set<string>,
): FunctionMigrationEntry[]
{
    return entries.filter(entry => entry.millis > lastAppliedMillis && !appliedNames.has(entry.name));
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
 * drizzle-orm 1.0 records a `name` column and treats a migration as applied
 * when its name is present; CLI-owned per-package tables have no such column.
 * The column is looked up in `pg_catalog` for the same reason as the table.
 */
async function readAppliedNames(db: MigrationStatusDb, tableName: string): Promise<Set<string>>
{
    const columnRows = toRows(await db.execute(sql`
        SELECT EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute a
            JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'drizzle' AND c.relname = ${tableName}
                AND a.attname = 'name' AND a.attnum > 0 AND NOT a.attisdropped
        ) AS "exists"`));

    if (columnRows[0]?.exists !== true)
    {
        return new Set();
    }

    const rows = toRows(await db.execute(sql`
        SELECT name FROM drizzle.${sql.identifier(tableName)} WHERE name IS NOT NULL`));

    return new Set(rows.map(row => String(row.name)));
}

async function collectTargetStatus(
    db: MigrationStatusDb,
    name: string,
    migrationsDir: string,
    tableName: string,
): Promise<MigrationTargetStatus>
{
    const entries = readMigrationEntries(migrationsDir, name);

    let lastApplied = 0;
    let appliedNames = new Set<string>();

    // A fresh database has no bookkeeping table yet — every entry is pending,
    // which is exactly what a first boot should be told.
    if (await tableExists(db, tableName))
    {
        const rows = toRows(await db.execute(sql`
            SELECT created_at FROM drizzle.${sql.identifier(tableName)}
            ORDER BY created_at DESC LIMIT 1`));

        lastApplied = rows[0]?.created_at ? Number(rows[0].created_at) : 0;
        appliedNames = await readAppliedNames(db, tableName);
    }

    const pendingEntries = filterPendingEntries(entries, lastApplied, appliedNames);

    return {
        name,
        total: entries.length,
        applied: entries.length - pendingEntries.length,
        pending: pendingEntries.length,
        pendingTags: pendingEntries.map(entry => entry.name),
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
 */
export async function collectMigrationStatus(
    db: MigrationStatusDb,
    cwd: string = process.cwd(),
): Promise<MigrationStatus>
{
    const packages: MigrationTargetStatus[] = [];

    for (const func of discoverFunctionMigrations(cwd))
    {
        packages.push(await collectTargetStatus(
            db,
            func.packageName,
            func.migrationsDir,
            functionMigrationsTable(func.packageName),
        ));
    }

    const projectDir = projectMigrationsDir(cwd);
    const project = existsSync(projectDir)
        ? await collectTargetStatus(db, PROJECT_TARGET_NAME, projectDir, PROJECT_MIGRATIONS_TABLE)
        : null;

    return { packages, project: project && project.total > 0 ? project : null };
}
