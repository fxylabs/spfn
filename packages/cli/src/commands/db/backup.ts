import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { OWNER_URL_MISSING, ownerDatabaseUrl, parseDatabaseUrl } from './utils/database.js';
import { formatBytes, formatTimestamp } from './utils/formatters.js';
import { ensureBackupDir } from './utils/backup-files.js';
import {
    collectGitInfo,
    collectMigrationInfo,
    saveBackupMetadata,
    type BackupMetadata,
} from './utils/metadata.js';
import { loadEnv } from '@spfn/core/server';

/**
 * Backup database to file
 *
 * Connects as the table owner (DATABASE_OWNER_URL, else DATABASE_URL):
 * pg_dump stops with an error on a table whose row-level security policy
 * applies to the role it runs as.
 */
export async function dbBackup(options: {
    format?: 'sql' | 'custom';
    output?: string;
    schema?: string;
    dataOnly?: boolean;
    schemaOnly?: boolean;
    tag?: string;
    env?: string;
}): Promise<void>
{
    console.log(chalk.blue('💾 Creating database backup...\n'));

    loadEnv();
    const dbUrl = ownerDatabaseUrl();
    if (!dbUrl)
    {
        console.error(chalk.red(OWNER_URL_MISSING));
        console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL to your .env file'));
        process.exit(1);
    }

    // Parse connection info
    const dbInfo = parseDatabaseUrl(dbUrl);

    // Ensure backup directory exists
    const backupDir = await ensureBackupDir();

    // Generate filename
    const timestamp = formatTimestamp();
    const format = options.format || 'sql';
    const ext = format === 'sql' ? 'sql' : 'dump';
    const filename = options.output || path.join(backupDir, `${dbInfo.database}_${timestamp}.${ext}`);

    // Validate mutually exclusive options
    if (options.dataOnly && options.schemaOnly)
    {
        console.error(chalk.red('❌ Cannot use --data-only and --schema-only together'));
        process.exit(1);
    }

    // Build pg_dump command args
    const args = [
        '-h', dbInfo.host,
        '-p', dbInfo.port,
        '-U', dbInfo.user,
        '-d', dbInfo.database,
        '-f', filename,
    ];

    if (format === 'custom')
    {
        args.push('-Fc'); // Custom format with compression
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

    // Execute pg_dump
    const spinner = ora('Creating backup...').start();

    const pgDump = spawn('pg_dump', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PGPASSWORD: dbInfo.password,
        },
    });

    let errorOutput = '';

    pgDump.stderr?.on('data', (data) =>
    {
        errorOutput += data.toString();
    });

    await new Promise<void>((resolve, reject) =>
    {
        pgDump.on('close', async (code) =>
        {
            if (code === 0)
            {
                try
                {
                    const stats = await fs.stat(filename);
                    const size = formatBytes(stats.size);

                    spinner.succeed('Backup created');
                    console.log(chalk.green(`\n✅ Backup created successfully`));
                    console.log(chalk.gray(`   File: ${filename}`));
                    console.log(chalk.gray(`   Size: ${size}`));

                    // Collect and save metadata
                    console.log(chalk.dim('\n📋 Collecting metadata...'));

                    const [gitInfo, migrationInfo] = await Promise.all([
                        collectGitInfo(),
                        collectMigrationInfo(dbUrl),
                    ]);

                    // Prepare tags array
                    const tags: string[] = [];
                    if (options.tag)
                    {
                        tags.push(...options.tag.split(',').map(t => t.trim()));
                    }

                    const metadata: BackupMetadata = {
                        timestamp: new Date().toISOString(),
                        database: dbInfo.database,
                        environment: options.env || process.env.NODE_ENV,
                        git: gitInfo,
                        migrations: migrationInfo,
                        backup: {
                            filename: path.basename(filename),
                            format: format as 'sql' | 'custom',
                            sizeBytes: stats.size,
                            schema: options.schema,
                            dataOnly: options.dataOnly,
                            schemaOnly: options.schemaOnly,
                        },
                        tags: tags.length > 0 ? tags : undefined,
                    };

                    await saveBackupMetadata(metadata, filename);
                    resolve();
                }
                catch (error)
                {
                    reject(error);
                }
            }
            else
            {
                spinner.fail('Backup failed');
                reject(new Error(errorOutput || 'pg_dump failed'));
            }
        });

        pgDump.on('error', (error) =>
        {
            spinner.fail('Backup failed');
            reject(error);
        });
    }).catch((error) =>
    {
        console.error(chalk.red('\n❌ Failed to create backup'));

        if (errorOutput.includes('pg_dump: command not found') || errorOutput.includes('not found'))
        {
            console.error(chalk.yellow('\n💡 pg_dump is not installed. Please install PostgreSQL client tools.'));
        }
        else
        {
            console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
        }

        process.exit(1);
    });
}
