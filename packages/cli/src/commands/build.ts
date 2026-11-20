import { Command } from 'commander';
import { existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { execa } from 'execa';
import ora from 'ora';
import chalk from 'chalk';
import { build } from 'tsup';

import { logger } from '../utils/logger.js';
import { detectPackageManager, getRunCommand } from '../utils/package-manager.js';
import { foreignRunner } from '../utils/foreign-runner.js';

interface BuildOptions
{
    serverOnly?: boolean;
    nextOnly?: boolean;
    turbo?: boolean;
}

/**
 * The entry `spfn start` runs in production.
 *
 * It decides nothing about the address any more. `startServer` resolves that
 * through `@spfn/core/app-config` — SPFN_PORT, then spfn.config.js, then the
 * default — and an entry that computed a value of its own would be a fourth
 * layer sitting above all of them, which is exactly how a hardcoded 8790 came
 * to override `examples/03-auth` asking for 8890.
 *
 * Exported so its content is under test rather than only under review: this is
 * generated text, so nothing type-checks it.
 */
export function renderProdServerEntry(): string
{
    return `// Load environment variables FIRST (before any imports that depend on them)
// Use centralized environment loader for standard dotenv priority
await import('@spfn/core/config');

// Now import server (logger singleton will be created with correct NODE_ENV)
const { startServer } = await import('@spfn/core/server');

// No address here on purpose: SPFN_PORT / SPFN_HOST and spfn.config.js decide,
// and startServer reads both.
await startServer({ debug: false });
`;
}

/**
 * Build SPFN project for production
 */
async function buildProject(options: BuildOptions): Promise<void>
{
    // Set NODE_ENV to production (Next.js style)
    if (!process.env.NODE_ENV) 
    {
        process.env.NODE_ENV = 'production';
    }

    const cwd = process.cwd();
    const pm = detectPackageManager(cwd);

    // Check if Next.js project
    const packageJsonPath = join(cwd, 'package.json');
    let hasNext = false;

    if (existsSync(packageJsonPath))
    {
        const packageJson = JSON.parse(await import('fs').then(fs =>
            fs.promises.readFile(packageJsonPath, 'utf-8'),
        ));
        hasNext = !!(packageJson.dependencies?.next || packageJson.devDependencies?.next);
    }

    // Check if SPFN server exists
    const serverDir = join(cwd, 'src', 'server');
    const hasServer = existsSync(serverDir);

    console.log(chalk.blue.bold('\n🏗️  Building SPFN project for production...\n'));

    // Run codegen before building to ensure API client is up-to-date
    if (hasServer)
    {
        const spinner = ora('Generating API client...').start();

        try
        {
            const { CodegenOrchestrator, loadCodegenConfig, createGeneratorsFromConfig, markAppSourceProcess } = await import('@spfn/core/codegen');

            // Loads the app's source: a second copy of @spfn/core is refused, where it is
            // recorded and after each router load.
            markAppSourceProcess({ foreignRunner: foreignRunner(cwd, process.argv.slice(2)) });

            const config = loadCodegenConfig(cwd);
            const generators = await createGeneratorsFromConfig(config, cwd);

            const orchestrator = new CodegenOrchestrator({
                generators,
                cwd,
                debug: false,

                // A generator that refuses at build time — a broken route contract,
                // a router that will not load — must reach the exit code rather
                // than scroll past while the build ships anyway.
                throwOnError: true,
            });

            await orchestrator.generateAll('build');
            spinner.succeed('API client generated');
        }
        catch (error)
        {
            spinner.fail('Code generation failed');
            logger.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
        }
    }

    // Build Next.js using package.json's build script
    if (hasNext && !options.serverOnly)
    {
        const spinner = ora('Building Next.js...').start();

        try
        {
            // Use the existing "build" script from package.json (usually "next build --turbopack")
            await execa(pm, ['run', 'build'], {
                cwd,
                stdio: 'inherit',
            });

            spinner.succeed('Next.js build completed');
        }
        catch (error)
        {
            spinner.fail('Next.js build failed');
            logger.error(String(error));
            process.exit(1);
        }
    }

    // Build SPFN server (TypeScript → JavaScript)
    if (hasServer && !options.nextOnly)
    {
        const spinner = ora('Building SPFN server...').start();

        try
        {
            // Compile TypeScript to JavaScript using tsup
            const outputDir = join(cwd, '.spfn', 'server');
            mkdirSync(outputDir, { recursive: true });

            const serverDir = join(cwd, 'src', 'server');

            if (!existsSync(serverDir))
            {
                spinner.fail('SPFN server build failed');
                logger.error('src/server/ directory not found');
                logger.error('Please run "spfn init" to initialize the project.');
                process.exit(1);
            }

            // Build with tsup API (handles @/* aliases and .js extensions automatically)
            await build({
                entry: ['src/server/**/*.ts'],
                format: ['esm'],
                outDir: '.spfn/server',

                // Pin the extension. Left to tsup it follows the app's
                // package.json — `.mjs` normally, `.js` under
                // `"type": "module"` — and @spfn/core looks the compiled
                // server.config up by name, so an app that declared that field
                // shipped a production server running on defaults.
                outExtension: () => ({ js: '.mjs' }),
                clean: true,
                splitting: false,
                tsconfig: 'src/server/tsconfig.json',
                external: [
                    'drizzle-orm',
                    'hono',
                    '@hono/node-server',
                    'postgres',
                    'ioredis',
                    'pino',
                    'chalk',
                    '@sinclair/typebox',
                    '@spfn/core',
                ],
                silent: true,
                onSuccess: async () => 
                {
                    // Silently succeed
                },
            });

            // Generate production server entry point
            const prodServerPath = join(cwd, '.spfn', 'prod-server.mjs');
            const prodServerContent = renderProdServerEntry();

            writeFileSync(prodServerPath, prodServerContent);

            spinner.succeed(`SPFN server build completed → .spfn/server`);

            // Display routes like Next.js does
            const routesDir = join(cwd, '.spfn', 'server', 'routes');
            if (existsSync(routesDir))
            {
                console.log();
                console.log(chalk.bold('Route (api)'));

                try
                {
                    const routes = readdirSync(routesDir, { withFileTypes: true })
                        .filter(dirent => dirent.isDirectory())
                        .map(dirent => dirent.name)
                        .sort();

                    if (routes.length > 0)
                    {
                        routes.forEach((route, index) =>
                        {
                            const isLast = index === routes.length - 1;
                            const prefix = isLast ? '└' : '├';
                            const routePath = `/api/${route}`;

                            // Check for health route (single GET method)
                            if (route === 'health')
                            {
                                console.log(`${prefix} ${chalk.green('GET')}  ${routePath}`);
                            }
                            else
                            {
                                console.log(`${prefix} ${chalk.cyan('*')}    ${routePath}`);
                            }
                        });

                        console.log();
                        console.log(chalk.cyan('*') + '  (Hono)  multiple methods supported');
                    }
                }
                catch (error)
                {
                    // Silently fail if routes can't be read
                }
            }
        }
        catch (error)
        {
            spinner.fail('SPFN server build failed');

            // Show detailed error information (type errors, syntax errors, etc.)
            if (error instanceof Error) 
            {
                console.error('\n' + chalk.red(error.message));

                // Show stack trace for debugging
                if (error.stack) 
                {
                    console.error(chalk.dim('\n' + error.stack));
                }
            }
            else 
            {
                logger.error(String(error));
            }

            process.exit(1);
        }
    }

    if (!hasNext && !hasServer)
    {
        logger.error('No Next.js or SPFN server found in this project.');
        process.exit(1);
    }

    console.log('\n' + chalk.green.bold('✓ Build completed successfully!\n'));

    console.log(chalk.bold('Next steps:\n'));
    console.log('  ' + chalk.cyan('Start production server:'));
    console.log(`    ${chalk.cyan(getRunCommand(pm))} spfn:start  ${chalk.gray('# Start SPFN + Next.js')}\n`);

    console.log('  ' + chalk.cyan('Or deploy with Docker:'));
    console.log(`    ${chalk.cyan('docker compose -f docker-compose.production.yml up --build -d')}\n`);
}

export const buildCommand = new Command('build')
    .description('Build SPFN project for production (Next.js + Server)')
    .option('--server-only', 'Build only SPFN server (skip Next.js)')
    .option('--next-only', 'Build only Next.js (skip SPFN server)')
    .option('--turbo', 'Use Turbopack for Next.js build')
    .action(async (options: BuildOptions) =>
    {
        await buildProject(options);
    });
