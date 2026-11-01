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
 * Minimal DB surface the runner needs. Adapters exist for postgres.js (runtime)
 * and PGlite (tests).
 */
export interface MigrationDb
{
    query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
    transaction<T>(fn: (tx: MigrationDb) => Promise<T>): Promise<T>;
}

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
    const legacyCheck = await db.query(
        `SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'drizzle' AND table_name = '__spfn_fn_migrations'
        ) AS "exists"`,
    );

    if (!legacyCheck[0]?.exists)
    {
        return;
    }

    console.log(chalk.dim('\n  Migrating legacy shared migration table to per-package tables...'));

    const legacyRows = await db.query(
        `SELECT hash, created_at FROM drizzle."__spfn_fn_migrations" ORDER BY id`,
    ) as { hash: string; created_at: string }[];

    if (legacyRows.length === 0)
    {
        await db.query(`DROP TABLE drizzle."__spfn_fn_migrations"`);

        return;
    }

    const legacyHashes = new Set(legacyRows.map(row => row.hash));

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
        let copied = 0;
        for (const entry of plan.entries)
        {
            if (!legacyHashes.has(entry.hash))
            {
                continue;
            }

            await db.query(
                `INSERT INTO drizzle."${tableName}" (hash, created_at) VALUES ($1, $2)`,
                [entry.hash, entry.millis],
            );
            copied++;
        }

        if (copied > 0)
        {
            console.log(chalk.dim(`    ✓ ${plan.packageName}: copied ${copied} migration record(s)`));
        }
    }

    await db.query(`DROP TABLE drizzle."__spfn_fn_migrations"`);
    console.log(chalk.dim('    ✓ Legacy migration table removed\n'));
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
 * Apply one package's pending migrations inside a transaction.
 *
 * Pending = entries newer than the last applied record — the same
 * timestamp-based rule drizzle-orm ≤0.45 used for these tables, so databases
 * migrated by earlier CLI versions continue seamlessly.
 */
export async function applyFunctionMigrationPlan(
    db: MigrationDb,
    plan: FunctionMigrationPlan,
): Promise<number>
{
    const tableName = functionMigrationsTable(plan.packageName);

    await ensureMigrationsTable(db, tableName);

    const rows = await db.query(
        `SELECT created_at FROM drizzle."${tableName}" ORDER BY created_at DESC LIMIT 1`,
    );
    const lastMillis = rows.length > 0 ? Number(rows[0]?.created_at) : Number.NEGATIVE_INFINITY;
    const pending = plan.entries.filter(entry => entry.millis > lastMillis);

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
