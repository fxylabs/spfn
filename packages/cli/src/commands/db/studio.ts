import chalk from 'chalk';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { findAvailablePort } from './utils/database.js';
import { shouldRelaxDbTls, generateTempConfigOrExit } from './utils/drizzle.js';
import { writeTempDrizzleConfig, type TempDrizzleConfig } from './utils/temp-config.js';
import { databaseUrlFor, loadEnvFor } from '../../utils/database-connection.js';

/**
 * Open Drizzle Studio (database GUI)
 * Uses spawn instead of exec to handle long-running process
 */
export async function dbStudio(requestedPort?: number): Promise<void>
{
    console.log(chalk.blue('🎨 Opening Drizzle Studio...\n'));

    // Find available port
    const defaultPort = 4983;
    const startPort = requestedPort || defaultPort;
    let port: number;

    try
    {
        port = await findAvailablePort(startPort);

        if (port !== startPort)
        {
            console.log(chalk.yellow(`⚠️  Port ${startPort} is in use, using port ${port} instead\n`));
        }
    }
    catch (error)
    {
        console.error(chalk.red(error instanceof Error ? error.message : 'Failed to find available port'));
        process.exit(1);
    }

    loadEnvFor('db studio');

    const databaseUrl = databaseUrlFor('db studio');
    let tempConfig: TempDrizzleConfig | undefined;

    try
    {
        if (!existsSync('./drizzle.config.ts'))
        {
            if (!databaseUrl)
            {
                console.error(chalk.red('❌ DATABASE_URL not found in environment'));
                console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL to your .env file'));
                process.exit(1);
            }

            tempConfig = writeTempDrizzleConfig(await generateTempConfigOrExit({ reconcile: true, databaseUrl }));
        }

        const configPath = tempConfig?.path ?? './drizzle.config.ts';

        // Spawn drizzle-kit studio process
        const studioProcess = spawn('drizzle-kit', ['studio', `--port=${port}`, `--config=${configPath}`], {
            stdio: 'inherit',
            shell: true,
            env: shouldRelaxDbTls(databaseUrl)
                ? { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
                : { ...process.env },
        });

        studioProcess.on('exit', (code) =>
        {
            tempConfig?.remove();
            if (code !== 0 && code !== null)
            {
                console.error(chalk.red(`\n❌ Drizzle Studio exited with code ${code}`));
                process.exit(code);
            }
        });

        studioProcess.on('error', (error) =>
        {
            tempConfig?.remove();
            console.error(chalk.red('❌ Failed to start Drizzle Studio'));
            console.error(chalk.red(error.message));
            process.exit(1);
        });

        // Handle Ctrl+C gracefully
        process.on('SIGINT', () =>
        {
            console.log(chalk.yellow('\n\n👋 Shutting down Drizzle Studio...'));
            studioProcess.kill('SIGTERM');
            tempConfig?.remove();
            process.exit(0);
        });

        process.on('SIGTERM', () =>
        {
            studioProcess.kill('SIGTERM');
            tempConfig?.remove();
            process.exit(0);
        });
    }
    catch (error)
    {
        tempConfig?.remove();

        console.error(chalk.red('❌ Failed to start Drizzle Studio'));
        console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
        process.exit(1);
    }
}
