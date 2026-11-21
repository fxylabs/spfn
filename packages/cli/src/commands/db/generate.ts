import chalk from 'chalk';
import { runDrizzleCommand } from './utils/drizzle.js';
import { databaseUrlFor, loadEnvFor } from '../../utils/database-connection.js';

/**
 * Generate database migrations from schema changes
 * Uses interactive mode to support drizzle-kit prompts
 */
export async function dbGenerate(): Promise<void>
{
    try
    {
        loadEnvFor('db generate');
        await runDrizzleCommand('generate', databaseUrlFor('db generate'));
        console.log(chalk.green('\n✅ Migrations generated successfully'));
    }
    catch (error)
    {
        console.error(chalk.red('\n❌ Failed to generate migrations'));
        console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
        process.exit(1);
    }
}
