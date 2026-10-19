/**
 * States Generator
 *
 * Generates a file naming the states the app declared — their ids and their
 * manifest — as values a browser root or a server component can execute.
 *
 * `defineStateRouter` declares the states, and the browser reads them through
 * `createStateClient<typeof states>`: a type import, erased at build. So nothing
 * that runs in the browser says which states the app declared, and importing
 * the router to find out is not an option — each state's `read()` closes over
 * repositories and the database. A root that compares the declared ids with the
 * `manifest` of `GET /state` can report a deploy skew between the Next.js server
 * and the API before rendering, instead of a screen meeting `state.<id>` as
 * `undefined`.
 *
 * The router is loaded and walked, as the route map's is. A state router is told
 * apart by the `_stateManifest` marker `defineStateRouter` sets on the router it
 * derives — the object the snapshot route answers as `manifest` — so the ids
 * written here and the manifest the server serves come from one value.
 *
 * @example
 * ```typescript
 * // .spfnrc.ts
 * import { defineConfig, defineGenerator } from '@spfn/core/codegen';
 *
 * export default defineConfig({
 *     generators: [
 *         defineGenerator({
 *             name: '@spfn/core:states',
 *             routerPath: './src/server/router.ts',
 *             outputPath: './src/generated/states.ts',
 *         })
 *     ]
 * });
 * ```
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import type { Router } from '@spfn/core/route';
import { logger } from '@spfn/core/logger';
import type { Generator, GeneratorOptions } from '../core/generator';
import { assertUnconditionalRegistration } from './contract-guard';
import { toObjectKey, toStringLiteral } from './emit';
import { isRouter, loadRouterModule, pinNodeEnv, resolveRouterExport, type ResolvedRouter } from './router-module';

const genLogger = logger.child('@spfn/core:states-generator');

// ============================================================================
// Types
// ============================================================================

export interface StatesGeneratorConfig
{
    /**
     * Generator name (required for package-based loading)
     */
    name: '@spfn/core:states';

    /**
     * Path to the router file (relative to project root) — the one the route map reads
     * @example './src/server/router.ts'
     */
    routerPath: string;

    /**
     * Output path for the generated states file (relative to project root)
     * @default './src/generated/states.ts'
     */
    outputPath?: string;
}

/** Thrown when the router cannot produce the app's declared states. */
export class StatesGeneratorError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'StatesGeneratorError';
    }
}

/** One manifest entry: the state's key fields and whether it has a write. */
interface ManifestEntry
{
    readonly key: readonly string[];
    readonly write: boolean;
}

interface CollectedState
{
    entry: ManifestEntry;

    /** The trail of the state router that declared it, for a collision message. */
    trail: string;
}

// ============================================================================
// Loading
// ============================================================================

const ROUTER_EXPORTS = ['appRouter', 'default', 'router'];

function loadRouter(cwd: string, absoluteRouterPath: string): ResolvedRouter
{
    const module = loadRouterModule({
        cwd,
        absoluteRouterPath,
        subject: 'state manifest',
        fail: message => new StatesGeneratorError(message),
    });

    const resolved = resolveRouterExport(module, ROUTER_EXPORTS);

    if (resolved)
    {
        return resolved;
    }

    throw new StatesGeneratorError(
        `No router found in ${relative(cwd, absoluteRouterPath)}. `
        + `Looked for: ${ROUTER_EXPORTS.join(', ')}. `
        + 'Export the defineRouter() result under one of those names.',
    );
}

// ============================================================================
// Collection
// ============================================================================

/**
 * Walk the router the way the route map's `collectRoutes` walks it: every
 * nested router under `routes`, then every entry of `_packageRouters`, at any
 * depth.
 *
 * `visited` is keyed on the router object, not on the trail: `.packages()`
 * copies a mounted router's own `_packageRouters` up to the top level while
 * leaving them in place below it, so one state router is reachable by two
 * trails and must contribute its states once — a second visit would refuse the
 * router as colliding with itself.
 *
 * A nested route entry is told apart from a router by `isRouter`, as
 * `collectRoutes` does; a `RouteDef` holds no states and is passed over.
 *
 * Returns how many state routers the walk met — counted apart from the states,
 * since `defineStateRouter({})` is a state router declaring none.
 */
function collectStates(
    router: Router<any>,
    trail: string[],
    visited: Set<Router<any>>,
    into: Map<string, CollectedState>,
): number
{
    if (visited.has(router))
    {
        return 0;
    }

    visited.add(router);

    let stateRouters = addStates(router, trail.join('.'), into) ? 1 : 0;

    for (const [name, entry] of Object.entries(router.routes))
    {
        if (isRouter(entry))
        {
            stateRouters += collectStates(entry, [...trail, name], visited, into);
        }
    }

    for (const [index, nested] of (router._packageRouters ?? []).entries())
    {
        stateRouters += collectStates(nested, [...trail, `packages[${index}]`], visited, into);
    }

    return stateRouters;
}

/**
 * The entries of one state router's manifest, in their declaration order.
 * Returns whether the router is a state router — whether it carries its own
 * `_stateManifest`, however many entries that holds.
 */
