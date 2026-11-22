import chalk from 'chalk';
import { existsSync } from 'fs';
import { join, relative, resolve } from 'path';
import { isTable } from 'drizzle-orm';
import { APP_PRIVILEGES_MANIFEST_FILE, drizzleKitSchemaFiles, renderAppPrivilegesManifest, renderSchemaFilesConfig, writeAppPrivilegesManifest } from '@spfn/core/db';
import {
    DRIZZLE_KIT_DEFAULT_OUT,
    PROJECT_DRIZZLE_CONFIG,
    loadSchemaModules,
    readDrizzleConfigSchema,
    resolveTempConfig,
    runDrizzleKit,
    withoutFunctionPackageValues,
} from './utils/drizzle.js';
import { writeTempDrizzleConfig } from './utils/temp-config.js';
import { databaseUrlFor, loadEnvFor } from '../../utils/database-connection.js';

/**
 * The drizzle-kit config of one `db generate` run, resolved before
 * drizzle-kit runs
 */
interface GenerateConfig
{
    /** The schema files the run loads, and the only ones the config names */
    schemaFiles: string[];
    /** The folder drizzle-kit writes the migrations to, relative to the working directory */
    out: string;
    /** The source of the config the run writes and hands drizzle-kit */
    content: string;
}

/**
 * Generate database migrations from schema changes, then the privileges
 * manifest beside them
 * Uses interactive mode to support drizzle-kit prompts
 *
 * Everything that can fail is checked before drizzle-kit runs: the config
 * resolves, every schema module loads and the manifest renders. Once
 * drizzle-kit has written a migration, only the manifest file is written;
 * when that fails, the command says the migrations are there and to rerun it.
 */
export async function dbGenerate(): Promise<void>
{
    const { config, tables } = await generateMigrations()
        .catch((error: unknown) => exitWith('Failed to generate migrations', error));

    console.log(chalk.green('\n✅ Migrations generated successfully'));

    const manifest = writeManifestOrExit(config.out, tables);

    if (manifest) console.log(chalk.green(`✅ App privileges written to ${relative(process.cwd(), manifest)}`));
}

/** Everything before the manifest: resolve the config, load and check the tables, run drizzle-kit. */
async function generateMigrations(): Promise<{ config: GenerateConfig; tables: unknown[] }>
{
    loadEnvFor('db generate');
    const databaseUrl = databaseUrlFor('db generate');
    const config = await resolveGenerateConfig(databaseUrl);
    const tables = await appTables(config.schemaFiles);

    // Rendered here only to refuse two tables of one name declaring different lists before anything is written
    renderAppPrivilegesManifest(tables);
    await runGenerate(config, databaseUrl);

    return { config, tables };
}

function exitWith(headline: string, error: unknown): never
{
    console.error(chalk.red(`\n❌ ${headline}`));
    console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
    process.exit(1);
}

/**
 * The config drizzle-kit is handed, naming the schema files core expanded,
 * so drizzle-kit reads the files the manifest is made from: the project's
 * drizzle.config.ts with its schema replaced by those files (read without a
 * database URL); else the one generated from core's defaults, which carries
 * the URL and so requires it.
 */
async function resolveGenerateConfig(databaseUrl: string | undefined): Promise<GenerateConfig>
{
    if (existsSync(PROJECT_DRIZZLE_CONFIG))
    {
        const project = await readDrizzleConfigSchema();

        if (!project) throw new Error(`${PROJECT_DRIZZLE_CONFIG} names no schema`);

        const schemaFiles = drizzleKitSchemaFiles(project.schema);

        return {
            schemaFiles,
            out: project.out ?? DRIZZLE_KIT_DEFAULT_OUT,
            content: renderSchemaFilesConfig(resolve(PROJECT_DRIZZLE_CONFIG), schemaFiles),
        };
    }

    if (!databaseUrl) throw new Error('DATABASE_URL not found in environment: add it to your .env file, or add a drizzle.config.ts');

    const temp = await resolveTempConfig({ reconcile: true, databaseUrl });

    return { schemaFiles: temp.files, out: temp.out, content: temp.content };
}

/**
 * Every table the config's schema files export, each file loaded on its own
 * as drizzle-kit loads it, less a function package's tables: the package
 * declares those in its own migrations folder.
 */
async function appTables(schemaFiles: string[]): Promise<unknown[]>
{
    const values = (await loadSchemaModules(schemaFiles)).flatMap(exports => Object.values(exports));

    return withoutFunctionPackageValues(values.filter(value => isTable(value)));
}

/** Run drizzle-kit generate against the config, written for the run only. */
async function runGenerate(config: GenerateConfig, databaseUrl: string | undefined): Promise<void>
{
    const tempConfig = writeTempDrizzleConfig(config.content);

    try
    {
        await runDrizzleKit('generate', tempConfig.path, databaseUrl);
    }
    finally
    {
        tempConfig.remove();
    }
}

/**
 * Write `privileges.json` into `out`, beside the migrations drizzle-kit just
 * wrote there: every table among `tables`, with its `appPrivileges`
 * declaration or the default set. Written on every run, since a changed
 * declaration changes no DDL and drizzle-kit then generates no migration;
 * skipped for a project with neither a table nor that folder.
 *
 * @returns the file written, or undefined when skipped
 */
function writePrivilegesManifest(out: string, tables: unknown[]): string | undefined
{
    const migrationsDir = resolve(out);

    if (tables.length === 0 && !existsSync(migrationsDir))
    {
        return undefined;
    }

    return writeAppPrivilegesManifest(migrationsDir, tables);
}

/**
 * writePrivilegesManifest, ending the command when the file cannot be
 * written: the migrations drizzle-kit wrote stay, and a rerun writes the
 * manifest from the same entities.
 */
function writeManifestOrExit(out: string, tables: unknown[]): string | undefined
{
    try
    {
        return writePrivilegesManifest(out, tables);
    }
    catch (error)
    {
        exitWith(
            `Failed to write ${join(out, APP_PRIVILEGES_MANIFEST_FILE)}; the migrations were written to ${out}. `
            + 'Fix what stopped the write (below) and rerun `spfn db generate`: it writes the manifest, and no second migration for the same schema',
            error,
        );
    }
}
