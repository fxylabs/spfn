/**
 * Migration status for the CLI
 *
 * `spfn db status` and the `spfn dev` / `spfn start` pre-flight check both read
 * migration state through `@spfn/core/db`, which is the same implementation the
 * server's boot gate and health endpoint use. This module only opens a
 * short-lived connection for the commands that run outside a server.
 */

import chalk from 'chalk';

import {
    collectMigrationStatus,
    formatPendingMigrations,
    pendingMigrationTargets,
    pendingMigrationsSummary,
    RUN_MIGRATIONS_HINT,
    type MigrationStatus,
    type MigrationTargetStatus,
} from '@spfn/core/db';
import { env } from '@spfn/core/config';
import { loadEnv } from '@spfn/core/server';

export {
    functionMigrationsTable,
    migrationTargets,
    pendingMigrationTargets,
} from '@spfn/core/db';

export type { MigrationStatus, MigrationTargetStatus };

/**
 * Collect applied/pending status for all function packages and the project.
 * Throws when DATABASE_URL is missing or the database is unreachable.
 */
export async function getMigrationStatus(
    cwd: string = process.cwd(),
    databaseUrl?: string,
): Promise<MigrationStatus>
{
    loadEnv();
    const url = databaseUrl ?? env.DATABASE_URL;

    if (!url)
    {
        throw new Error('DATABASE_URL not found in environment');
    }

    const { drizzle } = await import('drizzle-orm/postgres-js');
    const postgres = await import('postgres');
    const connection = postgres.default(url, { max: 1, connect_timeout: 5 });

    try
    {
        return await collectMigrationStatus(drizzle({ client: connection }), cwd);
    }
    finally
    {
        await connection.end();
    }
}

export type StartupMigrationCheck = {
    /** The caller must stop: migrations are pending and nothing allows it. */
    block: boolean;
    /** Pass this on to the server process so it makes the same decision. */
    allowPending: boolean;
};

/**
 * Pre-flight check for `spfn dev` and `spfn start`.
 *
 * The server refuses the same boot by itself — this runs first only so the
 * refusal is immediate and readable instead of arriving as a child process that
 * died while the CLI waited for a readiness signal.
 *
 * Silent when there is no database to ask: a project without DATABASE_URL, or a
 * database that cannot be reached, is not migration drift and must not be
 * reported as such.
 *
 * The environment variable is read through `@spfn/core/config`, the same
 * accessor the server's gate uses, so `1` and `yes` mean here what they mean
 * there — the CLI must never refuse a boot the server would have allowed.
 */
export async function checkPendingMigrationsBeforeStart(
    cwd: string,
    databaseUrl: string | undefined,
    flagAllowsPending: boolean,
): Promise<StartupMigrationCheck>
{
    loadEnv();

    const allowPending = flagAllowsPending || env.SPFN_ALLOW_PENDING_MIGRATIONS === true;

    let status: MigrationStatus;

    try
    {
        status = await getMigrationStatus(cwd, databaseUrl);
    }
    catch
    {
        // "Could not check" is not "checked and pending" — never block on it.
        return { block: false, allowPending };
    }

    const targets = pendingMigrationTargets(status);

    if (targets.length === 0)
    {
        return { block: false, allowPending };
    }

    const lines = formatPendingMigrations(targets);

    console.log('');

    if (allowPending)
    {
        console.warn(chalk.yellow(`⚠️  Starting with pending migrations — ${pendingMigrationsSummary(targets)}`));
        lines.forEach(line => console.warn(chalk.yellow(`   ${line}`)));
        console.warn(chalk.yellow(`   Requests hitting the missing columns will fail. ${RUN_MIGRATIONS_HINT}\n`));

        return { block: false, allowPending };
    }

    console.error(chalk.red(`❌ Refusing to start: ${pendingMigrationsSummary(targets)}`));
    lines.forEach(line => console.error(chalk.red(`   ${line}`)));
    console.error(chalk.yellow(`\n   ${RUN_MIGRATIONS_HINT}`));
    console.error(chalk.dim('   To start anyway: --allow-pending-migrations, or SPFN_ALLOW_PENDING_MIGRATIONS=true\n'));

    return { block: true, allowPending };
}
