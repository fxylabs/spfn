import { existsSync } from 'fs';
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
import { getDrizzleConfig, renderDrizzleConfig, discoverFunctionMigrations, packageNameToSchema } from '@spfn/core/db';
import { loadEnv } from '@spfn/core/server';
import { assertTypeScriptLoadable } from '../../../utils/tsx-required.js';
import { redactUrls } from '../../../utils/redact-urls.js';
import { writeTempDrizzleConfig, type TempDrizzleConfig } from './temp-config.js';
import { databaseUrlFor, loadEnvFor, type DatabaseCommand } from '../../../utils/database-connection.js';

const TLS_SSL_MODES = new Set(['no-verify', 'prefer', 'require', 'verify-ca', 'verify-full']);

/** The project's own drizzle config, as drizzle-kit's `--config` takes it */
export const PROJECT_DRIZZLE_CONFIG = './drizzle.config.ts';

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
 * Validate prerequisites for database operations: load the environment and
 * ensure `command`'s connection is configured
 * @throws Error if its URL is not set
 */
export function validateDatabasePrerequisites(command: DatabaseCommand): void
{
    loadEnvFor(command);
    if (!databaseUrlFor(command))
    {
        console.error(chalk.red('❌ DATABASE_URL not found in environment'));
        console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL to your .env file'));
        throw new Error('DATABASE_URL is required for database operations');
    }
}

/**
 * Generate temporary drizzle.config.ts and run drizzle-kit command
 * Uses spawn to support interactive prompts from drizzle-kit
 *
 * `databaseUrl` is the command's connection (`databaseUrlFor`), written into
 * the generated config; a project's own drizzle.config.ts names its own.
 */
export async function runDrizzleCommand(command: string, databaseUrl: string | undefined): Promise<void>
{
    let tempConfig: TempDrizzleConfig | undefined;

    if (!existsSync(PROJECT_DRIZZLE_CONFIG))
    {
        if (!databaseUrl)
        {
            console.error(chalk.red('❌ DATABASE_URL not found in environment'));
            console.log(chalk.yellow('\n💡 Tip: Add DATABASE_URL to your .env file'));
            process.exit(1);
        }

        tempConfig = writeTempDrizzleConfig(await generateTempConfigOrExit({ reconcile: command === 'generate', databaseUrl }));
    }

    try
    {
        await runDrizzleKit(command, tempConfig?.path ?? PROJECT_DRIZZLE_CONFIG, databaseUrl);
    }
    finally
    {
        tempConfig?.remove();
    }
}

/**
 * Run drizzle-kit `command` against the config at `configPath`, with the
 * terminal attached for its prompts. `databaseUrl` decides only whether TLS
 * verification is relaxed (`shouldRelaxDbTls`).
 */
export function runDrizzleKit(command: string, configPath: string, databaseUrl: string | undefined): Promise<void>
{
    const args = [...command.split(' '), `--config=${configPath}`];

    return new Promise<void>((resolve, reject) =>
    {
        const drizzleProcess = spawn('drizzle-kit', args, {
            stdio: 'inherit', // Allow interactive input
            shell: true,
            env: shouldRelaxDbTls(databaseUrl)
                ? { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }
                : { ...process.env },
        });

        drizzleProcess.on('close', code => (code === 0 ? resolve() : reject(new Error(`drizzle-kit ${command} exited with code ${code}`))));
        drizzleProcess.on('error', reject);
    });
}

/**
 * Helper: Run drizzle command with spinner
 *
 * `databaseUrl` is the command's connection, written into the generated config.
 */
