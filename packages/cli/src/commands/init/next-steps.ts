import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { getRunCommand, type PackageManager } from '../../utils/package-manager.js';
import { ENV_FILES_HINT } from '../../utils/messages.js';
import type { ScaffoldMode } from './mode.js';

export interface NextStepsOptions
{
    pm: PackageManager;
    mode: ScaffoldMode;
    /** The scaffolded app's directory */
    appDir: string;
    /** Set by `spfn create`: the directory the user changes into first */
    projectName?: string;
}

/**
 * What a scaffolded app runs to start: the one list `spfn create` and
 * `spfn init` print, once, from whichever command the user ran.
 *
 * A scaffold holding an entity, or `@spfn/auth` (full mode), needs its tables
 * before the first query. `spfn db push` creates them: the installed function
 * packages' migrations first, then the app's schema, which no migration file
 * carries yet (`db migrate` would apply only the former).
 */
export function scaffoldNextSteps(options: NextStepsOptions): string[]
{
    const steps = [
        ...(options.projectName ? [chalk.cyan(`cd ${options.projectName}`)] : []),
        'Start PostgreSQL & Redis (if not installed locally):\n     ' + chalk.cyan('docker compose up -d'),
        'Review the generated env files (.env.local, .env.server)\n     ' + chalk.dim(ENV_FILES_HINT),
        ...(needsTables(options) ? [createTablesStep(options)] : []),
        'Run: ' + chalk.cyan(`${getRunCommand(options.pm)} spfn:dev`),
        visitStep(options.mode),
    ];

    return steps.map((step, index) => `  ${index + 1}. ${step}`);
}

export function printNextSteps(options: NextStepsOptions): void
{
    console.log('Next steps:');
    scaffoldNextSteps(options).forEach(line => console.log(line));
}

function needsTables({ mode, appDir }: NextStepsOptions): boolean
{
    const entities = join(appDir, 'src', 'server', 'entities');

    return mode === 'full'
        || (existsSync(entities) && readdirSync(entities).some(name => name.endsWith('.entity.ts')));
}

function createTablesStep({ pm, mode }: NextStepsOptions): string
{
    const spfnCommand = pm === 'npm' ? 'npx spfn' : `${pm} spfn`;
    const what = mode === 'full' ? "the auth migrations, then the app's tables" : "the app's tables";

    return `Create the database tables (${what}): ` + chalk.cyan(`${spfnCommand} db push`);
}

function visitStep(mode: ScaffoldMode): string
{
    return [
        'Visit:',
        '     - Next.js: ' + chalk.cyan('http://localhost:3790'),
        '     - API:     ' + chalk.cyan('http://localhost:8790/_core/health'),
        ...(mode === 'full' ? ['     - MCP:     ' + chalk.cyan('http://localhost:8790/mcp')] : []),
    ].join('\n');
}
