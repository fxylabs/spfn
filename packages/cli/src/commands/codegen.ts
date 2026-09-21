import { Command } from 'commander';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';

/**
 * Initialize .spfnrc.json with codegen configuration
 */
async function initCodegen(options: { withExample?: boolean }): Promise<void>
{
    const cwd = process.cwd();
    const rcPath = join(cwd, '.spfnrc.ts');

    // Check if .spfnrc.ts already exists
    if (existsSync(rcPath))
    {
        logger.warn('.spfnrc.ts already exists');
        logger.info('Edit manually to add custom generators');
        process.exit(0);
    }

    // Write .spfnrc.ts with the route-map generator (matches the `spfn init` scaffold)
    const content = `import { defineConfig, defineGenerator } from '@spfn/core/codegen';

/**
 * SPFN Codegen Configuration
 *
 * Configure code generators here. Generators run during \`spfn dev\` and \`spfn codegen run\`.
 */

export default defineConfig({
    generators: [
        // Route map generator - generates routeName → {method, path} mappings
        // Used by RPC proxy to resolve routes without importing server code
        defineGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: './src/generated/route-map.ts',
        }),
    ],
});
`;

    writeFileSync(rcPath, content);

    console.log('\n' + chalk.green.bold('✓ Created .spfnrc.ts\n'));
    console.log(chalk.gray('Configured the @spfn/core:route-map generator.'));

    if (options.withExample)
    {
        console.log('\n' + chalk.yellow('📝 To add custom generators:'));
        console.log('  1. Create your generator file (e.g., src/generators/my-generator.ts)');
        console.log('  2. Add to .spfnrc.ts:');
        console.log(chalk.gray(`
{
  "codegen": {
    "generators": [
      { "name": "@spfn/core:contract", "enabled": true },
      { "path": "./src/generators/my-generator.ts" }
    ]
  }
}
        `));
        console.log('  3. Run: ' + chalk.cyan('spfn dev') + ' (generators run automatically)');
    }
    else
    {
        console.log('\n' + chalk.yellow('📝 Next steps:'));
        console.log('  • Add custom generators to .spfnrc.ts');
        console.log('  • Run: ' + chalk.cyan('spfn dev') + ' to start development with code generation');
    }
}

/**
 * List registered code generators
 */
async function listGenerators(): Promise<void>
{
    const cwd = process.cwd();

    // Load configuration
    const { loadCodegenConfig, createGeneratorsFromConfig } = await import('@spfn/core/codegen');
    const config = loadCodegenConfig(cwd);
    const generators = await createGeneratorsFromConfig(config, cwd);

    if (generators.length === 0)
    {
        logger.info('No generators configured');
        logger.info('Run "spfn codegen init" to initialize configuration');

        return;
    }

    console.log('\n' + chalk.bold('Registered Generators:'));
    generators.forEach((gen, index) =>
    {
        console.log(`  ${index + 1}. ${chalk.cyan(gen.name)}`);
        console.log(`     Patterns: ${chalk.gray(gen.watchPatterns.join(', '))}`);
    });
    console.log('');
}

/**
 * Run code generation once (no watch)
 */
async function runGenerators(): Promise<void>
{
    const cwd = process.cwd();

    logger.info('Running code generators...\n');

    // Load configuration and create generators
    const { loadCodegenConfig, createGeneratorsFromConfig, CodegenOrchestrator } = await import('@spfn/core/codegen');
    const config = loadCodegenConfig(cwd);
    const generators = await createGeneratorsFromConfig(config, cwd);

    if (generators.length === 0)
    {
        logger.warn('No generators configured');
        logger.info('Run "spfn codegen init" to initialize configuration');

        return;
    }

    // Create orchestrator and run once
    const orchestrator = new CodegenOrchestrator({
        generators,
        cwd,
        debug: true,

        // A generator that refuses — a router that will not load, a duplicate
        // route name — has to reach the exit code. Printing a green check over
        // a logged failure leaves the stale output on disk and tells the
        // developer who just added a route that the map now names it.
        throwOnError: true,
    });

    try
    {
        await orchestrator.generateAll();
    }
    catch (error)
    {
        logger.error(error instanceof Error ? error.message : String(error));
        console.log('\n' + chalk.red.bold('✗ Code generation failed'));
        process.exit(1);
    }

    console.log('\n' + chalk.green.bold('✓ Code generation completed'));
}

// Codegen command group
export const codegenCommand = new Command('codegen')
    .description('Code generation management');

// codegen init
codegenCommand
    .command('init')
    .description('Initialize .spfnrc.ts with codegen configuration')
    .option('--with-example', 'Show example custom generator usage')
    .action(initCodegen);

// codegen list
codegenCommand
    .command('list')
    .alias('ls')
    .description('List registered code generators')
    .action(listGenerators);

// codegen run
codegenCommand
    .command('run')
    .description('Run code generators once (no watch mode)')
    .action(runGenerators);