export async function runWithSpinner(
    spinnerText: string,
    command: string,
    successMessage: string,
    failMessage: string,
    databaseUrl: string,
): Promise<void>
{
    const spinner = ora(spinnerText).start();

    try
    {
        spinner.stop();
        await runDrizzleCommand(command, databaseUrl);
        console.log(chalk.green(`✅ ${successMessage}`));
    }
    catch (error)
    {
        spinner.fail(failMessage);
        console.error(chalk.red(error instanceof Error ? error.message : 'Unknown error'));
        process.exit(1);
    }
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
 * `values` less those living in a schema a function package owns, as
 * `withoutFunctionPackageObjects` leaves a module set's exports
 */
export function withoutFunctionPackageValues(values: unknown[], cwd: string = process.cwd()): unknown[]
{
    const owners = functionPackageSchemas(cwd);

    return values.filter(value => !ownerOf(value, owners));
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
 * The temp drizzle config for a project without drizzle.config.ts, with what
 * it hands drizzle-kit: the schema files and the migrations folder
 */
export interface TempConfig
{
    /** The drizzle.config.ts source */
    content: string;
    /** The schema files the config names */
    files: string[];
    /** The config's `out`, relative to the working directory */
    out: string;
}

/**
 * Resolve the temp drizzle config for a project without drizzle.config.ts.
 * drizzle-kit `generate` and `studio` read no schemaFilter, so none is written.
 * `reconcile` loads the entity modules to settle folder versus registry; pass it
 * for a command that reads the schema.
 */
export async function resolveTempConfig(options: { reconcile: boolean; databaseUrl: string }): Promise<TempConfig>
{
    loadEnv();

    const cwd = process.cwd();
    const config = getDrizzleConfig({
        cwd,
        databaseUrl: options.databaseUrl,
        // Exclude package schemas to avoid .ts/.js mixing (packages use migrations instead)
        disablePackageDiscovery: true,
        expandGlobs: true,
    });
    const resolved = await resolveTempConfigSchema(config, cwd, options.reconcile);

    console.log(chalk.dim(`Using auto-generated Drizzle config (schema: ${resolved.source})`));
    if (resolved.note) console.log(chalk.yellow(`ℹ️  ${resolved.note}`));
    console.log();

    return {
        content: renderDrizzleConfig({ ...config, schema: resolved.files }, cwd),
        files: resolved.files,
        out: config.out,
    };
}

/**
 * Build the temp drizzle config's source for a project without drizzle.config.ts
 * (see resolveTempConfig).
 */
export async function generateTempConfig(options: { reconcile: boolean; databaseUrl: string }): Promise<string>
{
    return (await resolveTempConfig(options)).content;
}

/**
 * generateTempConfig, ending the command with the resolver's message instead
 * of a stack when the folder and the registry disagree
 */
export async function generateTempConfigOrExit(options: { reconcile: boolean; databaseUrl: string }): Promise<string>
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
    /** The migrations folder the config names; drizzle-kit writes to `DRIZZLE_KIT_DEFAULT_OUT` when it names none */
    out?: string;
}

/** The migrations folder drizzle-kit writes to for a config that names no `out` */
export const DRIZZLE_KIT_DEFAULT_OUT = 'drizzle';

/** Node's message for a CommonJS-only name read in an ES module. */
const COMMONJS_GLOBAL = /\b(__dirname|__filename|require|module|exports) is not defined in ES module scope/;

/**
 * The error a drizzle.config.ts that cannot be imported stops `db push` and
 * `db tenant` with, `--schema` or not: the file declares what they may touch
 * (its schemaFilter), so without it they have no scope. Names the file, the
 * load error and the remedy; for a CommonJS-only name, that this process reads
 * the file as ESM — drizzle-kit, which `db generate` hands it to, reads it by
 * its own rule. The load error is the config's own text: a URL's credentials
 * in it are blanked (`redactUrls`) before it can reach a terminal or a CI log.
 */
function drizzleConfigError(configPath: string, error: unknown): Error
{
    const message = redactUrls(error instanceof Error ? error.message : String(error));
    const name = COMMONJS_GLOBAL.exec(message)?.[1];
    const remedy = name === undefined
        ? 'Make it load: it declares what db push and db tenant may touch, so they do not run without it'
        : `spfn reads ${configPath} as ESM, as the app's other source (drizzle-kit reads it by its own rule): `
            + `use import.meta.dirname, import.meta.filename and import instead of ${name}`;

    return new Error(`Could not load ${configPath}: ${message}. ${remedy}`, { cause: error });
}

/**
 * Read the `schema`, `schemaFilter` and `out` entries of the project's
 * drizzle.config.ts, the file `db generate` runs against when the project has one. Imported in
 * this process, under the CLI's module hook: as ESM in any app.
 *
 * @returns undefined when there is no drizzle.config.ts or it names no schema
 * @throws the file, the load error and the remedy, when it exists and cannot be loaded
 */
export async function readDrizzleConfigSchema(cwd: string = process.cwd()): Promise<DrizzleConfigSchema | undefined>
{
    const configPath = join(cwd, 'drizzle.config.ts');

    if (!existsSync(configPath)) return undefined;

    assertTypeScriptLoadable(cwd, configPath);

    const mod = await import(pathToFileURL(configPath).href)
        .catch((error: unknown) => Promise.reject(drizzleConfigError(configPath, error)));
    // A CommonJS-compiled config arrives as { default: { default: config } }
    const config = mod.default?.default ?? mod.default;
    const schema = config?.schema;

    if (typeof schema !== 'string' && !Array.isArray(schema)) return undefined;

    // drizzle-kit accepts schemaFilter as a string or an array
    const schemaFilter = typeof config.schemaFilter === 'string' ? [config.schemaFilter] : config.schemaFilter;

    return {
        schema,
        schemaFilter: Array.isArray(schemaFilter) ? schemaFilter : undefined,
        out: typeof config.out === 'string' ? config.out : undefined,
    };
}

/** Schema named by the user, with where it came from; undefined leaves the resolution to core (the folder scan, or the registry). */
export type SchemaSource = DrizzleConfigSchema & { label: string };

/**
 * Pick the schema entry point the way `db generate` does: an explicit --schema,
 * then drizzle.config.ts, then the core default (folder scan, else the registry).
 * --schema replaces the config's files, not the schemaFilter it declares.
 *
 * @throws when drizzle.config.ts exists and cannot be loaded, --schema or not
 */
export async function resolvePushSchemaSource(explicit?: string, cwd: string = process.cwd()): Promise<SchemaSource | undefined>
{
    const fromConfig = await readDrizzleConfigSchema(cwd);

    if (explicit)
    {
        return { schema: explicit, schemaFilter: fromConfig?.schemaFilter, label: '--schema' };
    }

    return fromConfig && { ...fromConfig, label: 'drizzle.config.ts' };
}

/**
 * The files the project's entities are in, as `db push` resolves them:
 * `source`'s (--schema, drizzle.config.ts), else core's default — the
 * entities folder scan, or its registry (`resolveSchemaFiles`).
 *
 * @throws as `resolveSchemaFiles`
 */
export async function resolveProjectSchemaFiles(databaseUrl: string, source: SchemaSource | undefined, cwd: string = process.cwd()): Promise<ResolvedSchema>
{
    return resolveSchemaFiles(getDrizzleConfig({
        cwd,
        databaseUrl,
        schema: source?.schema,
        expandGlobs: true,
        disablePackageDiscovery: true,
    }), cwd);
}

/**
 * The exports of the files `resolved` names, less the objects a function
 * package owns: a registry re-exports one of its tables for a relation, but
 * the package's own migrations create and alter it.
 */
export async function loadProjectEntities(resolved: ResolvedSchema, cwd: string = process.cwd()): Promise<Record<string, unknown>>
{
    return withoutFunctionPackageObjects(resolved.imports ?? await loadSchemaImports(resolved.files), cwd);
}

/** A module's exports less `default` */
const namedExports = (exports: Record<string, unknown>) => Object.fromEntries(Object.entries(exports).filter(([key]) => key !== 'default'));

/**
 * Dynamically import schema files and merge their named exports into a single
 * object (`default` is left out, as push has always left it).
 * Used to build the `imports` parameter for drizzle-kit's `pushSchema()`.
 * Two files exporting one name keep the later file's value; a caller that
 * must see every table loads the modules apart (`loadSchemaModules`).
 */
export async function loadSchemaImports(schemaFiles: string[]): Promise<Record<string, unknown>>
{
    return Object.assign({}, ...(await loadSchemaModules(schemaFiles)).map(namedExports));
}

/**
 * Dynamically import schema files, one record of exports per file, in order,
 * the way drizzle-kit reads them: each file on its own, every top-level export
 * of it, `default` included. drizzle-kit (1.0.0-rc.4, `fromExports`) takes
 * `Object.values` of a module, so a table exported as `default` is in its
 * migration, and one inside an exported object or array is not.
 *
 * A plain `import()`: `bin/spfn.js` starts this process under tsx with the
 * CLI's module hook, so a `.ts` entity loads as ESM whatever the app's
 * `package.json` says, as `spfn dev` and `spfn build` load it. Without tsx a
 * `.ts` file stops the command naming it (`assertTypeScriptLoadable`).
 */
export async function loadSchemaModules(schemaFiles: string[]): Promise<Record<string, unknown>[]>
{
    const modules: Record<string, unknown>[] = [];

    for (const file of schemaFiles)
    {
        assertTypeScriptLoadable(process.cwd(), file);

        const mod = await import(pathToFileURL(file).href);

        modules.push({ ...mod });
    }

    return modules;
}

/**
 * One client for `db push`: a drizzle-orm PgDatabase for pushSchema(), and
 * `query` for raw SQL on the same client.
 */
export interface PushConnection
{
    db: any;
    query: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
    close: () => Promise<void>;
    /** With `readOnly`: `transaction_read_only` as the server reports it inside one of the read-only transactions */
    transactionReadOnly?: string;
}

/** The one method of a pg client that drizzle's node-postgres session and `PushConnection.query` call. */
type Queryable = { query: (...args: any[]) => Promise<any> };

/**
 * Open the push connection on one pg client, not a pool. pushSchema sends
 * each of its queries through `db.execute` and opens no transaction or client
 * of its own.
 *
 * With `readOnly` every query, drizzle's and `query`'s alike, runs in its own
 * `BEGIN READ ONLY` transaction (see readOnlyQueries): PostgreSQL refuses any
 * write, and a lock a statement takes ends with that statement, so a dry run
 * holds no lock between statements. The mode is set by a statement, not a
 * startup parameter, so a pooler cannot drop it; `transactionReadOnly` is read
 * back the same way, and the caller checks it before the plan runs.
 *
 * Uses `pg` (node-postgres) because drizzle-kit's internal adapter expects
 * `execute()` to return `{ rows: [...] }`, which `pg` provides but
 * `postgres.js` does not.
 */
export async function createPushConnection(databaseUrl: string, options: { readOnly?: boolean } = {}): Promise<PushConnection>
{
    const pg = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');

    const client = new pg.default.Client(resolvePushConnectionConfig(databaseUrl));
    await client.connect();

    const queryable: Queryable = options.readOnly ? readOnlyQueries(client) : client;
    const connection: PushConnection = {
        db: drizzle({ client: queryable as typeof client }),
        query: async (text, params) => (await queryable.query(text, params)).rows,
        close: () => client.end(),
    };

    return options.readOnly ? withReadOnlySetting(connection) : connection;
}

/**
 * A `query` that runs each call as `BEGIN READ ONLY`, the call, `ROLLBACK` on
 * `client`. pushSchema issues its queries concurrently, and pg alone would
 * interleave the three statements of different calls, so the calls form a
 * queue: each starts once the one before it has rolled back, whether or not
 * that one failed.
 */
function readOnlyQueries(client: Queryable): Queryable
{
    let previous: Promise<unknown> = Promise.resolve();

    const inReadOnlyTransaction = async (args: unknown[]) =>
    {
        await client.query('BEGIN READ ONLY');
        try
        {
            return await client.query(...args);
        }
        finally
        {
            await client.query('ROLLBACK');
        }
    };

    return {
        query: (...args) =>
        {
            const result = previous.then(() => inReadOnlyTransaction(args));
            previous = result.catch(() => undefined);

            return result;
        },
    };
}

/** Read back, inside one of the read-only transactions, whether the server holds it read-only. */
async function withReadOnlySetting(connection: PushConnection): Promise<PushConnection>
{
    const [{ setting }] = await connection.query(`SELECT current_setting('transaction_read_only') AS setting`);

    return { ...connection, transactionReadOnly: String(setting) };
}
