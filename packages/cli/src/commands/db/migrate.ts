import chalk from 'chalk';
import { join } from 'path';
import { existsSync } from 'fs';
import { dbBackup } from './backup.js';
import { OWNER_URL_MISSING } from './utils/database.js';

import { databaseUrlFor, loadEnvFor } from '../../utils/database-connection.js';
import { discoverFunctionMigrations } from '../../utils/function-migrations.js';
import { exitOnGrantFailure, manifestGrantTargetOrExit } from './utils/app-grants.js';
import { checkQueueSchemaOrExit, readJobsDeclarationOrExit, runOwnerStepsOn } from './utils/queue-step.js';

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
 * Connects as the table owner: DATABASE_OWNER_URL, else DATABASE_URL. Then,
 * when package.json declares jobs, the queue schema is installed or migrated
 * as that role (queue-step.ts). Last, the app role is granted what the
 * manifests declare, and the queue (app-grants.ts), in a transaction of its
 * own; an unreadable manifest or jobs declaration, or a queue schema the step
 * would refuse as it is (`checkQueueSchema`), ends the command before any
 * migration, a failed queue step or grant after them, saying to run
 * `spfn db grant`.
 */
export async function dbMigrate(options: { withBackup?: boolean } = {}): Promise<void>
{
    // Validate prerequisites before starting any migrations
    loadEnvFor('db migrate');
    const databaseUrl = databaseUrlFor('db migrate');

    if (!databaseUrl)
    {
        console.error(chalk.red(OWNER_URL_MISSING));
        console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL (and DATABASE_OWNER_URL for the table owner) to your .env file'));
        process.exit(1);
    }

    // What the app role is granted at the end, and what the queue step would
    // refuse, read before anything is applied
    const functions = discoverFunctionMigrations(process.cwd());
    const grantTarget = manifestGrantTargetOrExit(functions);
    const jobs = readJobsDeclarationOrExit();
    await checkQueueSchemaOrExit(databaseUrl, grantTarget, jobs);

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
    const { loadFunctionMigrationPlans, executeFunctionMigrations } = await import('../../utils/function-migrations.js');

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

    await runOwnerStepsOn(databaseUrl, grantTarget, jobs).catch(error => exitOnGrantFailure(error, databaseUrl));
}
