import { Command, Option } from 'commander';
import { existsSync } from 'fs';
import { join } from 'path';
import prompts from 'prompts';
import ora from 'ora';
import { execa } from 'execa';
import chalk from 'chalk';

import { logger } from '../utils/logger.js';
import { detectPackageManager, findWorkspace, formatCommandLine, getAddArgs, getOneOffCommandLine, getRunCommand, runInstall, type CommandLine, type PackageManager } from '../utils/package-manager.js';
import { confirmInstalled } from './init/steps/package.js';
import { ENV_FILES_HINT } from '../utils/messages.js';
import { selectScaffoldMode, type ScaffoldMode } from './init/mode.js';

interface CreateOptions
{
    skipInstall?: boolean;
    skipGit?: boolean;
    pm?: 'npm' | 'pnpm' | 'yarn' | 'bun';
    shadcn?: boolean;
    yes?: boolean;
    mode?: ScaffoldMode;
}

/**
 * Install from the root of the pnpm workspace the app is a member of, then
 * confirm the app's declared packages resolve from the app directory.
 */
async function installFromWorkspaceRoot(workspaceRoot: string, projectPath: string): Promise<void>
{
    const installSpinner = ora('Installing dependencies from workspace root...').start();
    const failure = await runInstall('pnpm', ['install'], {
        cwd: workspaceRoot,
        stdio: 'pipe',
        timeout: 300_000,
    });

    if (failure)
    {
        installSpinner.fail('Failed to install dependencies');
        logger.error('Run `pnpm install` from workspace root manually.');
        logger.error(failure);

        return;
    }

    confirmInstalled(installSpinner, projectPath, 'pnpm');
}

/**
 * Install @svgr/webpack and run `spfn setup icons`. A failure only warns: the
 * project is usable without it. A failed install also prints its report
 * (`runInstall`).
 */
async function setupSvgr(pm: PackageManager, projectPath: string): Promise<void>
{
    const iconsSpinner = ora('Setting up SVGR for icon management...').start();
    const failure = await runInstall(pm, getAddArgs(pm, ['@svgr/webpack'], { dev: true }), { cwd: projectPath, timeout: 120_000 });

    if (failure)
    {
        iconsSpinner.warn('Failed to setup SVGR (you can run `spfn setup icons` later)');
        logger.error(failure);

        return;
    }

    try
    {
        const { setupIcons } = await import('./setup.js');

        await setupIcons();
        iconsSpinner.succeed('SVGR setup completed');
    }
    catch
    {
        iconsSpinner.warn('Failed to setup SVGR (you can run `spfn setup icons` later)');
    }
}

/**
 * `getOneOffCommandLine`, saying first when it asks yarn: the question shares
 * the terminal, so yarn 1's "no" arrives there as an error line of its own.
 */
async function resolveOneOff(pm: PackageManager, cwd: string, spec: string, args: string[]): Promise<CommandLine>
{
    if (pm === 'yarn')
    {
        logger.step(`Asking yarn whether it has dlx for ${spec} (yarn 1 answers no with an error)...`);
    }

    return getOneOffCommandLine(pm, cwd, spec, args);
}

/**
 * Initialize shadcn/ui in the app. It is optional, so a failure, including
 * yarn not saying how to run it, warns and leaves it for later.
 */
async function setupShadcn(pm: PackageManager, projectPath: string): Promise<void>
{
    let shadcn: CommandLine;

    try
    {
        shadcn = await resolveOneOff(pm, projectPath, 'shadcn@latest', ['init', '--yes', '--defaults']);
    }
    catch (error: any)
    {
        ora().warn(`Failed to initialize shadcn/ui: ${error.message}`);

        return;
    }

    try
    {
        logger.step(`Setting up shadcn/ui with ${shadcn.command}...`);

        await execa(shadcn.command, shadcn.args, {
            cwd: projectPath,
            stdio: 'inherit',
            timeout: 300_000,
        });

        ora().succeed('shadcn/ui initialized');
    }
    catch
    {
        ora().warn(`Failed to initialize shadcn/ui (you can run \`${formatCommandLine(shadcn)}\` later)`);
    }
}

/**
 * Create a new Next.js project with SPFN
 */
