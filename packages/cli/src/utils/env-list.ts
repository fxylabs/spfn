/**
 * The whole-app env list — every variable an app reads, from every schema it has.
 *
 * `spfn env` and `spfn secret` read this list when no `-p <package>` is given.
 * It is built from two kinds of source:
 *
 * - the app's own schema modules, named in `spfn.config.js` under
 *   `env.schemas` (paths relative to the project root), and
 * - every installed `@spfn/*` package whose `./config` exports `envSchema`,
 *   discovered from the app's `package.json` and resolved from the project root.
 *
 * A key declared by more than one source becomes one entry. Two declarations
 * that disagree on the shape of the value cannot both be right, so that is an
 * error naming the key and both sources.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAppConfig } from '@spfn/core/app-config';
import { loadEnvSchema, resolveFrom, type EnvSchema, type EnvSchemaEntry } from './env-schema.js';

/** One schema and the name it is reported under. */
export interface EnvSource
{
    /** A package name, or the path an app schema was loaded from. */
    name: string;
    schema: EnvSchema;
}

export interface EnvList
{
    /** Every schema as loaded — the app's own first, then packages. */
    sources: EnvSource[];

    /** One entry per key, merged across sources. */
    schema: EnvSchema;

    /** The sources declaring each key, in list order. */
    declaredBy: Record<string, string[]>;

    /** Keys two sources declare with different `required`/`sensitive`. */
    notices: string[];
}

/** A slice of the list: the keys first declared by one source. */
export interface EnvSourceGroup
{
    source: string;
    entries: EnvSchemaEntry[];
}

/** `@spfn/core` leads the package part of the list; the rest follow by name. */
const CORE_PACKAGE = '@spfn/core';

const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;

/**
 * Build the list: one package with `-p`, the whole app without it.
 */
export async function loadEnvList(
    options: { package?: string },
    cwd: string = process.cwd(),
): Promise<EnvList>
{
    if (options.package)
    {
        return mergeEnvSources([{ name: options.package, schema: await loadEnvSchema(options.package, cwd) }]);
    }

    return mergeEnvSources([
        ...await loadAppSchemas(cwd),
        ...await loadPackageSchemas(cwd),
    ]);
}

/**
 * Merge sources into one entry per key.
 *
 * Declarations of a key agree when their `type`, `required` and `sensitive`
 * match; `url` and `string` count as the same type, since both hold a string.
 * A differing `type` is an error. A differing `required` or `sensitive` keeps
 * the stricter value and leaves a notice: every package enforces its own
 * declaration at runtime, so the app needs the value as soon as one of them
 * requires it, and must guard it as soon as one of them calls it a secret.
 *
 * @throws Error listing every key whose declarations disagree on `type`
 */
export function mergeEnvSources(sources: EnvSource[]): EnvList
{
    const schema: EnvSchema = {};
    const declaredBy: Record<string, string[]> = {};
    const notices: string[] = [];
    const conflicts: string[] = [];

    for (const source of sources)
    {
        for (const [key, entry] of Object.entries(source.schema))
        {
            const existing = schema[key];
            const owners = declaredBy[key] ?? [];

            declaredBy[key] = [...owners, source.name];

            if (!existing)
            {
                schema[key] = { ...entry, key };
                continue;
            }

            if (valueShape(existing.type) !== valueShape(entry.type))
            {
                conflicts.push(`${key}: ${owners.join(', ')} declares "${existing.type}", ${source.name} declares "${entry.type}"`);
                continue;
            }

            if (!!existing.required !== !!entry.required || !!existing.sensitive !== !!entry.sensitive)
            {
                notices.push(describeDisagreement(key, existing, owners, entry, source.name));
                schema[key] = {
                    ...existing,
                    required: !!existing.required || !!entry.required,
                    sensitive: !!existing.sensitive || !!entry.sensitive,
                };
            }
        }
    }

    if (conflicts.length > 0)
    {
        throw new Error(`Env schemas disagree on the type of a variable:\n  - ${conflicts.join('\n  - ')}`);
    }

    return { sources, schema, declaredBy, notices };
}

/**
 * The list sliced by source, each key under the first source declaring it.
 */
export function groupBySource(list: EnvList, entries: EnvSchemaEntry[] = Object.values(list.schema)): EnvSourceGroup[]
{
    return list.sources
        .map((source) => ({
            source: source.name,
            entries: entries.filter((entry) => list.declaredBy[entry.key]?.[0] === source.name),
        }))
        .filter((group) => group.entries.length > 0);
}

/**
 * The sources other than the first that declare a key — shown as "also in".
 */
export function alsoDeclaredBy(list: EnvList, key: string): string[]
{
    return (list.declaredBy[key] ?? []).slice(1);
}

/**
 * What a command's heading calls the list.
 */
export function describeEnvList(options: { package?: string }): string
{
    return options.package ?? 'whole app';
}

function valueShape(type: EnvSchemaEntry['type']): string
{
    return type === 'url' ? 'string' : type;
}

