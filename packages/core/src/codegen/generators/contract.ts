/**
 * Contract Generator
 *
 * Reads the router, writes `contracts/current.json`, and on a build compares it
 * against the newest released snapshot.
 *
 * It is a codegen plugin for the same reason the route map is one: hanging off
 * `spfn build` and `spfn dev` removes "forgot to regenerate the contract" as a
 * failure mode. On `dev` it only regenerates — refusing a half-finished route
 * mid-edit would make the feature unusable — and on `build` it also gates.
 *
 * @example
 * ```typescript
 * // .spfnrc.ts
 * import { defineConfig, defineGenerator } from '@spfn/core/codegen';
 *
 * export default defineConfig({
 *     generators: [
 *         defineGenerator({
 *             name: '@spfn/core:contract',
 *             routerPath: './src/server/router.ts',
 *             outputDir: './contracts',
 *         })
 *     ]
 * });
 * ```
 */

import { existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { logger } from '@spfn/core/logger';
import {
    checkContract,
    collectContractDocument,
    formatViolations,
    writeCurrentDocument,
} from '@spfn/core/contract';
import type { Generator, GeneratorOptions } from '../core/generator';
import { assertUnconditionalRegistration } from './contract-guard';
import { loadRouterModule, pinNodeEnv, resolveRouterExport, type ResolvedRouter } from './router-module';

const genLogger = logger.child('@spfn/core:contract-generator');

export interface ContractGeneratorConfig
{
    /**
     * Generator name (required for package-based loading)
     */
    name: '@spfn/core:contract';

    /**
     * Path to the router file (relative to project root)
     * @example './src/server/router.ts'
     */
    routerPath: string;

    /**
     * Named export holding the router.
     * @default 'appRouter', falling back to the default export
     */
    routerExport?: string;

    /**
     * Directory holding current.json, released/ and usage/ (relative to project root)
     * @default './contracts'
     */
    outputDir?: string;

    /**
     * Extra file patterns to watch, for routes outside src/server/routes
     */
    additionalRouteDirs?: string[];
}

/** Thrown when the build must stop. */
export class ContractGeneratorError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'ContractGeneratorError';
    }
}

function loadRouter(cwd: string, absoluteRouterPath: string, routerExport?: string): ResolvedRouter
{
    const module = loadRouterModule({
        cwd,
        absoluteRouterPath,
        subject: 'contract',
        fail: message => new ContractGeneratorError(message),
    });

    const candidates = routerExport
        ? [routerExport]
        : ['appRouter', 'default', 'router'];

    const resolved = resolveRouterExport(module, candidates);

    if (resolved)
    {
        return resolved;
    }

    throw new ContractGeneratorError(
        `No router found in ${relative(cwd, absoluteRouterPath)}. `
        + `Looked for: ${candidates.join(', ')}. `
        + 'Set "routerExport" to the export holding the defineRouter() result.',
    );
}

export function createContractGenerator(config: ContractGeneratorConfig): Generator
{
    const {
        routerPath,
        routerExport,
        outputDir = './contracts',
        additionalRouteDirs = [],
    } = config;

    if (!routerPath)
    {
        throw new Error(
            '[@spfn/core:contract] Missing required "routerPath" option.\n\n'
            + 'Usage:\n'
            + '  defineGenerator<ContractGeneratorConfig>({\n'
            + '    name: \'@spfn/core:contract\',\n'
            + '    routerPath: \'./src/server/router.ts\',\n'
            + '  })',
        );
    }

    return {
        name: '@spfn/core:contract',

        watchPatterns: [
            routerPath,
            'src/server/routes/**/*.ts',
            ...additionalRouteDirs.map(dir => `${dir}/**/*.ts`),
        ],

        runOn: ['watch', 'build', 'manual'],

        async generate(options: GeneratorOptions): Promise<void>
        {
            const { cwd } = options;
            const absoluteRouterPath = join(cwd, routerPath);
            const contractsDir = join(cwd, outputDir);

            if (!existsSync(absoluteRouterPath))
            {
                throw new ContractGeneratorError(
                    `Router file not found: ${routerPath}. `
                    + 'The contract generator is configured but has nothing to read.',
                );
            }

            pinNodeEnv();

            // Loaded before the guard reads the source, because which router the
            // guard reads is decided by which export the loader found.
            const { router, exportName } = loadRouter(cwd, absoluteRouterPath, routerExport);

            assertUnconditionalRegistration({
                routerPath,
                source: readFileSync(absoluteRouterPath, 'utf-8'),
                exportName,
                subject: 'contract',
            });

            const document = collectContractDocument(router);

            const changed = writeCurrentDocument(contractsDir, document);
            genLogger.info(
                `${changed ? 'Wrote' : 'Verified'} ${relative(cwd, join(contractsDir, 'current.json'))} `
                + `(${document.operations.length} contracted operation(s))`,
            );

            if (options.trigger?.type !== 'build')
            {
                return;
            }

            const result = checkContract(contractsDir, document);

            for (const warning of result.warnings)
            {
                genLogger.warn(warning);
            }

            if (result.violations.length === 0)
            {
                if (result.baselineVersion)
                {
                    genLogger.info(`Contract is backward compatible with released ${result.baselineVersion}`);
                }

                return;
            }

            throw new ContractGeneratorError(
                `This build breaks the contract released as ${result.baselineVersion}:\n\n`
                + `${formatViolations(result.violations)}\n\n`
                + 'A released client cannot be fixed by redeploying the server. Keep the promise, or cut a new '
                + 'contract version and let the old operation stay until no released app calls it.',
            );
        },
    };
}

export default createContractGenerator;
