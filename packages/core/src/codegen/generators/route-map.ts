/**
 * Route Map Generator
 *
 * Generates a route map file containing routeName → {method, path} mappings.
 * This allows RPC proxy to resolve routes without importing the full router.
 *
 * The router is loaded and walked, not parsed from source. A source parser sees
 * the spelling rather than the router: `defineRouter({ createUser })` written on
 * one line, an aliased key `create: createUser`, and a nested router assembled by
 * a second `defineRouter(` in the same file are all ordinary ways to write a
 * router, and all of them used to leave routes out of the map. The RPC client
 * addresses a route by name, so a dropped name is a route that typechecks and
 * 404s. Walking the loaded router registers exactly what `registerRoutes`
 * registers, whatever the source looks like.
 *
 * @example
 * ```typescript
 * // .spfnrc.ts
 * import { defineConfig, defineGenerator } from '@spfn/core/codegen';
 *
 * export default defineConfig({
 *     generators: [
 *         defineGenerator({
 *             name: '@spfn/core:route-map',
 *             routerPath: './src/server/router.ts',
 *             outputPath: './src/generated/route-map.ts',
 *         })
 *     ]
 * });
 * ```
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
import { createJiti } from 'jiti';
import type { RouteDef, Router } from '@spfn/core/route';
import { logger } from '@spfn/core/logger';
import type { Generator, GeneratorOptions } from '../core/generator';

const genLogger = logger.child('@spfn/core:route-map-generator');

// ============================================================================
// Types
// ============================================================================

export interface RouteMapGeneratorConfig
{
    /**
     * Generator name (required for package-based loading)
     */
    name: '@spfn/core:route-map';

    /**
     * Path to the router file (relative to project root)
     * @example './src/server/router.ts'
     */
    routerPath: string;

    /**
     * Output path for generated route map (relative to project root)
     * @default './src/generated/route-map.ts'
     */
    outputPath?: string;

    /**
     * Extra file patterns to watch, for routes outside src/server/routes
     *
     * @deprecated Ignored. The map is read from the loaded router, which reaches
     * every route through its own imports wherever they live, so there is no
     * longer a set of directories to scan. Still accepted so an existing
     * `.spfnrc.ts` keeps working; the watch patterns it produced are unchanged.
     */
    additionalRouteDirs?: string[];
}

/** Thrown when the router cannot produce a route map at all. */
export class RouteMapGeneratorError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = 'RouteMapGeneratorError';
    }
}

interface CollectedRoute
{
    method: string;
    path: string;

    /** Where the route was found, for a collision message. */
    trail: string;
}

// ============================================================================
// Loading
// ============================================================================

function isRouter(value: unknown): value is Router<any>
{
    return value !== null
        && typeof value === 'object'
        && 'routes' in value
        && '_routes' in value;
}

function isRouteDef(value: unknown): value is RouteDef<any>
{
    return value !== null
        && typeof value === 'object'
        && 'handler' in value;
}

function loadRouter(cwd: string, absoluteRouterPath: string): Router<any>
{
    let module: Record<string, unknown>;

    try
    {
        const jiti = createJiti(cwd, { interopDefault: true, moduleCache: false });
        module = jiti(absoluteRouterPath) as Record<string, unknown>;
    }
    catch (error)
    {
        const message = error instanceof Error ? error.message : String(error);

        throw new RouteMapGeneratorError(
            `Failed to load ${relative(cwd, absoluteRouterPath)}: ${message}\n\n`
            + 'The route map is read from the loaded router, so a route module must be importable without side '
            + 'effects. Check that nothing at module scope opens a connection or reads a missing environment value.',
        );
    }

    const candidates = ['appRouter', 'default', 'router'];

    for (const name of candidates)
    {
        const candidate = module[name];

        if (isRouter(candidate))
        {
            return candidate;
        }
    }

    throw new RouteMapGeneratorError(
        `No router found in ${relative(cwd, absoluteRouterPath)}. `
        + `Looked for: ${candidates.join(', ')}. `
        + 'Export the defineRouter() result under one of those names.',
    );
}

// ============================================================================
// Collection
// ============================================================================

function addRoute(name: string, routeDef: RouteDef<any>, trail: string[], found: Map<string, CollectedRoute>): void
{
    const where = trail.join('.');

    if (!routeDef.method || !routeDef.path)
    {
        throw new RouteMapGeneratorError(
            `Route "${where}" has no method or path. `
            + 'The RPC client resolves a name to a method and a path, so both are required. '
            + 'A route reaches this state by being registered before .handler() was called — '
            + 'the server drops it too, which is why the map refuses to name it.',
        );
    }

    const existing = found.get(name);
    if (existing)
    {
        throw new RouteMapGeneratorError(
            `Two routes are both named "${name}" (${existing.trail} and ${where}). `
            + 'The RPC client addresses a route by its name alone, and a nested route registers under its own '
            + 'key, so a name must be unique across the whole router.',
        );
    }

    found.set(name, { method: routeDef.method, path: routeDef.path, trail: where });
}