async function createProject(projectName: string, options: CreateOptions): Promise<void>
{
    const cwd = process.cwd();
    const projectPath = join(cwd, projectName);

    // 1. Check if directory already exists
    if (existsSync(projectPath))
    {
        logger.error(`Directory ${projectName} already exists.`);
        process.exit(1);
    }

    console.log(chalk.blue.bold('\n🚀 Creating Next.js project with SPFN...\n'));

    // 2. Determine package manager
    let pm = options.pm || detectPackageManager(projectPath);

    if (!options.yes && !options.pm)
    {
        const { selectedPm } = await prompts({
            type: 'select',
            name: 'selectedPm',
            message: 'Which package manager do you want to use?',
            choices: [
                { title: 'pnpm (recommended)', value: 'pnpm' },
                { title: 'npm', value: 'npm' },
                { title: 'yarn', value: 'yarn' },
                { title: 'bun', value: 'bun' },
            ],
            initial: 0,
        });

        if (!selectedPm)
        {
            process.exit(0);
        }

        pm = selectedPm;
    }

    logger.step(`Using package manager: ${pm}`);

    const mode = await selectScaffoldMode(options);
    logger.step(`Using scaffold mode: ${mode}`);

    // 3. Detect the pnpm workspace the new app is a member of (monorepo). A
    // directory the workspace does not list is its own project and installs
    // in its own directory.
    const workspace = pm === 'pnpm' ? findWorkspace(projectPath) : null;
    const workspaceRoot = workspace?.packageManager === 'pnpm' ? workspace.root : null;
    const isInWorkspace = workspaceRoot !== null;

    if (isInWorkspace)
    {
        logger.info(`Detected pnpm workspace at ${workspaceRoot}`);
    }

    // 4. Run create-next-app with SPFN-recommended settings
    try
    {
        const createNextAppArgs = [
            projectName,
            '--typescript',
            '--app',
            '--src-dir',
            '--import-alias', '@/*',
            '--tailwind',
            '--no-eslint',
            '--yes', // Skip prompts
            `--use-${pm}`,
        ];

        // In a workspace, skip install to avoid workspace conflicts;
        // we'll run pnpm install from the workspace root afterwards.
        if (options.skipInstall || isInWorkspace)
        {
            createNextAppArgs.push('--skip-install');
        }

        if (options.skipGit)
        {
            createNextAppArgs.push('--skip-git');
        }

        const createNextApp = await resolveOneOff(pm, cwd, 'create-next-app@latest', createNextAppArgs);

        logger.step(`Running create-next-app with ${createNextApp.command}...`);

        await execa(createNextApp.command, createNextApp.args, {
            cwd,
            stdio: 'inherit',
            timeout: 300_000, // 5 minutes
        });

        ora().succeed('Next.js project created');
    }
    catch (error: any)
    {
        ora().fail('Failed to create Next.js project');

        if (error.exitCode != null)
        {
            logger.error(`create-next-app exited with code ${error.exitCode}`);
        }
        if (error.code === 'ENOENT' && error.path === 'npx')
        {
            logger.error('npx was not found; install npm');
        }
        else if (error.stderr)
        {
            logger.error(error.stderr);
        }
        else
        {
            logger.error(error.message ?? String(error));
        }
        process.exit(1);
    }

    // 5. Install dependencies from workspace root
    if (isInWorkspace && !options.skipInstall)
    {
        await installFromWorkspaceRoot(workspaceRoot!, projectPath);
    }

    // 6. Change to project directory
    process.chdir(projectPath);
    logger.info(`\n📂 Changed directory to ${projectName}\n`);

    // 7. Setup SVGR for icons
    await setupSvgr(pm, projectPath);

    // 8. Setup shadcn/ui (optional)
    if (options.shadcn)
    {
        await setupShadcn(pm, projectPath);
    }

    // 9. Initialize SPFN
    const initSpinner = ora('Initializing SPFN...').start();

    try
    {
        // Run spfn init programmatically, with the package manager decided here
        const { initializeSpfn } = await import('./init/index.js');
        await initializeSpfn({ yes: true, overwriteReadme: true, mode, pm });

        initSpinner.succeed('SPFN initialized');
    }
    catch (error)
    {
        initSpinner.fail('Failed to initialize SPFN');
        logger.error(String(error));
        process.exit(1);
    }

    // 10. Success message
    console.log('\n' + chalk.green.bold('✓ Project created successfully!\n'));

    console.log(chalk.bold('Next steps:\n'));
    console.log(`  ${chalk.cyan('cd')} ${projectName}`);
    console.log(`  ${chalk.cyan('docker compose up -d')}  ${chalk.gray('# Start PostgreSQL & Redis')}`);
    console.log(`  ${chalk.gray(`# .env.local & .env.server are generated — ${ENV_FILES_HINT}`)}`);
    if (mode === 'full')
    {
        const spfnCommand = pm === 'npm' ? 'npx spfn' : `${pm} spfn`;
        console.log(`  ${chalk.cyan(`${spfnCommand} db migrate`)}  ${chalk.gray('# Apply auth migrations')}`);
    }
    console.log(`  ${chalk.cyan(`${getRunCommand(pm)} spfn:dev`)}  ${chalk.gray('# Start dev server')}\n`);

    console.log(chalk.bold('Your app will be available at:\n'));
    console.log(`  ${chalk.cyan('http://localhost:3790')}  ${chalk.gray('(Next.js)')}`);
    console.log(`  ${chalk.cyan('http://localhost:8790')}  ${chalk.gray('(SPFN API)')}\n`);

    // Production deployment guidance
    console.log(chalk.bold('🚀 Ready for production?\n'));
    console.log('  ' + chalk.cyan('Build for production:'));
    console.log(`    ${chalk.cyan(getRunCommand(pm))} spfn:build`);
    console.log(`    ${chalk.cyan(getRunCommand(pm))} spfn:start\n`);

    console.log('  ' + chalk.cyan('Or deploy with Docker:'));
    console.log(`    ${chalk.cyan('docker compose -f docker-compose.production.yml up --build -d')}\n`);

    console.log(chalk.dim('  🌐 Documentation: https://github.com/spfn/spfn\n'));
}

export const createCommand = new Command('create')
    .description('Create a new Next.js project with SPFN')
    .argument('<project-name>', 'Name of the project directory')
    .option('--skip-install', 'Skip installing dependencies')
    .option('--skip-git', 'Skip initializing a git repository')
    .option('--pm <manager>', 'Package manager to use (npm, pnpm, yarn, bun)')
    .option('--shadcn', 'Setup shadcn/ui (component library)')
    .addOption(new Option('--mode <mode>', 'Scaffold mode: bare (core) or full (core, auth, i18n, MCP)')
        .choices(['bare', 'full']))
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(async (projectName: string, options: CreateOptions) =>
    {
        await createProject(projectName, options);
    });
