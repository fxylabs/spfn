import chalk from 'chalk';
import prompts from 'prompts';
import { loadEnv } from '@spfn/core/server';
import { runWithSpinner } from './utils/drizzle.js';
import { OWNER_URL_MISSING, ownerDatabaseUrl, parseDatabaseUrl, confirmDangerousTarget } from './utils/database.js';

/**
 * Drop all database tables (dangerous!)
 *
 * Connects as the table owner (DATABASE_OWNER_URL, else DATABASE_URL): only
 * the owner may drop the tables.
 */
export async function dbDrop(): Promise<void>
{
    loadEnv();

    const databaseUrl = ownerDatabaseUrl();

    if (!databaseUrl)
    {
        console.error(chalk.red(OWNER_URL_MISSING));
        console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL to your .env file'));
        process.exit(1);
    }

    const dbInfo = parseDatabaseUrl(databaseUrl);

    console.log(chalk.yellow('⚠️  WARNING: This will drop all tables in your database!'));
    console.log(chalk.dim(`   Target: ${dbInfo.database} @ ${dbInfo.host}:${dbInfo.port}\n`));

    // Confirmation prompt
    const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to drop all tables?',
        initial: false,
    });

    if (!confirm)
    {
        console.log(chalk.gray('Cancelled.'));
        process.exit(0);
    }

    await confirmDangerousTarget(dbInfo);

    await runWithSpinner(
        'Dropping all tables...',
        'drop',
        'All tables dropped',
        'Failed to drop tables',
        databaseUrl,
    );
}
