import { Command, Option } from 'commander';
import chalk from 'chalk';
import { detectPackageManager, getRunCommand, type PackageManager } from '../../utils/package-manager.js';
import { logger } from '../../utils/logger.js';
import { ENV_FILES_HINT } from '../../utils/messages.js';
import { validateProject } from './steps/validate.js';
import { setupServerStructure } from './steps/server-structure.js';
import { setupApiProxy } from './steps/api-proxy.js';
import { setupNextConfig } from './steps/next-config.js';
import { setupDockerFiles } from './steps/docker.js';
import { setupDeploymentConfig } from './steps/deployment-config.js';
import { setupPackageJson } from './steps/package.js';
import { setupConfigFiles } from './steps/config-files.js';
import { setupReadme } from './steps/readme.js';
import { selectScaffoldMode, type ScaffoldMode } from './mode.js';

interface InitOptions
{
    yes?: boolean;
    // Set by `spfn create` to replace the create-next-app README with the SPFN one.
    overwriteReadme?: boolean;
    mode?: ScaffoldMode;
    // The app's package manager when the caller knows it (`spfn create`, `--pm`).
    pm?: PackageManager;
}

/**
 * Initialize SPFN in a Next.js project
 */
export async function initializeSpfn(options: InitOptions = {}): Promise<void>
{
    const cwd = process.cwd();

    // Step 1: Validate project and check if already initialized
    const { packageJson, packageJsonPath } = await validateProject(cwd, options.yes || false);
    const mode = await selectScaffoldMode(options);
    const includeAuth = mode === 'full';

    // Step 2: Package manager — the one given, detected only when none was
    const pm = options.pm ?? detectPackageManager(cwd);
    logger.step(options.pm ? `Using package manager: ${pm}` : `Detected package manager: ${pm}`);

    // Step 3: Setup server structure (templates → src/server, src/lib)
    await setupServerStructure(cwd, mode);

    // Step 4: Create API proxy route
    await setupApiProxy(cwd, includeAuth);

    // Step 4.5: Ensure the /_auth/* → API rewrite (OAuth callbacks land on the app origin)
    await setupNextConfig(cwd, includeAuth);

    // Step 5: Copy Docker files
    await setupDockerFiles(cwd, pm);

    // Step 6: Generate deployment config (spfn.config.js)
    await setupDeploymentConfig(cwd, packageJson, pm);

    // Step 7: Update package.json and install dependencies
    await setupPackageJson(cwd, packageJsonPath, packageJson, pm, mode);

    // Step 8: Setup configuration files (.env, .spfnrc.ts, .gitignore, tsconfig)
    await setupConfigFiles(cwd, mode);

    // Step 9: Create README.md (only when one doesn't already exist)
    await setupReadme(cwd, { pm, packageJson, mode, overwrite: options.overwriteReadme ?? false });

    // Done - Show success message and next steps
    console.log('\n' + chalk.green.bold('✓ SPFN initialized successfully!\n'));

    console.log('Next steps:');
    console.log('  1. Start PostgreSQL & Redis (if not installed locally):');
    console.log('     ' + chalk.cyan('docker compose up -d'));
    console.log('  2. Review the generated env files (.env.local, .env.server)');
    console.log('     ' + chalk.dim(ENV_FILES_HINT));
    if (mode === 'full')
    {
        const spfnCommand = pm === 'npm' ? 'npx spfn' : `${pm} spfn`;
        console.log('  3. Apply the auth migrations: ' + chalk.cyan(`${spfnCommand} db migrate`));
    }
    console.log(`  ${mode === 'full' ? '4' : '3'}. Run: ` + chalk.cyan(`${getRunCommand(pm)} spfn:dev`));
    console.log(`  ${mode === 'full' ? '5' : '4'}. Visit:`);
    console.log('     - Next.js: ' + chalk.cyan('http://localhost:3790'));
    console.log('     - API:     ' + chalk.cyan('http://localhost:8790/_core/health'));
    if (mode === 'full')
    {
        console.log('     - MCP:     ' + chalk.cyan('http://localhost:8790/mcp'));
    }
    console.log('\nAvailable commands:');
    console.log('  • ' + chalk.cyan(`${getRunCommand(pm)} spfn:dev`) + '       - Start SPFN + Next.js');
    console.log('  • ' + chalk.cyan('spfn env validate') + '  - Validate environment variables');
    console.log('  • ' + chalk.cyan('spfn env list') + '      - List env vars from the schema');
    console.log('  • ' + chalk.cyan('spfn secret set') + '    - Store a secret (keychain / SOPS)');
    console.log('\n' + chalk.blue('💡 Tip:') + ' Edit ' + chalk.cyan('src/server/config/env.config.ts') + ' to manage environment variables');
}

export const initCommand = new Command('init')
    .description('Initialize SPFN in your Next.js project')
    .addOption(new Option('--mode <mode>', 'Scaffold mode: bare (core) or full (core, auth, i18n, MCP)')
        .choices(['bare', 'full']))
    .addOption(new Option('--pm <manager>', 'Package manager to use (default: detected from the app)')
        .choices(['npm', 'pnpm', 'yarn', 'bun']))
    .option('-y, --yes', 'Skip prompts and use defaults')
    .action(initializeSpfn);
