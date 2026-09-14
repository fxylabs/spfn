import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, isAbsolute } from 'path';
import { spawn } from 'child_process';
import { pathToFileURL } from 'url';
import chalk from 'chalk';
import ora from 'ora';

import { is } from 'drizzle-orm';
import {
    PgSchema,
    PgTable,
    getTableConfig,
    getViewConfig,
    getMaterializedViewConfig,
    isPgEnum,
    isPgView,
    isPgMaterializedView,
    isPgSequence,
} from 'drizzle-orm/pg-core';
import { env } from '@spfn/core/config';
import { getDrizzleConfig, renderDrizzleConfig, discoverFunctionMigrations, packageNameToSchema } from '@spfn/core/db';
import { loadEnv } from '@spfn/core/server';

const TLS_SSL_MODES = new Set(['no-verify', 'prefer', 'require', 'verify-ca', 'verify-full']);

function parseDatabaseUrl(databaseUrl: string | undefined): URL | undefined
{
    if (!databaseUrl)
    {
        return undefined;
    }

    try
    {
        return new URL(databaseUrl);
    }
    catch
    {
        return undefined;
    }
}

function isLoopbackDatabaseUrl(databaseUrl: URL): boolean
{
    const host = databaseUrl.hostname.replace(/^\[|\]$/g, '');

    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function requestsDbTls(databaseUrl: URL): boolean
{
    const sslMode = databaseUrl.searchParams.get('sslmode')?.toLowerCase();
    if (sslMode)
    {
        return TLS_SSL_MODES.has(sslMode);
    }

    return databaseUrl.searchParams.get('ssl')?.toLowerCase() === 'true';
}

function insecureDbTlsEnabled(): boolean
{
    return process.env.SPFN_DB_INSECURE_TLS === '1' || process.env.SPFN_DB_INSECURE_TLS === 'true';
}

/**
 * Whether to relax TLS certificate verification for the DB connection.
 *
 * This opt-in applies only when DATABASE_URL explicitly requests TLS. It must
 * never turn TLS on by itself: a normal loopback PostgreSQL server commonly has
 * no TLS support at all.
 */
export function shouldRelaxDbTls(databaseUrl: string | undefined): boolean
{
    const parsedUrl = parseDatabaseUrl(databaseUrl);
    const sslMode = parsedUrl?.searchParams.get('sslmode')?.toLowerCase();

    return insecureDbTlsEnabled()
        && parsedUrl !== undefined
        && requestsDbTls(parsedUrl)
        && sslMode !== 'no-verify';
}

export interface PushConnectionConfig
{
    connectionString: string;
    ssl?: false;
}

/**
 * Resolve node-postgres connection options without conflating TLS enablement
 * with certificate verification.
 *
 * Loopback URLs default to plaintext unless their URL explicitly requests TLS.
 * URL sslmode remains authoritative. The insecure-TLS opt-in only replaces a
 * requested TLS mode with an equivalent per-connection unverified TLS option.
 */
export function resolvePushConnectionConfig(databaseUrl: string): PushConnectionConfig
{
    const parsedUrl = parseDatabaseUrl(databaseUrl);
    if (!parsedUrl)
    {
        return { connectionString: databaseUrl };
    }

    const sslMode = parsedUrl.searchParams.get('sslmode')?.toLowerCase();
    const hasExplicitSslSetting = parsedUrl.searchParams.has('sslmode') || parsedUrl.searchParams.has('ssl');
    if (sslMode === 'disable')
    {
        return { connectionString: databaseUrl, ssl: false };
    }

    const tlsRequested = requestsDbTls(parsedUrl);
    if (!hasExplicitSslSetting && isLoopbackDatabaseUrl(parsedUrl))
    {
        return { connectionString: databaseUrl, ssl: false };
    }

    if (!tlsRequested || !insecureDbTlsEnabled())
    {
        return { connectionString: databaseUrl };
    }

    // SSL parameters in a node-postgres connection string override a top-level
    // ssl object. Express the opt-in in the URL so any certificate/key parameters
    // continue to be parsed together with it.
    parsedUrl.searchParams.set('sslmode', 'no-verify');
    parsedUrl.searchParams.delete('ssl');

    return { connectionString: parsedUrl.toString() };
}

/**
 * Validate prerequisites for database operations
 * Ensures DATABASE_URL is available
 * @throws Error if DATABASE_URL is not found
 */
export function validateDatabasePrerequisites(): void
{
    loadEnv();
    if (!env.DATABASE_URL)
    {
        console.error(chalk.red('❌ DATABASE_URL not found in environment'));
        console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL to your .env file'));
        throw new Error('DATABASE_URL is required for database operations');
    }
}

/**
 * Generate temporary drizzle.config.ts and run drizzle-kit command
 * Uses spawn to support interactive prompts from drizzle-kit
 */
export async function runDrizzleCommand(command: string): Promise<void>
{
    const hasUserConfig = existsSync('./drizzle.config.ts');
    const tempConfigPath = `./drizzle.config.${process.pid}.${Date.now()}.temp.ts`;

    const configPath = hasUserConfig ? './drizzle.config.ts' : tempConfigPath;

    if (!hasUserConfig)
    {
        loadEnv();
        if (!env.DATABASE_URL)
        {
            console.error(chalk.red('❌ DATABASE_URL not found in environment'));
            console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL to your .env file'));
            process.exit(1);
        }

        writeFileSync(tempConfigPath, await generateTempConfigOrExit({ reconcile: command === 'generate' }));
    }

    // Run drizzle-kit command with spawn to support interactive prompts
    const args = command.split(' ');
    args.push(`--config=${configPath}`);

    return new Promise<void>((resolve, reject) =>
    {
        const drizzleProcess = spawn('drizzle-kit', args, {
            stdio: 'inherit', // Allow interactive input
            shell: true,
            env: shouldRelaxDbTls(env.DATABASE_URL)
                ? { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
                : { ...process.env },
        });

        const cleanup = () =>
        {
            // Clean up temp config
            if (!hasUserConfig && existsSync(tempConfigPath))
            {
                unlinkSync(tempConfigPath);
            }
        };

        drizzleProcess.on('close', (code) =>
        {
            cleanup();
            if (code === 0)
            {
                resolve();
            }
            else
            {
                reject(new Error(`drizzle-kit ${command} exited with code ${code}`));
            }
        });

        drizzleProcess.on('error', (error) =>
        {
            cleanup();
            reject(error);
        });
    });
}

/**
 * Helper: Run drizzle command with spinner
 */
export async function runWithSpinner(
    spinnerText: string,
    command: string,
    successMessage: string,
    failMessage: string,
): Promise<void>
{
    const spinner = ora(spinnerText).start();

    try
    {
        spinner.stop();
        await runDrizzleCommand(command);
        console.log(chalk.green(`✅ ${successMessage}`));
    }
    catch (error)
    {
        spinner.fail(failMessage);
        console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
        process.exit(1);
    }
}

/**
 * Check if tsx ESM loader is available.
 *
 * On Node.js 22+, tsx must be loaded via --import tsx at process start
 * (handled by bin/spfn.js). Calling tsx.register() at runtime causes
 * ERR_REQUIRE_CYCLE_MODULE due to CJS/ESM interop issues.
 *
 * This function is kept for backwards compatibility but is now a no-op.
 * The bin entry point handles tsx loader registration via process re-spawn.
 */
async function ensureTsxLoader(): Promise<void>
{
    // No-op: tsx loader is registered at process start via --import tsx
    // See bin/spfn.js for the re-spawn mechanism
}

type DrizzleConfig = ReturnType<typeof getDrizzleConfig>;

/**
 * The schema files a command loads, after the one check core cannot make
 * without loading modules.
 */
export interface ResolvedSchema
{
    files: string[];
    /** Where the files came from, for the console */
    source: string;
    /** Why the registry replaced the folder scan, when it did */
    note?: string;
    /** The loaded modules, when resolving already had to load them */
    imports?: Record<string, unknown>;
}

const toList = (schema: string | string[]): string[] => (Array.isArray(schema) ? schema : [schema]);

/**
 * Schema objects a module set exports — tables, enums, views, sequences —
 * keyed by object identity, with a display name
 */
function exportedObjects(imports: Record<string, unknown>, ignoredSchemas: Map<string, string>): Map<unknown, string>
{
    const objects = new Map<unknown, string>();

    for (const [key, value] of Object.entries(imports))
    {
        const name = objectName(value, key);

        if (name && !ignoredSchemas.has(schemaOf(value) ?? 'public')) objects.set(value, name);
    }

    return objects;
}

function objectName(value: unknown, key: string): string | undefined
{
    if (is(value, PgTable)) return getTableConfig(value).name;
    if (is(value, PgSchema)) return `schema ${value.schemaName}`;
    if (isPgEnum(value)) return `enum ${value.enumName}`;
    if (isPgView(value)) return `view ${getViewConfig(value).name}`;
    if (isPgMaterializedView(value)) return `view ${getMaterializedViewConfig(value).name}`;
    if (isPgSequence(value)) return `sequence ${key}`;

    return undefined;
}

/**
 * PostgreSQL schemas owned by installed function packages that ship their own
 * migrations (@spfn/auth → spfn_auth), each mapped to the package that owns it.
 *
 * Their tables, re-exported from the registry for relations, are theirs to
 * migrate: they never decide the folder-versus-registry choice, never enter the
 * project's push diff, and never reach a project migration.
 */
function functionPackageSchemas(cwd: string): Map<string, string>
{
    return new Map(discoverFunctionMigrations(cwd).map(info => [packageNameToSchema(info.packageName), info.packageName]));
}

/**
 * The loaded objects less those living in a schema a function package owns.
 * `db push` diffs what is left, as it did before the registry could become the
 * schema: a re-exported package table is neither created nor dropped here.
 */
export function withoutFunctionPackageObjects(
    imports: Record<string, unknown>,
    cwd: string = process.cwd(),
): Record<string, unknown>
{
    const owners = functionPackageSchemas(cwd);

    if (owners.size === 0) return imports;

    return Object.fromEntries(Object.entries(imports).filter(([, value]) => !ownerOf(value, owners)));
}

/**
 * The function package that owns a loaded object's schema, if one does
 */
function ownerOf(value: unknown, owners: Map<string, string>): string | undefined
{
    const schema = schemaOf(value);

    return schema ? owners.get(schema) : undefined;
}

/**
 * Loaded objects a function package owns, named with their package
 */
function functionPackageExports(imports: Record<string, unknown>, owners: Map<string, string>): string[]
{
    const owned: string[] = [];

    for (const [key, value] of Object.entries(imports))
    {
        const name = objectName(value, key);
        const owner = ownerOf(value, owners);

        if (name && owner) owned.push(`${name} (${owner})`);
    }

    return owned;
}

const onlyIn = (a: Map<unknown, string>, b: Map<unknown, string>): string[] =>
    Array.from(a).filter(([object]) => !b.has(object)).map(([, name]) => name);

/**
 * Choose between the folder scan and the registry when a project has both.
 *
 * core picks the scan (main's behaviour) and reports the registry. Here both
 * are loaded and their exported schema objects — tables, schemas, enums, views,
 * sequences, less those owned by function packages — compared by identity:
 *
 * - every registry object is among the scanned exports (the scaffold): the scan
 * - the registry exports objects the scan lacks and the scan defines nothing the
 *   registry lacks (the tables moved out, a re-exported file was left behind):
 *   the registry alone, with a note
 * - each side has objects the other lacks: neither choice keeps every table,
 *   so the command stops and names both sets
 *
 * Without a registry nothing is loaded here.
 */
export async function resolveSchemaFiles(config: DrizzleConfig, cwd: string = process.cwd()): Promise<ResolvedSchema>
{
    const files = toList(config.schema);

    if (!config.schemaRegistry) return { files, source: config.schemaSource };

    const registryFile = isAbsolute(config.schemaRegistry) ? config.schemaRegistry : join(cwd, config.schemaRegistry);
    const [scanned, registry] = await Promise.all([loadSchemaImports(files), loadSchemaImports([registryFile])]);
    const ignored = functionPackageSchemas(cwd);
    const scannedObjects = exportedObjects(scanned, ignored);
    const registryObjects = exportedObjects(registry, ignored);
    const registryOnly = onlyIn(registryObjects, scannedObjects);

    if (registryOnly.length === 0) return { files, source: config.schemaSource, imports: scanned };

    const scanOnly = onlyIn(scannedObjects, registryObjects);

    if (scanOnly.length > 0)
    {
        throw new Error(
            `${config.schemaRegistry} exports ${registryOnly.join(', ')} which no file under src/server/entities/ defines, `
            + `while the folder defines ${scanOnly.join(', ')} which the registry does not export. `
            + 'Neither alone is the whole schema: re-export the folder\'s entities from the registry, '
            + 'move the leftover files out, or name the schema in drizzle.config.ts.',
        );
    }

    return {
        files: [registryFile],
        source: `entity registry ${config.schemaRegistry}`,
        imports: registry,
        note: `${config.schemaRegistry} exports ${registryOnly.join(', ')}, which no file under src/server/entities/ defines; `
            + `loading the registry instead of the ${files.length} file(s) still there.`,
    };
}

/**
 * drizzle-kit `generate` reads the schema files itself: there is no import step
 * to filter, and `prepareGenerateConfig` reads no `schemaFilter` (verified
 * against drizzle-kit 1.0.0-rc.4 — a config naming one still emits the other
 * schemas' tables). So a file that reaches a function package's table writes it
 * into a project migration that cannot run on a fresh database — the package's
 * `CREATE SCHEMA` is not there — and collides with the package's own migration
 * on an existing one. Stop and name the re-exports instead.
 */
async function assertNoFunctionPackageExports(resolved: ResolvedSchema, cwd: string): Promise<void>
{
    const owners = functionPackageSchemas(cwd);

    // Without an installed package that ships migrations nothing can be owned
    // elsewhere, so no project pays for the modules this check would load
    if (owners.size === 0) return;

    const owned = functionPackageExports(resolved.imports ?? await loadSchemaImports(resolved.files), owners);

    if (owned.length === 0) return;

    throw new Error(
        `The schema read from ${resolved.source} reaches ${owned.join(', ')}, which the package migrates itself. `
        + 'db generate would copy those objects into a project migration that cannot run on a fresh database '
        + 'and collides with the package\'s own. Keep the package out of the schema files: a relation can '
        + 'import its table without re-exporting it.',
    );
}

/**
 * The files the temp config names. A command that reads the schema settles
 * folder versus registry and refuses one that reaches a function package's
 * objects; one that does not (check, drop) writes the scan as-is.
 */
async function resolveTempConfigSchema(config: DrizzleConfig, cwd: string, reconcile: boolean): Promise<ResolvedSchema>
{
    if (!reconcile) return { files: toList(config.schema), source: config.schemaSource };

    const resolved = await resolveSchemaFiles(config, cwd);

    await assertNoFunctionPackageExports(resolved, cwd);

    return resolved;
}

/**
 * Build the temp drizzle config for a project without drizzle.config.ts.
 * drizzle-kit `generate` and `studio` read no schemaFilter, so none is written.
 * `reconcile` loads the entity modules to settle folder versus registry; pass it
 * for a command that reads the schema.
 */
export async function generateTempConfig(options: { reconcile: boolean }): Promise<string>
{
    loadEnv();

    const cwd = process.cwd();
    const config = getDrizzleConfig({
        cwd,
        // Exclude package schemas to avoid .ts/.js mixing (packages use migrations instead)
        disablePackageDiscovery: true,
        expandGlobs: true,
    });
    const resolved = await resolveTempConfigSchema(config, cwd, options.reconcile);

    console.log(chalk.dim(`Using auto-generated Drizzle config (schema: ${resolved.source})`));
    if (resolved.note) console.log(chalk.yellow(`ℹ️  ${resolved.note}`));
    console.log();

    return renderDrizzleConfig({ ...config, schema: resolved.files }, cwd);
}

/**
 * generateTempConfig, ending the command with the resolver's message instead
 * of a stack when the folder and the registry disagree
 */
export async function generateTempConfigOrExit(options: { reconcile: boolean }): Promise<string>
{
    try
    {
        return await generateTempConfig(options);
    }
    catch (error)
    {
        console.error(chalk.red(`❌ ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
    }
}

/**
 * The PostgreSQL schemas `db push` diffs: a schemaFilter declared in
 * drizzle.config.ts (it may exclude `public` on purpose; drizzle-kit reads an
 * empty one as "no filter", so empty counts as undeclared), else `public`; plus,
 * either way, every schema the loaded modules name — tables, `pgSchema()`
 * objects, enums, views, sequences — less the schemas function packages own,
 * since drizzle-kit creates and alters only what the filter admits.
 */
export function resolvePushSchemaFilter(
    declared: string[] | undefined,
    imports: Record<string, unknown>,
    cwd: string = process.cwd(),
): string[]
{
    const base = declared && declared.length > 0 ? declared : ['public'];
    const owners = functionPackageSchemas(cwd);

    // A plain pgTable lives in public, so a declared filter that omits public
    // still admits the public tables the code defines. A schema a function
    // package owns is left to the package's own migrations, so a registry that
    // re-exports one of its tables for a relation does not put the rest of that
    // schema up for DROP. A declared filter still stands verbatim: naming a
    // package schema there is the user's own choice.
    const detected = detectSchemasFromImports(imports).filter(schema => !owners.has(schema));

    return Array.from(new Set([...base, ...detected]));
}

/**
 * PostgreSQL schemas named by the loaded module objects
 */
export function detectSchemasFromImports(imports: Record<string, unknown>): string[]
{
    const schemas = new Set<string>();

    for (const value of Object.values(imports))
    {
        const schema = schemaOf(value);

        if (schema) schemas.add(schema);
    }

    return Array.from(schemas);
}

/**
 * The PostgreSQL schema a drizzle object lives in; `public` for an object
 * declared without one. Undefined for values that are not schema objects.
 */
function schemaOf(value: unknown): string | undefined
{
    if (is(value, PgTable)) return getTableConfig(value).schema ?? 'public';
    if (is(value, PgSchema)) return value.schemaName;
    if (isPgEnum(value)) return value.schema ?? 'public';
    if (isPgView(value)) return getViewConfig(value).schema ?? 'public';
    if (isPgMaterializedView(value)) return getMaterializedViewConfig(value).schema ?? 'public';
    if (isPgSequence(value)) return value.schema ?? 'public';

    return undefined;
}

export interface DrizzleConfigSchema
{
    schema: string | string[];
    schemaFilter?: string[];
}

/**
 * Read the `schema` and `schemaFilter` entries of the project's drizzle.config.ts,
 * the file `db generate` runs against when the project has one.
 *
 * @returns undefined when there is no drizzle.config.ts or it names no schema
 */
export async function readDrizzleConfigSchema(cwd: string = process.cwd()): Promise<DrizzleConfigSchema | undefined>
{
    const configPath = join(cwd, 'drizzle.config.ts');

    if (!existsSync(configPath)) return undefined;

    const mod = await import(pathToFileURL(configPath).href);
    // A CommonJS-compiled config arrives as { default: { default: config } }
    const config = mod.default?.default ?? mod.default;
    const schema = config?.schema;

    if (typeof schema !== 'string' && !Array.isArray(schema)) return undefined;

    // drizzle-kit accepts schemaFilter as a string or an array
    const schemaFilter = typeof config.schemaFilter === 'string' ? [config.schemaFilter] : config.schemaFilter;

    return { schema, schemaFilter: Array.isArray(schemaFilter) ? schemaFilter : undefined };
}

/**
 * Schema named by the user, with where it came from; undefined leaves the
 * resolution to core (the folder scan, or the registry)
 */
export type SchemaSource = DrizzleConfigSchema & { label: string };

/**
 * Pick the schema entry point the way `db generate` does: an explicit --schema,
 * then drizzle.config.ts, then the core default (folder scan, else the registry).
 * A drizzle.config.ts that fails to load throws unless --schema bypasses it; the
 * caller reports it.
 */
export async function resolvePushSchemaSource(explicit?: string, cwd: string = process.cwd()): Promise<SchemaSource | undefined>
{
    if (explicit)
    {
        // --schema replaces the files, not a schemaFilter the config declares on
        // purpose; a config that cannot be loaded is what --schema exists to bypass
        const schemaFilter = await readDrizzleConfigSchema(cwd).then(config => config?.schemaFilter, () => undefined);

        return { schema: explicit, schemaFilter, label: '--schema' };
    }

    const fromConfig = await readDrizzleConfigSchema(cwd);

    return fromConfig && { ...fromConfig, label: 'drizzle.config.ts' };
}

/**
 * Dynamically import schema files and merge all exports into a single object.
 * Used to build the `imports` parameter for drizzle-kit's `pushSchema()`.
 */
export async function loadSchemaImports(schemaFiles: string[]): Promise<Record<string, unknown>>
{
    // Ensure tsx loader is registered so .ts files can be imported
    const hasTsFiles = schemaFiles.some(f => f.endsWith('.ts'));
    if (hasTsFiles)
    {
        await ensureTsxLoader();
    }

    const imports: Record<string, unknown> = {};

    for (const file of schemaFiles)
    {
        const moduleUrl = pathToFileURL(file).href;
        const mod = await import(moduleUrl);

        for (const [key, value] of Object.entries(mod))
        {
            if (key !== 'default')
            {
                imports[key] = value;
            }
        }
    }

    return imports;
}

/**
 * Create a drizzle-orm PgDatabase instance for pushSchema().
 * Uses `pg` (node-postgres) driver because drizzle-kit's internal adapter
 * expects `execute()` to return `{ rows: [...] }`, which `pg` provides
 * but `postgres.js` does not.
 */
export async function createPushConnection(): Promise<{ db: any; close: () => Promise<void> }>
{
    loadEnv();

    if (!env.DATABASE_URL)
    {
        throw new Error('DATABASE_URL is required');
    }

    const pg = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');

    const connectionConfig = resolvePushConnectionConfig(env.DATABASE_URL);
    const pool = new pg.default.Pool({
        ...connectionConfig,
        max: 1,
    });
    const db = drizzle({ client: pool });

    return {
        db,
        close: () => pool.end(),
    };
}
