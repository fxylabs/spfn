/**
 * Codegen Configuration Loader
 *
 * Loads codegen configuration from .spfnrc.ts, .spfnrc.json or package.json
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createJiti } from 'jiti';
import type { Generator } from './generator';
import { pinNodeEnv } from './node-env';
import { logger } from '@spfn/core/logger';

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

/**
 * Load codegen configuration from .spfnrc.ts, .spfnrc.json or package.json
 *
 * Pins `NODE_ENV` to `production` first (`pinNodeEnv`): this is where every
 * CLI generation begins, and `.spfnrc.ts` with what it imports is the first
 * project code a generation evaluates.
 */
export function loadCodegenConfig(cwd: string): CodegenConfig
{
    pinNodeEnv();

    // 1. Check .spfnrc.ts (highest priority)
    const rcTsPath = join(cwd, '.spfnrc.ts');
    if (existsSync(rcTsPath))
    {
        try
        {
            const jiti = createJiti(cwd, {
                interopDefault: true,
                moduleCache: false,
            });

            const module = jiti(rcTsPath);
            const config = module.default || module;

            if (config && typeof config === 'object')
            {
                configLogger.info('Loaded config from .spfnrc.ts');

                return config as CodegenConfig;
            }
        }
        catch (error)
        {
            const err = error instanceof Error ? error : new Error(String(error));
            configLogger.warn('Failed to load .spfnrc.ts', err);
        }
    }

    // 2. Check .spfnrc.json
    const rcPath = join(cwd, '.spfnrc.json');
    if (existsSync(rcPath))
    {
        try
        {
            const content = readFileSync(rcPath, 'utf-8');
            const config = JSON.parse(content);

            if (config.codegen)
            {
                configLogger.info('Loaded config from .spfnrc.json');

                return config.codegen as CodegenConfig;
            }
        }
        catch (error)
        {
            configLogger.warn('Failed to parse .spfnrc.json', error as Error);
        }
    }

    // 3. Check package.json
    const pkgPath = join(cwd, 'package.json');
    if (existsSync(pkgPath))
    {
        try
        {
            const content = readFileSync(pkgPath, 'utf-8');
            const pkg = JSON.parse(content);

            if (pkg.spfn?.codegen)
            {
                configLogger.info('Loaded config from package.json');

                return pkg.spfn.codegen as CodegenConfig;
            }
        }
        catch (error)
        {
            configLogger.warn('Failed to parse package.json', error as Error);
        }
    }

    // 4. Default configuration (empty - no generators by default)
    configLogger.info('Using default config (no generators)');

    return {
        generators: [],
    };
}

/**
 * Load generator from package
 *
 * Supports format: "package:generator-name" or "@scope/package:generator-name"
 */
async function loadGeneratorFromPackage(
    packageName: string,
    generatorName: string,
    config: Record<string, any>,
): Promise<Generator | null>
{
    try
    {
        // Try to load package/generators export using jiti for better module resolution
        const jiti = createJiti(import.meta.url, {
            interopDefault: true,
            moduleCache: false,
        });

        const generatorsModule = jiti(`${packageName}/codegen`);

        // Look for generator by name in registry
        if (generatorsModule.generators?.[generatorName])
        {
            const createFn = generatorsModule.generators[generatorName];
            const generator = createFn(config);
            configLogger.info(`Loaded ${packageName}:${generatorName}`);

            return generator;
        }

        // Fallback: try conventional name (createXxxGenerator)
        const conventionalName = `create${capitalize(generatorName)}Generator`;
        if (generatorsModule[conventionalName])
        {
            const createFn = generatorsModule[conventionalName];
            const generator = createFn(config);
            configLogger.info(`Loaded ${packageName}:${generatorName} (via ${conventionalName})`);

            return generator;
        }

        configLogger.warn(
            `Generator "${generatorName}" not found in ${packageName}/codegen. ` +
            `Expected: generators.${generatorName} or ${conventionalName}`,
        );

        return null;
    }
    catch (error)
    {
        const err = error instanceof Error ? error : new Error(String(error));
        configLogger.warn(
            `Failed to load ${packageName}:${generatorName}. ` +
            `Make sure ${packageName} is installed. Error: ${err.message}`,
        );

        return null;
    }
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string
{
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Create generator instances from configuration
 *
 * Pins `NODE_ENV` to `production` (`pinNodeEnv`) before loading any of them.
 */
export async function createGeneratorsFromConfig(config: CodegenConfig, cwd: string): Promise<Generator[]>
{
    // A caller may hand over a config it built itself; the custom generator
    // modules loaded below are project code all the same.
    pinNodeEnv();

    const generators: Generator[] = [];

    if (!config.generators || config.generators.length === 0)
    {
        return generators;
    }

    for (const generatorConfig of config.generators)
    {
        try
        {
            // Already instantiated Generator (has generate function)
            // This prevents double-loading when users accidentally call factory directly
            if ('generate' in generatorConfig && typeof (generatorConfig as any).generate === 'function')
            {
                generators.push(generatorConfig as Generator);
                configLogger.info(`Generator instance added: ${(generatorConfig as Generator).name}`);
                continue;
            }

            // Custom generator (via file path)
            if ('path' in generatorConfig)
            {
                const generatorPath = generatorConfig.path.startsWith('.')
                    ? join(cwd, generatorConfig.path)
                    : generatorConfig.path;

                configLogger.info(`Loading custom generator: ${generatorPath}`);

                let module: any;

                // Use jiti for .ts files, regular import for .js
                if (generatorPath.endsWith('.ts'))
                {
                    const jiti = createJiti(cwd, {
                        interopDefault: true,
                    });
                    module = jiti(generatorPath);
                }
                else
                {
                    module = await import(generatorPath);
                }

                const createGenerator = module.default || module.createGenerator || module;

                if (typeof createGenerator === 'function')
                {
                    const generator = createGenerator();
                    generators.push(generator);
                    configLogger.info(`Custom generator loaded: ${generator.name}`);
                }
                else
                {
                    configLogger.warn(`Invalid generator at ${generatorPath}: expected function`);
                }
            }
            // Package-based generator: "package:name" or "@scope/package:name"
            else if ('name' in generatorConfig && generatorConfig.name.includes(':'))
            {
                if (generatorConfig.enabled !== false)
                {
                    const [packageName, generatorName] = generatorConfig.name.split(':');
                    const { enabled, name, ...generatorOptions } = generatorConfig;

                    const generator = await loadGeneratorFromPackage(
                        packageName,
                        generatorName,
                        generatorOptions,
                    );

                    if (generator)
                    {
                        generators.push(generator);
                    }
                }
            }
            // Unknown generator name format
            else if ('name' in generatorConfig)
            {
                configLogger.warn(
                    `Invalid generator name "${generatorConfig.name}". ` +
                    `Use package:name format (e.g., "@spfn/core:contract")`,
                );
            }
        }
        catch (error)
        {
            const err = error instanceof Error ? error : new Error(String(error));
            configLogger.error('Failed to load generator', err);
        }
    }

    return generators;
}