function addStates(router: Router<any>, trail: string, into: Map<string, CollectedState>): boolean
{
    if (!Object.hasOwn(router, '_stateManifest'))
    {
        return false;
    }

    for (const [id, entry] of Object.entries(router._stateManifest ?? {}))
    {
        const existing = into.get(id);

        if (existing)
        {
            throw new StatesGeneratorError(
                `Two state routers both declare a state "${id}" (${existing.trail} and ${trail}). `
                + 'The browser addresses a state by its id alone and the generated manifest holds one entry per id, '
                + 'so one of the two would be read through the other\'s routes. Rename one of the states, or mount '
                + 'one of the two routers only.',
            );
        }

        into.set(id, { entry, trail });
    }

    return true;
}

/**
 * Every state the router mounts, at any depth, in walk order.
 *
 * Refused only when no router in the walk is a state router: the generator was
 * configured for a state router the app never mounted. A mounted state router
 * declaring no state is an app that has declared none yet, and yields an empty
 * map — the file then names no id, which is what the server serves.
 */
function collectDeclaredStates(router: Router<any>, routerPath: string): Map<string, CollectedState>
{
    const states = new Map<string, CollectedState>();

    if (collectStates(router, ['router'], new Set(), states) === 0)
    {
        throw new StatesGeneratorError(
            `No state router is mounted by ${routerPath}. The @spfn/core:states generator is configured, but nothing `
            + 'it reads mounts a defineStateRouter(...).router, so the file it would write could not say which states '
            + 'the app declared, and every id the server serves would read as a skew. Mount the state router — '
            + '`appRouter.packages([states.router])` — or remove the generator from .spfnrc.ts.',
        );
    }

    return states;
}

// ============================================================================
// Generator
// ============================================================================

/** One `id: { key: [...], write },` line of the manifest. */
function entryLine(id: string, entry: ManifestEntry): string
{
    return `    ${toObjectKey(id)}: { key: [${entry.key.map(toStringLiteral).join(', ')}], write: ${entry.write} },`;
}

/**
 * Generate the states file content
 *
 * No import: the file is read by a browser root and a server component alike,
 * and anything it imported would reach both. The environment is written into
 * the header for the reason the route map writes it — a state router mounted
 * only under one environment is named here only when the generator ran under it.
 */
function generateStatesContent(states: Map<string, CollectedState>, nodeEnv: string): string
{
    const ids = [...states.keys()];

    return [
        '/**',
        ' * State Manifest (Auto-generated)',
        ' *',
        ' * DO NOT EDIT - This file is generated by @spfn/core:states generator',
        ' *',
        ` * Generated with NODE_ENV=${nodeEnv}. A state router mounted only under one environment is`,
        ' * named here only when the generator ran under it, so this line changing is that',
        ' * difference rather than an edit.',
        ' *',
        ' * Compare `stateManifest` with the `manifest` of `GET <state path>` (or of the snapshot a',
        ' * server component read): an id here that the server\'s manifest lacks, or an entry that',
        ' * differs, is a deploy skew between this build and the API.',
        ' */',
        '',
        `export const stateIds = [${ids.map(toStringLiteral).join(', ')}] as const;`,
        '',
        'export type StateId = (typeof stateIds)[number];',
        '',
        'export const stateManifest: Readonly<Record<StateId, { readonly key: readonly string[]; readonly write: boolean }>> = {',
        ...ids.map(id => entryLine(id, states.get(id)!.entry)),
        '};',
        '',
    ].join('\n');
}

/**
 * Create States Generator
 */
export function createStatesGenerator(config: StatesGeneratorConfig): Generator
{
    const { routerPath, outputPath = './src/generated/states.ts' } = config;

    if (!routerPath)
    {
        throw new Error(
            '[@spfn/core:states] Missing required "routerPath" option.\n\n' +
            'Usage:\n' +
            '  defineGenerator<StatesGeneratorConfig>({\n' +
            '    name: \'@spfn/core:states\',\n' +
            '    routerPath: \'./src/server/router.ts\',\n' +
            '  })',
        );
    }

    return {
        name: '@spfn/core:states',

        watchPatterns: [
            routerPath,
            'src/server/states.ts',
            'src/server/states/**/*.ts',
            'src/server/routes/**/*.ts',
        ],

        runOn: ['watch', 'manual', 'build'],

        async generate(options: GeneratorOptions): Promise<void>
        {
            const { cwd, debug } = options;

            const absoluteRouterPath = join(cwd, routerPath);
            const absoluteOutputPath = join(cwd, outputPath);

            if (!existsSync(absoluteRouterPath))
            {
                genLogger.warn(`Router file not found: ${absoluteRouterPath}`);

                return;
            }

            pinNodeEnv();

            // Loaded before the guard reads the source, because which router the
            // guard reads is decided by which export the loader found.
            const { router, exportName } = loadRouter(cwd, absoluteRouterPath);

            assertUnconditionalRegistration({
                routerPath,
                source: readFileSync(absoluteRouterPath, 'utf-8'),
                exportName,
                subject: 'state manifest',
            });

            const states = collectDeclaredStates(router, routerPath);

            if (debug)
            {
                genLogger.info(`Found ${states.size} states`, { ids: [...states.keys()] });
            }

            mkdirSync(dirname(absoluteOutputPath), { recursive: true });

            // Read after `pinNodeEnv`, which is what makes it a value at all when
            // the shell left it unset.
            const nodeEnv = process.env.NODE_ENV ?? 'unset';

            writeFileSync(absoluteOutputPath, generateStatesContent(states, nodeEnv), 'utf-8');

            genLogger.info(`Generated states: ${relative(cwd, absoluteOutputPath)} (${states.size} states)`);
        },
    };
}

// ============================================================================
// Export for package-based loading
// ============================================================================

export default createStatesGenerator;
