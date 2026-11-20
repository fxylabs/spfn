/**
 * Function Package Migration Execution
 *
 * Applies the migrations shipped by SPFN function packages (e.g., @spfn/cms).
 * Discovery and folder reading live in `@spfn/core/db` — the server's boot gate
 * and its health endpoint read migration state from the same implementation, so
 * `spfn db migrate` and a running server can never disagree about what "pending"
 * means. This module owns only the half that writes.
 */

import chalk from 'chalk';

import {
    discoverFunctionMigrations,
    functionMigrationsTable,
    readMigrationEntries,
    type FunctionMigrationEntry,
    type FunctionMigrationInfo,
} from '@spfn/core/db';
import { env } from '@spfn/core/config';
import { loadEnv } from '@spfn/core/server';

export { discoverFunctionMigrations, readMigrationEntries };
export type { FunctionMigrationEntry, FunctionMigrationInfo };

export type FunctionMigrationPlan = FunctionMigrationInfo & {
    entries: FunctionMigrationEntry[];
};

/**
 * What working out the pending migrations needs: queries only. `spfn db push`
 * passes its own connection, read-only on a dry run.
 */
export interface MigrationReader
{
    query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Minimal DB surface the runner needs. Adapters exist for postgres.js (runtime)
 * and PGlite (tests).
 */
export interface MigrationDb extends MigrationReader
{
    transaction<T>(fn: (tx: MigrationDb) => Promise<T>): Promise<T>;
}

export type PendingFunctionMigrations = {
    packageName: string;
    entries: FunctionMigrationEntry[];
};

/**
 * Parse migration folders for all packages up front, so a broken package fails
 * before anything touches the database.
 */
export function loadFunctionMigrationPlans(functionMigrations: FunctionMigrationInfo[]): FunctionMigrationPlan[]
{
    return functionMigrations.map(func => ({
        ...func,
        entries: readMigrationEntries(func.migrationsDir, func.packageName),
    }));
}

/**
 * Migrate legacy shared __spfn_fn_migrations table to per-package tables.
 *
 * Previous versions used a single shared table for all packages, causing
 * index-based hash conflicts. This copies each package's migration hashes
 * from the legacy table (matched by hash) into per-package tables,
 * then drops the legacy table.
 */
async function migrateLegacyTable(
    db: MigrationDb,
    plans: FunctionMigrationPlan[],
): Promise<void>
{
    const legacyHashes = await readLegacyHashes(db);

    if (!legacyHashes)
    {
        return;
    }

    console.log(chalk.dim('\n  Migrating legacy shared migration table to per-package tables...'));

    if (legacyHashes.size === 0)
    {
        await db.query(`DROP TABLE drizzle."__spfn_fn_migrations"`);

        return;
    }

    for (const plan of plans)
    {
        const tableName = functionMigrationsTable(plan.packageName);

        await ensureMigrationsTable(db, tableName);

        // Skip packages that already have per-package records
        const existing = await db.query(
            `SELECT COUNT(*) AS "count" FROM drizzle."${tableName}"`,
        );

        if (Number(existing[0]?.count) > 0)
        {
            continue;
        }

        // The legacy table stores sha256 hashes of migration SQL content, so a
        // hash match identifies which legacy rows belong to this package.
        const legacyEntries = plan.entries.filter(entry => legacyHashes.has(entry.hash));

        for (const entry of legacyEntries)
        {
            await db.query(
                `INSERT INTO drizzle."${tableName}" (hash, created_at) VALUES ($1, $2)`,
                [entry.hash, entry.millis],
            );
        }

        if (legacyEntries.length > 0)
        {
            console.log(chalk.dim(`    ✓ ${plan.packageName}: copied ${legacyEntries.length} migration record(s)`));
        }
    }

    await db.query(`DROP TABLE drizzle."__spfn_fn_migrations"`);
    console.log(chalk.dim('    ✓ Legacy migration table removed\n'));
}

/**
 * The hashes in the legacy shared table, or undefined when there is none.
 */
async function readLegacyHashes(db: MigrationReader): Promise<Set<string> | undefined>
{
    const legacyCheck = await db.query(
        `SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'drizzle' AND table_name = '__spfn_fn_migrations'
        ) AS "exists"`,
    );

    if (!legacyCheck[0]?.exists)
    {
        return undefined;
    }

    const legacyRows = await db.query(`SELECT hash FROM drizzle."__spfn_fn_migrations" ORDER BY id`);

    return new Set(legacyRows.map(row => String(row.hash)));
}

/**
 * The newest `created_at` in a package's table, or undefined when the table is
 * missing or empty. Looked up in `pg_catalog`, which needs no `drizzle` schema.
 */
async function readLastRecordedMillis(db: MigrationReader, tableName: string): Promise<number | undefined>
{
    const exists = await db.query(`SELECT to_regclass($1) IS NOT NULL AS "exists"`, [`drizzle."${tableName}"`]);

    if (!exists[0]?.exists)
    {
        return undefined;
    }

    const rows = await db.query(
        `SELECT created_at FROM drizzle."${tableName}" ORDER BY created_at DESC LIMIT 1`,
    );

    return rows.length > 0 ? Number(rows[0]?.created_at) : undefined;
}

/**
 * Each package's pending migrations, without writing anything.
 *
 * Pending = entries newer than the last applied record — the same
 * timestamp-based rule drizzle-orm ≤0.45 used for these tables, so databases
 * migrated by earlier CLI versions continue seamlessly. A package with no
 * record yet counts what the legacy shared table holds, as migrateLegacyTable
 * would copy it. Applying reads its pending list here too, so a preview and
 * the run after it cannot disagree.
 */
export async function resolvePendingFunctionMigrations(
    db: MigrationReader,
    plans: FunctionMigrationPlan[],
): Promise<PendingFunctionMigrations[]>
{
    const legacyHashes = await readLegacyHashes(db) ?? new Set<string>();
    const pending: PendingFunctionMigrations[] = [];

    for (const plan of plans)
    {
        const legacyMillis = plan.entries.filter(entry => legacyHashes.has(entry.hash)).map(entry => entry.millis);
        const lastMillis = await readLastRecordedMillis(db, functionMigrationsTable(plan.packageName))
            ?? Math.max(Number.NEGATIVE_INFINITY, ...legacyMillis);

        pending.push({ packageName: plan.packageName, entries: plan.entries.filter(entry => entry.millis > lastMillis) });
    }

    return pending;
}

async function ensureMigrationsTable(db: MigrationDb, tableName: string): Promise<void>
{
    await db.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
    await db.query(
        `CREATE TABLE IF NOT EXISTS drizzle."${tableName}" (
            id serial PRIMARY KEY,
            hash text NOT NULL,
            created_at bigint
        )`,
    );
}

/**
 * Apply one package's pending migrations (resolvePendingFunctionMigrations)
 * inside a transaction.
 */
export async function applyFunctionMigrationPlan(
    db: MigrationDb,
    plan: FunctionMigrationPlan,
): Promise<number>
{
    const tableName = functionMigrationsTable(plan.packageName);

    await ensureMigrationsTable(db, tableName);

    const [{ entries: pending }] = await resolvePendingFunctionMigrations(db, [plan]);

    if (pending.length === 0)
    {
        return 0;
    }

    await db.transaction(async tx =>
    {
        for (const entry of pending)
        {
            for (const statement of entry.statements)
            {
                await tx.query(statement);
            }

            await tx.query(
                `INSERT INTO drizzle."${tableName}" (hash, created_at) VALUES ($1, $2)`,
                [entry.hash, entry.millis],
            );
        }
    });

    return pending.length;
}

function createPostgresJsMigrationDb(client: any): MigrationDb
{
    return {
        query: (text, params) => client.unsafe(text, params ?? []),
        transaction: fn => client.begin((tx: any) => fn(createPostgresJsMigrationDb(tx))),
    };
}

/**
 * Execute function package migrations directly (no copying)
 * Returns the number of migrations applied
 */
export async function executeFunctionMigrations(
    plans: FunctionMigrationPlan[],
    databaseUrl?: string,
): Promise<number>
{
    const postgres = await import('postgres');

    loadEnv();
    const url = databaseUrl ?? env.DATABASE_URL;

    if (!url)
    {
        throw new Error('DATABASE_URL not found in environment');
    }

    const connection = postgres.default(url, { max: 1 });
    const db = createPostgresJsMigrationDb(connection);
    let appliedCount = 0;

    try
    {
        // Migrate legacy shared table to per-package tables (one-time)
        await migrateLegacyTable(db, plans);

        for (const plan of plans)
        {
            console.log(chalk.blue(`\n  📦 Running ${plan.packageName} migrations...`));

            const applied = await applyFunctionMigrationPlan(db, plan);

            console.log(applied > 0
                ? chalk.green(`  ✓ ${plan.packageName}: ${applied} migration(s) applied`)
                : chalk.dim(`  – ${plan.packageName}: up to date`));
            appliedCount += applied;
        }
    }
    finally
    {
        await connection.end();
    }

    return appliedCount;
}
