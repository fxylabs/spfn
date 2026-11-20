import { Command } from 'commander';
import { join } from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';

/**
 * Where the contract lives.
 *
 * Taken from the `@spfn/core:contract` generator in `.spfnrc.ts` so the CLI and
 * the build never disagree about which directory is the contract.
 */
async function resolveContractsDir(cwd: string, override?: string): Promise<string>
{
    if (override)
    {
        return join(cwd, override);
    }

    const { loadCodegenConfig } = await import('@spfn/core/codegen');
    const config = loadCodegenConfig(cwd);

    const generator = config.generators?.find(
        entry => 'name' in entry && entry.name === '@spfn/core:contract',
    ) as { outputDir?: string } | undefined;

    return join(cwd, generator?.outputDir ?? './contracts');
}

/**
 * Regenerate the contract from the router.
 *
 * Every command here regenerates rather than trusting the committed file: a
 * snapshot cut from a stale `current.json` records a promise the server does
 * not make.
 */
async function regenerate(cwd: string): Promise<void>
{
    const { loadCodegenConfig, createGeneratorsFromConfig, CodegenOrchestrator, markAppSourceProcess } = await import('@spfn/core/codegen');

    // Loads the app's source: a second copy of @spfn/core is refused, where it is
    // recorded and after each router load.
    markAppSourceProcess();

    const config = loadCodegenConfig(cwd);
    const generators = (await createGeneratorsFromConfig(config, cwd))
        .filter(generator => generator.name === '@spfn/core:contract');

    if (generators.length === 0)
    {
        throw new Error(
            'No @spfn/core:contract generator is configured in .spfnrc.ts.\n'
            + 'Add one with the router path before using contract commands.',
        );
    }

    const orchestrator = new CodegenOrchestrator({ generators, cwd, throwOnError: true });
    await orchestrator.generateAll('manual');
}

async function checkContractCommand(options: { dir?: string }): Promise<void>
{
    const cwd = process.cwd();

    try
    {
        await regenerate(cwd);

        const { checkContract, formatViolations, readCurrentDocument } = await import('@spfn/core/contract');
        const contractsDir = await resolveContractsDir(cwd, options.dir);
        const result = checkContract(contractsDir, readCurrentDocument(contractsDir));

        for (const warning of result.warnings)
        {
            logger.warn(warning);
        }

        if (result.violations.length > 0)
        {
            console.log('\n' + chalk.red.bold(`✗ Breaks the contract released as ${result.baselineVersion}\n`));
            console.log(formatViolations(result.violations));
            console.log('');
            process.exit(1);
        }

        const against = result.baselineVersion
            ? `backward compatible with released ${result.baselineVersion}`
            : 'generated (nothing released to compare against yet)';

        console.log('\n' + chalk.green.bold(`✓ Contract ${against}\n`));
    }
    catch (error)
    {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

async function releaseContractCommand(version: string, options: { dir?: string }): Promise<void>
{
    const cwd = process.cwd();

    try
    {
        await regenerate(cwd);

        const {
            checkContract,
            formatViolations,
            readCurrentDocument,
            writeSnapshot,
        } = await import('@spfn/core/contract');

        const contractsDir = await resolveContractsDir(cwd, options.dir);
        const document = readCurrentDocument(contractsDir);
        const result = checkContract(contractsDir, document);

        if (result.violations.length > 0)
        {
            console.log('\n' + chalk.red.bold(`✗ Cannot release: breaks the contract released as ${result.baselineVersion}\n`));
            console.log(formatViolations(result.violations));
            console.log('');
            process.exit(1);
        }

        for (const warning of result.warnings)
        {
            logger.warn(warning);
        }

        // The version comes from the document (`.contractVersion()` on the router),
        // so writeSnapshot is never told it separately.
        const file = writeSnapshot(contractsDir, document);

        console.log('\n' + chalk.green.bold(`✓ Released contract ${version}\n`));
        console.log(chalk.gray(`  ${file}`));
        console.log(chalk.gray(`  ${document.operations.length} operation(s)`));
        console.log(chalk.yellow('\n  Commit this snapshot. The gate compares every later build against it.\n'));
    }
    catch (error)
    {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

async function listContractCommand(options: { dir?: string }): Promise<void>
{
    const cwd = process.cwd();

    try
    {
        const { listSnapshots } = await import('@spfn/core/contract');
        const contractsDir = await resolveContractsDir(cwd, options.dir);
        const snapshots = listSnapshots(contractsDir);

        if (snapshots.length === 0)
        {
            logger.info('No released contract snapshot yet');

            return;
        }

        console.log('\n' + chalk.bold('Released contracts:'));
        for (const snapshot of snapshots)
        {
            console.log(`  ${chalk.cyan(snapshot.version)}  ${chalk.gray(snapshot.file)}`);
        }
        console.log('');
    }
    catch (error)
    {
        logger.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

// Contract command group
export const contractCommand = new Command('contract')
    .description('Route contract management (what separately deployed clients are promised)');

contractCommand
    .command('check')
    .description('Regenerate the contract and compare it against the newest released snapshot')
    .option('--dir <path>', 'Contracts directory (default: from .spfnrc.ts)')
    .action(checkContractCommand);

contractCommand
    .command('release <version>')
    .description('Write contracts/released/<version>.json — required for every release')
    .option('--dir <path>', 'Contracts directory (default: from .spfnrc.ts)')
    .action(releaseContractCommand);

contractCommand
    .command('list')
    .alias('ls')
    .description('List released contract snapshots')
    .option('--dir <path>', 'Contracts directory (default: from .spfnrc.ts)')
    .action(listContractCommand);
