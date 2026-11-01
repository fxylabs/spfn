import path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { loadEnv } from '@spfn/core/server';
import { OWNER_URL_MISSING, ownerDatabaseUrl, parseDatabaseUrl, confirmDangerousTarget } from './utils/database.js';
import { listBackupFiles } from './utils/backup-files.js';
import {
    loadBackupMetadata,
    collectGitInfo,
    collectMigrationInfo,
} from './utils/metadata.js';

/**
 * Restore database from backup file
 *
 * Connects as the table owner (DATABASE_OWNER_URL, else DATABASE_URL):
 * PostgreSQL refuses `COPY FROM` into a table whose row-level security policy
 * applies to the role, and the restored tables must belong to the owner.
 */
export async function dbRestore(backupFile?: string, options: { drop?: boolean; schema?: string; dataOnly?: boolean; schemaOnly?: boolean; verbose?: boolean } = {}): Promise<void>
{
    console.log(chalk.blue('♻️  Restoring database from backup...\n'));

    loadEnv();
    const dbUrl = ownerDatabaseUrl();
    if (!dbUrl)
    {
        console.error(chalk.red(OWNER_URL_MISSING));
        console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL to your .env file'));
        process.exit(1);
    }

    let file = backupFile;

    // If no file specified, show list and let user select
    if (!file)
    {
        const backups = await listBackupFiles();

        if (backups.length === 0)
        {
            console.log(chalk.yellow('No backups found in ./backups directory'));
            process.exit(0);
        }

        const { selected } = await prompts({
            type: 'select',
            name: 'selected',
            message: 'Select backup to restore:',
            choices: backups.map(b => ({
                title: `${b.name} (${b.size})`,
                value: b.path,
            })),
        });

        if (!selected)
        {
            console.log(chalk.gray('Cancelled'));
            process.exit(0);
        }

        file = selected;
    }

    // Type guard to ensure file is defined
    if (!file)
    {
        console.error(chalk.red('❌ No backup file selected'));
        process.exit(1);
    }

    // Load and check backup metadata
    const metadata = await loadBackupMetadata(file);

    if (metadata)
    {
        console.log(chalk.blue('\n📋 Backup Information:\n'));
        console.log(chalk.dim(`  Database: ${metadata.database}`));
        console.log(chalk.dim(`  Created: ${new Date(metadata.timestamp).toLocaleString()}`));

        if (metadata.environment)
        {
            console.log(chalk.dim(`  Environment: ${metadata.environment}`));
        }

        if (metadata.tags && metadata.tags.length > 0)
        {
            console.log(chalk.dim(`  Tags: ${metadata.tags.join(', ')}`));
        }

        if (metadata.backup.dataOnly)
        {
            console.log(chalk.yellow('  ⚠️  Data-only backup (no schema)'));
        }

        if (metadata.backup.schemaOnly)
        {
            console.log(chalk.yellow('  ⚠️  Schema-only backup (no data)'));
        }

        // Check version compatibility
        const warnings: string[] = [];

        // Get current git and migration info
        const [currentGitInfo, currentMigrationInfo] = await Promise.all([
            collectGitInfo(),
            collectMigrationInfo(dbUrl),
        ]);

        // Check Git version mismatch
        if (metadata.git && currentGitInfo)
        {
            if (metadata.git.commit !== currentGitInfo.commit)
            {
                warnings.push(`Git commit mismatch: backup from ${metadata.git.commit.substring(0, 7)}, current is ${currentGitInfo.commit.substring(0, 7)}`);
            }

            if (metadata.git.branch !== currentGitInfo.branch)
            {
                warnings.push(`Git branch mismatch: backup from '${metadata.git.branch}', current is '${currentGitInfo.branch}'`);
            }
        }

        // Check Migration version mismatch
        if (metadata.migrations && currentMigrationInfo)
        {
            if (metadata.migrations.hash !== currentMigrationInfo.hash)
            {
                warnings.push(`Migration version mismatch: backup has ${metadata.migrations.count} migrations, current has ${currentMigrationInfo.count}`);
                warnings.push(`  Last migration in backup: ${metadata.migrations.hash}`);
                warnings.push(`  Current last migration: ${currentMigrationInfo.hash}`);
            }
        }

        if (warnings.length > 0)
        {
            console.log(chalk.yellow('\n⚠️  Version Warnings:\n'));
            warnings.forEach(warning => console.log(chalk.yellow(`  - ${warning}`)));
            console.log('');
        }
    }

    // Parse connection info (shown in the confirmation prompt)
    const dbInfo = parseDatabaseUrl(dbUrl);

    // Confirm before restore
    const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: chalk.yellow(`⚠️  This will replace all data in "${dbInfo.database}" @ ${dbInfo.host}:${dbInfo.port}. Continue?`),
        initial: false,
    });

    if (!confirm)
    {
        console.log(chalk.gray('Cancelled'));
        process.exit(0);
    }

    await confirmDangerousTarget(dbInfo);

    // Validate mutually exclusive options
    if (options.dataOnly && options.schemaOnly)
    {
        console.error(chalk.red('❌ Cannot use --data-only and --schema-only together'));
        process.exit(1);
    }

    // Check file format
    const ext = path.extname(file);
    const isCustomFormat = ext === '.dump';

    // Build restore command
    const command = isCustomFormat ? 'pg_restore' : 'psql';
    const args: string[] = [];

    if (isCustomFormat)
    {
        args.push('-h', dbInfo.host);
        args.push('-p', dbInfo.port);
        args.push('-U', dbInfo.user);
        args.push('-d', dbInfo.database);
        args.push('--verbose');

        if (options.drop)
        {
            args.push('--clean', '--if-exists');
        }

        if (options.schema)
        {
            args.push('-n', options.schema);
        }

        if (options.dataOnly)
        {
            args.push('--data-only');
        }

        if (options.schemaOnly)
        {
            args.push('--schema-only');
        }

        args.push(file);
    }
    else
    {
        // For plain SQL files, --data-only and --schema-only are not directly supported
        // The backup file itself should have been created with these options
        if (options.drop)
        {
            console.log(chalk.yellow('⚠️  Note: --drop only works with custom format backups (.dump) and was ignored.'));
        }

        if (options.dataOnly || options.schemaOnly)
        {
            console.log(chalk.yellow('⚠️  Note: --data-only and --schema-only options only work with custom format backups (.dump)'));
            console.log(chalk.yellow('    For SQL files, the backup must have been created with the desired option.\n'));
        }

        args.push('-h', dbInfo.host);
        args.push('-p', dbInfo.port);
        args.push('-U', dbInfo.user);
        args.push('-d', dbInfo.database);
        args.push('-v', 'ON_ERROR_STOP=1');
        args.push('-f', file);
    }

    // Execute restore
    const verbose = options.verbose ?? false;
    const spinner = ora('Restoring backup...').start();

    const restoreProcess = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PGPASSWORD: dbInfo.password,
        },
    });

    const warnings: string[] = [];
    const errors: string[] = [];
    let objectCount = 0;

    restoreProcess.stderr?.on('data', (data) =>
    {
        const lines = data.toString().split('\n').filter((l: string) => l.trim());

        for (const line of lines)
        {
            // Categorize by log level
            if (/^pg_restore:.*warning:/i.test(line) || /^WARNING:/i.test(line))
            {
                warnings.push(line.trim());
            }
            else if (/^pg_restore:.*error:/i.test(line) || /^ERROR:/i.test(line) || /^psql:.*ERROR/i.test(line))
            {
                errors.push(line.trim());
            }

            // Parse pg_restore verbose output for progress
            const objectMatch = line.match(/processing item (\d+)\/(\d+)/);
            if (objectMatch)
            {
                objectCount = Number(objectMatch[2]);
                const current = Number(objectMatch[1]);
                const desc = line.replace(/^pg_restore:\s*/, '').trim();
                spinner.text = `Restoring backup... [${current}/${objectCount}] ${desc}`;
            }
            else if (isCustomFormat)
            {
                // Other verbose lines from pg_restore (e.g., "creating TABLE ...", "restoring data for ...")
                const desc = line.replace(/^pg_restore:\s*/, '').trim();
                if (desc && !/warning:|error:/i.test(desc))
                {
                    spinner.text = `Restoring backup... ${desc}`;
                }
            }

            if (verbose)
            {
                spinner.stop();
                console.log(chalk.dim(`  ${line.trim()}`));
                spinner.start();
            }
        }
    });

    restoreProcess.stdout?.on('data', (data) =>
    {
        if (verbose)
        {
            spinner.stop();
            console.log(chalk.dim(`  ${data.toString().trim()}`));
            spinner.start();
        }
    });

    await new Promise<void>((resolve, reject) =>
    {
        restoreProcess.on('close', (code) =>
        {
            if (code === 0)
            {
                const summary = objectCount > 0 ? ` (${objectCount} objects)` : '';
                spinner.succeed(`Restore completed${summary}`);

                // Show warnings even on success
                if (warnings.length > 0)
                {
                    console.log(chalk.yellow(`\n⚠️  Warnings during restore (${warnings.length}):\n`));
                    for (const w of warnings)
                    {
                        console.log(chalk.yellow(`  - ${w}`));
                    }
                }

                console.log(chalk.green('\n✅ Database restored successfully'));
                resolve();
            }
            else
            {
                spinner.fail('Restore failed');

                if (errors.length > 0)
                {
                    console.error(chalk.red(`\n❌ Errors (${errors.length}):\n`));
                    for (const e of errors)
                    {
                        console.error(chalk.red(`  - ${e}`));
                    }
                }

                if (warnings.length > 0)
                {
                    console.log(chalk.yellow(`\n⚠️  Warnings (${warnings.length}):\n`));
                    for (const w of warnings)
                    {
                        console.log(chalk.yellow(`  - ${w}`));
                    }
                }

                const fallback = errors.length === 0 && warnings.length === 0
                    ? 'Restore failed with no output'
                    : '';

                reject(new Error(fallback));
            }
        });

        restoreProcess.on('error', (error) =>
        {
            spinner.fail('Restore failed');
            reject(error);
        });
    }).catch((error) =>
    {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        if (msg)
        {
            console.error(chalk.red(`\n❌ ${msg}`));
        }
        process.exit(1);
    });
}
