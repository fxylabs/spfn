import chalk from 'chalk';
import { join } from 'path';
import { existsSync } from 'fs';
import { dbBackup } from './backup.js';
import { OWNER_URL_MISSING, ownerDatabaseUrl } from './utils/database.js';

import { loadEnv } from '@spfn/core/server';

/**
 * Project migrations use the default drizzle migrations table.
 */
const PROJECT_MIGRATIONS_TABLE = '__drizzle_migrations';

/**
 * Run pending migrations
 *
 * This command applies migrations created by `spfn db generate`.
 * Also applies function package migrations if available.
 * Use this in both development and production environments.
 *
 * Connects as the table owner: DATABASE_OWNER_URL, else DATABASE_URL.
 */
export async function dbMigrate(options: { withBackup?: boolean } = {}): Promise<void>
{
    // Validate prerequisites before starting any migrations
    loadEnv();
    const databaseUrl = ownerDatabaseUrl();

    if (!databaseUrl)
    {
        console.error(chalk.red(OWNER_URL_MISSING));
        console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL (and DATABASE_OWNER_URL for the table owner) to your .env file'));
        process.exit(1);
    }

    // Create backup before migration if requested
    if (options.withBackup)
    {
        console.log(chalk.blue('📦 Creating pre-migration backup...\n'));
        await dbBackup({
            format: 'custom',
            tag: 'pre-migration',
            env: process.env.NODE_ENV,
        });
        console.log('');
    }

    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const postgres = await import('postgres');

    // First, execute function package migrations (per-package tables)
    const { discoverFunctionMigrations, loadFunctionMigrationPlans, executeFunctionMigrations } =
        await import('../../utils/function-migrations.js');
    const functions = discoverFunctionMigrations(process.cwd());

    if (functions.length > 0)
    {
        console.log(chalk.blue('📦 Applying function package migrations:'));
        functions.forEach(func =>
        {
            console.log(chalk.dim(`  - ${func.packageName}`));
        });

        await executeFunctionMigrations(loadFunctionMigrationPlans(functions), databaseUrl);
        console.log(chalk.green('✅ Function migrations applied\n'));
    }

    // Then, run project migrations (separate table to avoid timestamp conflicts)
    const projectMigrationsDir = join(process.cwd(), 'src/server/drizzle');
    if (existsSync(projectMigrationsDir))
    {
        const projConn = postgres.default(databaseUrl, { max: 1 });
        const projDb = drizzle({ client: projConn });

        try
        {
            console.log(chalk.blue('📦 Running project migrations...'));
            await migrate(projDb, {
                migrationsFolder: projectMigrationsDir,
                migrationsTable: PROJECT_MIGRATIONS_TABLE,
            });
            console.log(chalk.green('✅ Project migrations applied successfully'));
        }
        finally
        {
            await projConn.end();
        }
    }
    else
    {
        console.log(chalk.dim('No project migrations found (src/server/drizzle)'));
    }
}
