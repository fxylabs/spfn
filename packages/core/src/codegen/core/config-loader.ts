/**
 * Codegen Configuration Loader
 *
 * Loads codegen configuration from .spfnrc.ts, .spfnrc.json or package.json
 */

import { existsSync, readFileSync, realpathSync } from 'fs';
import { join, relative } from 'path';
import type { Generator } from './generator';
import { pinNodeEnv } from './node-env';
import { logger } from '@spfn/core/logger';
import { projectOrigin } from '../loader/errors';
import { importPackageModule, importProjectModule, newGeneration, requireProjectModule, resolvePackageModule } from '../loader/register';

const configLogger = logger.child('@spfn/core:codegen-config');

/**
 * Custom generator via file path
 */
type CustomGeneratorByPath = { path: string };

/**
 * Package-based generator configuration
 */
type PackageGeneratorDef = { name: string; enabled?: boolean } & Record<string, any>;

/**
 * Any generator configuration
 */
export type GeneratorConfig = CustomGeneratorByPath | PackageGeneratorDef;

/**
 * Codegen configuration
 */
export interface CodegenConfig
{
    generators?: GeneratorConfig[];
}

/**
 * Define a generator with type safety
 *
 * @example
 * Custom generator with type parameter:
 * ```ts
 * import { defineGenerator } from '@spfn/core/codegen';
 * import type { MyGeneratorConfig } from 'my-package';
 *
 * const customGen = defineGenerator<MyGeneratorConfig>({
 *   name: 'my-package:generator',
 *   myOption: 'value',
 * });
 * ```
 */
export function defineGenerator<T extends Record<string, any>>(config: T): T;
export function defineGenerator(config: PackageGeneratorDef): PackageGeneratorDef;
export function defineGenerator(config: CustomGeneratorByPath): CustomGeneratorByPath;
export function defineGenerator<T extends Record<string, any>>(config: T): T
{
    return config;
}

/**
 * Helper function to define codegen configuration with type safety
 *
 * @example
 * With custom generator:
 * ```ts
 * import { defineConfig, defineGenerator } from '@spfn/core/codegen';
 * import type { MyGeneratorConfig } from 'my-package';
 *
 * const customGen = defineGenerator<MyGeneratorConfig>({
 *   name: 'my-package:custom',
 *   myOption: 'value',  // Type-safe!
 * });
 *
 * export default defineConfig({
 *   generators: [customGen]
 * });
 * ```
 */
export function defineConfig(config: CodegenConfig): CodegenConfig
{
    return config;
}

/** What a synchronous step returned, or what it threw. */
function attempt<T>(step: () => T): { ok: true; value: T } | { ok: false; error: unknown }
{
    try
    {
        return { ok: true, value: step() };
    }
    catch (error)
    {
        return { ok: false, error };
    }
}

/** What a CommonJS habit in an ES module throws: `__dirname is not defined in ES module scope`. */
const COMMONJS_GLOBAL = /\b(__dirname|__filename|require|module|exports) is not defined/;

/**
 * A config file that exists and could not be read: an error, never "no
 * generators", which would let a CI build skip codegen and pass.
 */
function configFailure(cwd: string, name: string, error: unknown): Error
{
    const message = error instanceof Error ? error.message : String(error);
    const origin = projectOrigin(error, realpathSync(cwd));
    const where = origin === undefined || origin === name ? '' : ` (at ${origin})`;
    const hint = COMMONJS_GLOBAL.test(message)
        ? `\n\n${name} is an ES module: use import.meta.dirname and import.meta.filename for __dirname and `
            + '__filename, import for require, and export for module.exports.'
        : '';

    return Object.assign(new Error(`Failed to load ${name}${where}: ${message}${hint}`), { cause: error });
}

/** `.spfnrc.ts`, or undefined when there is none or it exports no object. */
function configFromRcTs(cwd: string): CodegenConfig | undefined
{
    const rcTsPath = join(cwd, '.spfnrc.ts');

    if (!existsSync(rcTsPath))
    {
        return undefined;
    }

    const loaded = attempt(() => requireProjectModule(rcTsPath, cwd));

    if (!loaded.ok)
    {
        throw configFailure(cwd, '.spfnrc.ts', loaded.error);
    }

    const config = loaded.value.default || loaded.value;

    if (!config || typeof config !== 'object')
    {
        return undefined;
    }

    configLogger.info('Loaded config from .spfnrc.ts');

    return config as CodegenConfig;
}

