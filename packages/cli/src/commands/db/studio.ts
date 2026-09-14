import chalk from 'chalk';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { findAvailablePort } from './utils/database.js';
import { shouldRelaxDbTls, generateTempConfigOrExit } from './utils/drizzle.js';

import { env } from '@spfn/core/config';

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

    const hasUserConfig = existsSync('./drizzle.config.ts');
    const tempConfigPath = `./drizzle.config.${process.pid}.${Date.now()}.temp.ts`;

    try
    {
        const configPath = hasUserConfig ? './drizzle.config.ts' : tempConfigPath;

        if (!hasUserConfig)
        {
            if (!env.DATABASE_URL)
            {
                console.error(chalk.red('❌ DATABASE_URL not found in environment'));
                console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL to your .env file'));
                process.exit(1);
            }

            writeFileSync(tempConfigPath, await generateTempConfigOrExit({ reconcile: true }));
        }

        // Spawn drizzle-kit studio process
        const studioProcess = spawn('drizzle-kit', ['studio', `--port=${port}`, `--config=${configPath}`], {
            stdio: 'inherit',
            shell: true,
            env: shouldRelaxDbTls(env.DATABASE_URL)
                ? { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
                : { ...process.env },
        });

        // Handle process termination
        const cleanup = () =>
        {
            if (!hasUserConfig && existsSync(tempConfigPath))
            {
                unlinkSync(tempConfigPath);
            }
        };

        studioProcess.on('exit', (code) =>
        {
            cleanup();
            if (code !== 0 && code !== null)
            {
                console.error(chalk.red(`\n❌ Drizzle Studio exited with code ${code}`));
                process.exit(code);
            }
        });

        studioProcess.on('error', (error) =>
        {
            cleanup();
            console.error(chalk.red('❌ Failed to start Drizzle Studio'));
            console.error(chalk.red(error.message));
            process.exit(1);
        });

        // Handle Ctrl+C gracefully
        process.on('SIGINT', () =>
        {
            console.log(chalk.yellow('\n\n👋 Shutting down Drizzle Studio...'));
            studioProcess.kill('SIGTERM');
            cleanup();
            process.exit(0);
        });

        process.on('SIGTERM', () =>
        {
            studioProcess.kill('SIGTERM');
            cleanup();
            process.exit(0);
        });
    }
    catch (error)
    {
        // Clean up temp config on error
        if (!hasUserConfig && existsSync(tempConfigPath))
        {
            unlinkSync(tempConfigPath);
        }

        console.error(chalk.red('❌ Failed to start Drizzle Studio'));
        console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
        process.exit(1);
    }
}