/**
 * Walk the router the way `registerRoutes` walks it.
 *
 * A nested route registers under its own key — the parent's key names the
 * grouping, not the route — so the map is flat and the trail exists only to
 * point at both sides of a collision.
 *
 * `_packageRouters` is deliberately not walked, at this or any depth: a package
 * publishes its own route map and the app merges the two
 * (`{ ...routeMap, ...authRouteMap }` in a generated `rpc.ts`). Emitting them
 * here would duplicate every package route.
 *
 * Only string keys are collected, because `Object.entries` is what the runtime
 * iterates: a symbol-keyed entry is invisible to `registerRoutes` and so has no
 * route to name in the map either.
 */
function collectRoutes(router: Router<any>, trail: string[], found: Map<string, CollectedRoute>): void
{
    for (const [name, entry] of Object.entries(router.routes))
    {
        if (isRouter(entry))
        {
            collectRoutes(entry, [...trail, name], found);
            continue;
        }

        if (!isRouteDef(entry))
        {
            throw new RouteMapGeneratorError(
                `Router entry "${[...trail, name].join('.')}" is neither a route nor a router (got ${typeof entry}). `
                + 'The server skips it, and a map that skipped it too would leave a name the client can call '
                + 'and the server never answers.',
            );
        }

        addRoute(name, entry, [...trail, name], found);
    }
}

// ============================================================================
// Generator
// ============================================================================

/**
 * A route name is a key in an object literal, and a key that is not an
 * identifier has to be quoted or the generated file will not parse.
 *
 * The source parser could never produce such a name — it read names off
 * `export const` — but `defineRouter({ 'get-user': getUser })` is a legal
 * router that the server registers as `get-user`, so the map has to be able to
 * spell it. `JSON.stringify` is the escaping: double quotes are what it emits,
 * and every other name is left bare so an unchanged project regenerates
 * byte-identically.
 */
function toObjectKey(name: string): string
{
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * A path is emitted inside a single-quoted string literal, and a path carrying a
 * quote or a backslash would close it early and leave a file that does not parse.
 * Every realistic path passes through untouched, so an unchanged project
 * regenerates byte-identically.
 */
function toStringLiteral(value: string): string
{
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

/**
 * Generate route map file content
 */
function generateRouteMapContent(routes: Map<string, CollectedRoute>): string
{
    const lines: string[] = [
        '/**',
        ' * Route Map (Auto-generated)',
        ' *',
        ' * DO NOT EDIT - This file is generated by @spfn/core:route-map generator',
        ' */',
        '',
        'import type { HttpMethod } from \'@spfn/core/route\';',
        '',
        'export interface RouteInfo',
        '{',
        '    method: HttpMethod;',
        '    path: string;',
        '}',
        '',
        'export const routeMap: Record<string, RouteInfo> = {',
    ];

    for (const [name, route] of routes)
    {
        lines.push(`    ${toObjectKey(name)}: { method: '${route.method}', path: ${toStringLiteral(route.path)} },`);
    }

    lines.push('};');
    lines.push('');
    lines.push('export type RouteMap = typeof routeMap;');
    lines.push('');
    lines.push('export type RouteName = keyof RouteMap;');
    lines.push('');

    return lines.join('\n');
}

/**
 * Create Route Map Generator
 */
export function createRouteMapGenerator(config: RouteMapGeneratorConfig): Generator
{
    const {
        routerPath,
        outputPath = './src/generated/route-map.ts',
        additionalRouteDirs = [],
    } = config;

    if (!routerPath)
    {
        throw new Error(
            '[@spfn/core:route-map] Missing required "routerPath" option.\n\n' +
            'Usage:\n' +
            '  defineGenerator<RouteMapGeneratorConfig>({\n' +
            '    name: \'@spfn/core:route-map\',\n' +
            '    routerPath: \'./src/server/router.ts\',\n' +
            '  })',
        );
    }

    return {
        name: '@spfn/core:route-map',

        // Unchanged, including the deprecated dirs: what the map is *built* from
        // moved to the loaded router, but what a rebuild should be *triggered* by
        // is still every file a route can live in.
        watchPatterns: [
            routerPath,
            'src/server/routes/**/*.ts',
            ...additionalRouteDirs.map(dir => `${dir}/**/*.ts`),
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

            if (debug)
            {
                genLogger.info('Loading router', { path: absoluteRouterPath });
            }

            const router = loadRouter(cwd, absoluteRouterPath);
            const routes = new Map<string, CollectedRoute>();
            collectRoutes(router, ['router'], routes);

            if (debug)
            {
                genLogger.info(`Found ${routes.size} routes`, { names: [...routes.keys()] });
            }

            const outputDir = dirname(absoluteOutputPath);
            if (!existsSync(outputDir))
            {
                mkdirSync(outputDir, { recursive: true });
            }

            writeFileSync(absoluteOutputPath, generateRouteMapContent(routes), 'utf-8');

            genLogger.info(`Generated route map: ${relative(cwd, absoluteOutputPath)} (${routes.size} routes)`);
        },
    };
}

// ============================================================================
// Export for package-based loading
// ============================================================================

export default createRouteMapGenerator;