/** The config `select` finds in the JSON file `name`, or undefined when the file or the config is absent. */
function configFromJson(cwd: string, name: string, select: (json: any) => unknown): CodegenConfig | undefined
{
    const path = join(cwd, name);

    if (!existsSync(path))
    {
        return undefined;
    }

    const parsed = attempt(() => JSON.parse(readFileSync(path, 'utf-8')));

    if (!parsed.ok)
    {
        throw configFailure(cwd, name, parsed.error);
    }

    const config = select(parsed.value);

    if (!config)
    {
        return undefined;
    }

    configLogger.info(`Loaded config from ${name}`);

    return config as CodegenConfig;
}

/**
 * Load codegen configuration from .spfnrc.ts, .spfnrc.json or package.json
 *
 * Pins `NODE_ENV` to `production` first (`pinNodeEnv`): this is where every
 * CLI generation begins, and `.spfnrc.ts` with what it imports is the first
 * project code a generation evaluates.
 *
 * Synchronous, as `.spfn/watcher.mjs` entries written by older CLIs call it:
 * `.spfnrc.ts` is `require()`d as an ES module through the codegen loader, so
 * the `@spfn/core/codegen` it imports is this process's own. A `.spfnrc.ts`
 * whose imports use top-level await cannot be required, and is reported as
 * failing to load.
 *
 * A config file that exists and fails to load — a `.spfnrc.ts` that throws or
 * does not compile, a `.spfnrc.json` or `package.json` that is not JSON —
 * throws, naming the file and where it failed. Only when none of the three
 * declares a config is the default (no generators) returned.
 */
export function loadCodegenConfig(cwd: string): CodegenConfig
{
    pinNodeEnv();

    const config = configFromRcTs(cwd)
        ?? configFromJson(cwd, '.spfnrc.json', json => json.codegen)
        ?? configFromJson(cwd, 'package.json', json => json.spfn?.codegen);

    if (config !== undefined)
    {
        return config;
    }

    configLogger.info('Using default config (no generators)');

    return {
        generators: [],
    };
}

/**
 * A package generator, `<package>:<generator>`: the factory `<package>/codegen`
 * exports for it, called with the entry's options.
 *
 * `<package>/codegen` is imported natively, resolved from the project root (and
 * from this package when the project cannot resolve it): for `@spfn/core` that
 * is the module this process already imported, so the generator that runs is
 * this process's own. A generator the config names and that cannot be produced
 * — not found, a module that throws, a factory that throws — fails the
 * configuration, with the reason.
 */
async function loadGeneratorFromPackage(
    packageName: string,
    generatorName: string,
    config: Record<string, any>,
    cwd: string,
): Promise<Generator>
{
    const name = `${packageName}:${generatorName}`;
    const specifier = `${packageName}/codegen`;
    const file = resolvePackageModule(specifier, cwd);

    if (file === undefined)
    {
        throw new Error(
            `Cannot load generator "${name}": "${specifier}" resolves neither from the project (${cwd}) nor from `
            + '@spfn/core. A package generator is named "<package>:<generator>" and its factory is loaded from '
            + `"<package>/codegen": is ${packageName} installed, and does it export "./codegen"?`,
        );
    }

    const loaded = await importPackageModule(file).then(
        module => ({ ok: true as const, module }),
        (error: unknown) => ({ ok: false as const, error }),
    );

    if (!loaded.ok)
    {
        throw configFailure(cwd, `generator ${name} from ${relative(cwd, file)}`, loaded.error);
    }

    const factory = packageFactory(name, generatorName, loaded.module);
    const created = attempt(() => factory(config) as Generator);

    if (!created.ok)
    {
        throw configFailure(cwd, `generator ${name}`, created.error);
    }

    configLogger.info(`Loaded ${name}`);

    return created.value;
}

/**
 * The factory `<package>/codegen` exports for `generatorName`: in its
 * `generators` registry, or by the conventional name (`createXxxGenerator`).
 */
