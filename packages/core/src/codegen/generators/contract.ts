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
 *             eventRouterPath: './src/server/events.ts',   // optional: contracted SSE events
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
import type { EventRouterDef } from '@spfn/core/event';
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
     * Path to the file exporting the `defineEventRouter()` result (relative to
     * project root). When set, its contracted events are written into the
     * document's `events` section; unset, the document has none.
     * @example './src/server/events.ts'
     */
    eventRouterPath?: string;

    /**
     * Named export holding the event router.
     * @default 'eventRouter', falling back to the default export
     */
    eventRouterExport?: string;

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

function isEventRouter(value: unknown): value is EventRouterDef<any>
{
    return value !== null
        && typeof value === 'object'
        && 'events' in value
        && 'eventNames' in value;
}

interface ResolvedEventRouter
{
    eventRouter: EventRouterDef<any>;

    /** The export it was found under, which the registration guard reads. */
    exportName: string;
}

/**
 * Load the event router through the same loader as the route router: the same
 * `NODE_ENV` pin, the same tsconfig aliases.
 */
function loadEventRouter(cwd: string, absolutePath: string, eventRouterExport?: string): ResolvedEventRouter
{
    const module = loadRouterModule({
        cwd,
        absoluteRouterPath: absolutePath,
        subject: 'contract',
        fail: message => new ContractGeneratorError(message),
    });

    const candidates = eventRouterExport ? [eventRouterExport] : ['eventRouter', 'default'];
    const exportName = candidates.find(candidate => isEventRouter(module[candidate]));

    if (exportName)
    {
        return { eventRouter: module[exportName] as EventRouterDef<any>, exportName };
    }

    throw new ContractGeneratorError(
        `No event router found in ${relative(cwd, absolutePath)}. `
        + `Looked for: ${candidates.join(', ')}. `
        + 'Set "eventRouterExport" to the export holding the defineEventRouter() result.',
    );
}

/**
 * The event router `eventRouterPath` names, or `undefined` when it is unset.
 *
 * Its source is scanned like the route router's: an event registered behind a
 * flag would make the published event set depend on how the generator ran.
 */
function readEventRouter(cwd: string, eventRouterPath?: string, eventRouterExport?: string): EventRouterDef<any> | undefined
{
    if (!eventRouterPath)
    {
        return undefined;
    }

    const absolutePath = join(cwd, eventRouterPath);

    if (!existsSync(absolutePath))
    {
        throw new ContractGeneratorError(
            `Event router file not found: ${eventRouterPath}. `
            + 'The contract generator is configured with "eventRouterPath" but has nothing to read there.',
        );
    }

    const { eventRouter, exportName } = loadEventRouter(cwd, absolutePath, eventRouterExport);

    assertUnconditionalRegistration({
        routerPath: eventRouterPath,
        source: readFileSync(absolutePath, 'utf-8'),
        exportName,
        subject: 'contract',
        factory: 'defineEventRouter',
    });

    return eventRouter;
}

export function createContractGenerator(config: ContractGeneratorConfig): Generator
{
    const {
        routerPath,
        routerExport,
        eventRouterPath,
        eventRouterExport,
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
            ...(eventRouterPath ? [eventRouterPath] : []),
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

            const document = collectContractDocument(router, readEventRouter(cwd, eventRouterPath, eventRouterExport));

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
