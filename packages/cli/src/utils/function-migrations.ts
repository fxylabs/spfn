/**
 * Function Package Migration Execution
 *
 * Applies the migrations shipped by SPFN function packages (e.g., @spfn/cms).
 * Discovery, folder reading and the rule for what is pending live in
 * `@spfn/core/db` (`pendingFunctionMigrations`): `spfn db status`, the server's
 * boot gate, its health endpoint, the `spfn db push` preview and every apply
 * here read that one rule. This module owns only the half that writes, and it
 * writes only each package's own table — the legacy shared table is read by
 * the rule and never touched.
 */

import chalk from 'chalk';

import {
    discoverFunctionMigrations,
    functionMigrationsTable,
    pendingFunctionMigrations,
    readMigrationEntries,
    type FunctionMigrationEntry,
    type FunctionMigrationInfo,
    type MigrationStatusDb,
} from '@spfn/core/db';
import { env } from '@spfn/core/config';
import { loadEnv } from '@spfn/core/server';
import { failingIn } from './database-failure.js';

export { discoverFunctionMigrations, readMigrationEntries };
export type { FunctionMigrationEntry, FunctionMigrationInfo };

export type FunctionMigrationPlan = FunctionMigrationInfo & {
    entries: FunctionMigrationEntry[];
};

/**
 * Raw SQL on one connection or transaction.
 */
export interface MigrationQueries
{
    query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Minimal DB surface the runner needs: `execute` for core's pending rule, raw
 * queries and a transaction for the writes. Adapters exist for postgres.js
 * (runtime) and PGlite (tests).
 */
export interface MigrationDb extends MigrationStatusDb, MigrationQueries
{
    transaction<T>(fn: (tx: MigrationQueries) => Promise<T>): Promise<T>;
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

async function ensureMigrationsTable(db: MigrationQueries, tableName: string): Promise<void>
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
 * Apply one package's pending migrations (`pendingFunctionMigrations`) inside
 * a transaction. Writes nothing when none is pending. A failed statement names
 * its migration (`failingIn`).
 */
export async function applyFunctionMigrationPlan(
    db: MigrationDb,
    plan: FunctionMigrationPlan,
): Promise<number>
{
    const tableName = functionMigrationsTable(plan.packageName);
    const [{ entries: pending }] = await pendingFunctionMigrations(db, [plan]);

    if (pending.length === 0)
    {
        return 0;
    }

    await ensureMigrationsTable(db, tableName);

    await db.transaction(async tx =>
    {
        for (const entry of pending)
        {
            for (const statement of entry.statements)
            {
                await failingIn(`${plan.packageName} migration ${entry.name}`, tx.query(statement));
            }

            await tx.query(
                `INSERT INTO drizzle."${tableName}" (hash, created_at) VALUES ($1, $2)`,
                [entry.hash, entry.millis],
            );
        }
    });

    return pending.length;
}

function postgresJsQueries(client: any): MigrationQueries
{
    return { query: (text, params) => client.unsafe(text, params ?? []) };
}

async function createPostgresJsMigrationDb(client: any): Promise<MigrationDb>
{
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const statusDb = drizzle({ client });

    return {
        ...postgresJsQueries(client),
        execute: query => statusDb.execute(query),
        transaction: fn => client.begin((tx: any) => fn(postgresJsQueries(tx))),
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
    const db = await createPostgresJsMigrationDb(connection);
    let appliedCount = 0;

    try
    {
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