function packageFactory(name: string, generatorName: string, module: Record<string, any>): (config: Record<string, any>) => unknown
{
    const conventionalName = `create${capitalize(generatorName)}Generator`;
    const factory = module.generators?.[generatorName] ?? module[conventionalName];

    if (typeof factory !== 'function')
    {
        const known = Object.keys(module.generators ?? {});

        throw new Error(
            `Cannot load generator "${name}": its package's codegen module exports neither `
            + `generators["${generatorName}"] nor ${conventionalName}.`
            + (known.length > 0 ? ` Its generators are: ${known.join(', ')}.` : ''),
        );
    }

    return factory;
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string
{
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * A custom generator's module, through the codegen loader like the router:
 * TypeScript and the project's aliases resolve, and what it imports of
 * `@spfn/*` is this process's own. A module that fails to load throws, naming
 * where, as a failing `.spfnrc.ts` does: a configured generator is not skipped.
 */
async function importCustomGenerator(generatorPath: string, cwd: string): Promise<Record<string, unknown>>
{
    const load = await importProjectModule(generatorPath, cwd, newGeneration());

    if (!load.ok)
    {
        throw configFailure(cwd, relative(cwd, generatorPath), load.error);
    }

    return load.module;
}

/** A custom generator from its file's factory; a file that exports none fails the configuration. */
async function loadCustomGenerator(path: string, cwd: string): Promise<Generator>
{
    const generatorPath = path.startsWith('.') ? join(cwd, path) : path;

    configLogger.info(`Loading custom generator: ${generatorPath}`);

    const module: any = await importCustomGenerator(generatorPath, cwd);
    const createGenerator = module.default || module.createGenerator || module;

    if (typeof createGenerator !== 'function')
    {
        throw new Error(`Cannot load generator ${relative(cwd, generatorPath)}: it exports no factory (a default export or createGenerator).`);
    }

    const generator = createGenerator();

    configLogger.info(`Custom generator loaded: ${generator.name}`);

    return generator;
}

/** The generator one config entry stands for, or null for one disabled (`enabled: false`). */
async function generatorFor(generatorConfig: GeneratorConfig, cwd: string): Promise<Generator | null>
{
    // Already instantiated Generator (has generate function)
    // This prevents double-loading when users accidentally call factory directly
    if ('generate' in generatorConfig && typeof (generatorConfig as any).generate === 'function')
    {
        configLogger.info(`Generator instance added: ${(generatorConfig as Generator).name}`);

        return generatorConfig as Generator;
    }

    if ('path' in generatorConfig)
    {
        return loadCustomGenerator(generatorConfig.path, cwd);
    }

    if (typeof generatorConfig.name !== 'string' || !generatorConfig.name.includes(':'))
    {
        throw new Error(
            `Invalid codegen generator entry ${JSON.stringify(generatorConfig)}: name a package generator as `
            + '"<package>:<generator>" (e.g. "@spfn/core:contract"), or a generator file with "path".',
        );
    }

    if (generatorConfig.enabled === false)
    {
        return null;
    }

    // Package-based generator: "package:name" or "@scope/package:name"
    const [packageName, generatorName] = generatorConfig.name.split(':');
    const { enabled, name, ...generatorOptions } = generatorConfig;

    return loadGeneratorFromPackage(packageName, generatorName, generatorOptions, cwd);
}

/**
 * Create generator instances from configuration
 *
 * Pins `NODE_ENV` to `production` (`pinNodeEnv`) before loading any of them.
 * Every generator the config names loads or throws, with the reason: a package
 * or generator not found (where it was looked for), a module or factory that
 * throws (its error, located as a failed load is), an entry that names none.
 * Only an entry with `enabled: false` is skipped, and only a config naming no
 * generator yields none.
 */
export async function createGeneratorsFromConfig(config: CodegenConfig, cwd: string): Promise<Generator[]>
{
    // A caller may hand over a config it built itself; the custom generator
    // modules loaded below are project code all the same.
    pinNodeEnv();

    const generators: Generator[] = [];

    for (const generatorConfig of config.generators ?? [])
    {
        const generator = await generatorFor(generatorConfig, cwd);

        if (generator)
        {
            generators.push(generator);
        }
    }

    return generators;
}
