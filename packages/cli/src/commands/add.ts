/**
 * Add a capability to an SPFN project
 *
 * Two kinds of argument:
 *   - a scoped package name — installs it and applies its bundled migrations
 *   - a deploy target — scaffolds the files that target needs (currently `vercel`)
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';
import chalk from 'chalk';
import ora from 'ora';
import { detectPackageManager, getAddArgs, installRefusalReason } from '../utils/package-manager.js';
import { addVercel } from './add-vercel.js';

/**
 * Add and set up an SPFN ecosystem package
 */
async function addPackage(packageName: string): Promise<void>
{
    // `spfn add vercel` scaffolds the serverless target instead of installing a package
    if (packageName === 'vercel')
    {
        await addVercel();

        return;
    }

    // Validate package name format
    if (!packageName.includes('/'))
    {
        console.error(chalk.red('❌ Please specify full package name'));
        console.log(chalk.yellow('\n💡 Examples:'));
        console.log(chalk.gray('  pnpm spfn add @spfn/cms'));
        console.log(chalk.gray('  pnpm spfn add @mycompany/spfn-analytics'));
        console.log(chalk.gray('\n  Deploy targets are unscoped. The only one today is:'));
        console.log(chalk.gray('  pnpm spfn add vercel'));
        process.exit(1);
    }

    console.log(chalk.blue(`\n📦 Setting up ${packageName}...\n`));

    // Step 1: Check if package is already installed (for local development)
    const pkgPath = join(process.cwd(), 'node_modules', ...packageName.split('/'));
    const pkgJsonPath = join(pkgPath, 'package.json');

    if (!existsSync(pkgJsonPath))
    {
        const pm = detectPackageManager(process.cwd());
        const refusal = installRefusalReason(pm, process.cwd());

        if (refusal)
        {
            console.error(chalk.red(`❌ ${refusal}`));
            process.exit(1);
        }

        const installSpinner = ora('Installing package...').start();

        try
        {
            await execa(pm, getAddArgs(pm, [packageName]));
            installSpinner.succeed('Package installed');
        }
        catch (error)
        {
            installSpinner.fail('Failed to install package');
            console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
            process.exit(1);
        }
    }
    else
    {
        console.log(chalk.gray('✓ Package already installed (using local version)\n'));
    }

    // Step 2: Check if package has schemas
    if (!existsSync(pkgJsonPath))
    {
        console.error(chalk.red(`❌ Package ${packageName} not found after installation`));
        process.exit(1);
    }

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

    // Step 3: Set up database if package has migrations
    if (pkgJson.spfn?.migrations)
    {
        console.log(chalk.blue(`\n🗄️  Setting up database for ${packageName}...\n`));

        // Load environment first
        const { env } = await import('@spfn/core/config');

        if (!env.DATABASE_URL)
        {
            console.log(chalk.yellow('⚠️  DATABASE_URL not found — skipping database setup.'));
            console.log(chalk.yellow(`   ${packageName} tables are created by its bundled migrations, not by schema push.`));
            console.log(chalk.cyan('   Once DATABASE_URL is set, run: pnpm spfn db migrate'));
            console.log(chalk.gray('   (check state anytime with: pnpm spfn db status)\n'));
        }
        else
        {
            // Apply pre-generated function migrations
            const { discoverFunctionMigrations, loadFunctionMigrationPlans, executeFunctionMigrations } =
                await import('../utils/function-migrations.js');

            const functions = discoverFunctionMigrations(process.cwd());
            const targetFunction = functions.find(f => f.packageName === packageName);

            if (targetFunction)
            {
                const spinner = ora('Applying migrations...').start();

                try
                {
                    await executeFunctionMigrations(loadFunctionMigrationPlans([targetFunction]));
                    spinner.succeed('Migrations applied');
                }
                catch (error)
                {
                    spinner.fail('Failed to apply migrations');
                    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
                    process.exit(1);
                }
            }
            else
            {
                console.log(chalk.gray('ℹ️  No migrations found for this package'));
            }
        }
    }
    else
    {
        console.log(chalk.gray('\nℹ️  No database migrations to apply'));
    }

    // Step 4: Show success message and setup guide
    console.log(chalk.green(`\n✅ ${packageName} installed successfully!\n`));

    // Show package-specific setup message if available
    if (pkgJson.spfn?.setupMessage)
    {
        console.log(chalk.cyan('📚 Setup Guide:'));
        console.log(pkgJson.spfn.setupMessage);
        console.log();
    }
}

/**
 * Add command group
 */
export const addCommand = new Command('add')
    .description('Add a capability to this project: an SPFN ecosystem package, or a deploy target')
    .argument('<package|target>', 'Scoped package name (e.g., @spfn/cms, @mycompany/spfn-analytics), or a deploy target: vercel')
    .action(addPackage);