function describeDisagreement(
    key: string,
    existing: EnvSchemaEntry,
    owners: string[],
    entry: EnvSchemaEntry,
    source: string,
): string
{
    const flags = (value: EnvSchemaEntry) =>
        `${value.required ? 'required' : 'optional'}${value.sensitive ? ', sensitive' : ''}`;

    return `${key} is ${flags(existing)} in ${owners.join(', ')} but ${flags(entry)} in ${source}; `
        + 'the list uses the stricter of each.';
}

// ============================================================================
// The app's own schemas (spfn.config.js → env.schemas)
// ============================================================================

/**
 * Load every module `spfn.config.js` names under `env.schemas`.
 *
 * An app without the setting gets an empty list and never pays for a
 * TypeScript loader.
 */
export async function loadAppSchemas(cwd: string): Promise<EnvSource[]>
{
    const paths = (await loadAppConfig(cwd)).env?.schemas ?? [];

    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string'))
    {
        throw new Error('spfn.config.js: env.schemas must be an array of paths relative to the project root.');
    }

    const sources: EnvSource[] = [];

    for (const path of paths)
    {
        sources.push({ name: path, schema: await loadSchemaModule(cwd, path) });
    }

    return sources;
}

/**
 * Import one app schema module and take its `envSchema` export.
 */
async function loadSchemaModule(cwd: string, path: string): Promise<EnvSchema>
{
    const fullPath = resolve(cwd, path);

    if (!existsSync(fullPath))
    {
        throw new Error(`spfn.config.js env.schemas: ${path} does not exist.`);
    }

    const module = await importAppModule(cwd, fullPath).catch((error: unknown) =>
    {
        const message = error instanceof Error ? error.message : String(error);

        return Promise.reject(new Error(`spfn.config.js env.schemas: ${path} could not be loaded: ${message}`));
    });

    if (!module.envSchema)
    {
        throw new Error(`spfn.config.js env.schemas: ${path} does not export envSchema.`);
    }

    return module.envSchema as EnvSchema;
}

/**
 * Import a file of the app the way `spfn dev` and `spfn provision` run it:
 * through tsx, with the app's tsconfig, so TypeScript and path aliases such as
 * `@/server/...` resolve. A plain JavaScript module still loads when the app
 * has no tsx.
 */
async function importAppModule(cwd: string, fullPath: string): Promise<Record<string, unknown>>
{
    const url = pathToFileURL(fullPath).href;
    const tsx = await loadTsx(cwd);

    if (tsx)
    {
        const tsconfig = join(cwd, 'tsconfig.json');

        return await tsx.tsImport(url, {
            parentURL: pathToFileURL(join(cwd, 'noop.js')).href,
            tsconfig: existsSync(tsconfig) ? tsconfig : false,
        });
    }

    if (TYPESCRIPT_FILE.test(fullPath))
    {
        throw new Error('tsx is not installed in this project, and it is what loads TypeScript. Add it: pnpm add -D tsx');
    }

    return await import(url);
}

interface TsxApi
{
    tsImport(specifier: string, options: { parentURL: string; tsconfig?: string | false }): Promise<Record<string, unknown>>;
}

/**
 * tsx's import API — the app's own copy first, then the one next to the CLI.
 */
async function loadTsx(cwd: string): Promise<TsxApi | undefined>
{
    const path = resolveFrom(join(cwd, 'noop.js'), 'tsx/esm/api')
        ?? resolveFrom(import.meta.url, 'tsx/esm/api');

    return path ? await import(pathToFileURL(path).href) as TsxApi : undefined;
}

// ============================================================================
// Installed @spfn/* packages
// ============================================================================

/**
 * Every `@spfn/*` dependency of the app whose `./config` exports `envSchema`.
 *
 * A package without a `./config` entry, or whose config has no `envSchema`,
 * is not an env source and is passed over. A config that exists and fails to
 * import is an error, not an absence.
 */
export async function loadPackageSchemas(cwd: string): Promise<EnvSource[]>
{
    const sources: EnvSource[] = [];

    for (const name of readSpfnDependencies(cwd))
    {
        const path = resolveFrom(join(cwd, 'noop.js'), `${name}/config`);
        const module = path ? await importPackageConfig(name, path) : undefined;

        if (module?.envSchema)
        {
            sources.push({ name, schema: module.envSchema as EnvSchema });
        }
    }

    return sources;
}

async function importPackageConfig(name: string, path: string): Promise<Record<string, unknown>>
{
    return await import(pathToFileURL(path).href).catch((error: unknown) =>
    {
        const message = error instanceof Error ? error.message : String(error);

        return Promise.reject(new Error(`Failed to load package ${name}: ${message}`));
    });
}

/**
 * `@spfn/*` names from the app's dependencies and devDependencies, core first.
 */
function readSpfnDependencies(cwd: string): string[]
{
    const packageJsonPath = join(cwd, 'package.json');

    if (!existsSync(packageJsonPath))
    {
        return [];
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const names = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
        .filter((name) => name.startsWith('@spfn/'))
        .sort();

    return names.includes(CORE_PACKAGE)
        ? [CORE_PACKAGE, ...names.filter((name) => name !== CORE_PACKAGE)]
        : names;
}
